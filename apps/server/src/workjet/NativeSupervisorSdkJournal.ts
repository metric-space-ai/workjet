// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off -- Capture actual owned SDK child handles, never PID claims from a DTO.
import type * as NodeChildProcess from "node:child_process";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isPattern(/^[!-~]{1,256}$/));
const MAX_OBSERVATIONS = 512;
const Header = {
  version: Schema.Literal(1),
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_OBSERVATIONS - 1 })),
};
export const NativeSupervisorSdkObservation = Schema.Union([
  Schema.Struct({ ...Header, kind: Schema.Literal("child-spawned"), pid: Schema.Int }),
  Schema.Struct({
    ...Header,
    kind: Schema.Literal("child-closed"),
    pid: Schema.Int,
    exitCode: Schema.NullOr(Schema.Int),
    signal: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ ...Header, kind: Schema.Literal("sdk-init"), sessionId: Id, initId: Id }),
  Schema.Struct({ ...Header, kind: Schema.Literal("turn-submitted"), turnId: Id }),
  Schema.Struct({
    ...Header,
    kind: Schema.Literal("parent-assistant"),
    sessionId: Id,
    turnId: Id,
    messageId: Id,
    messageModel: Id,
    assistantId: Id,
  }),
  Schema.Struct({
    ...Header,
    kind: Schema.Literal("sdk-result"),
    sessionId: Id,
    turnId: Id,
    resultId: Id,
    subtype: Id,
    isError: Schema.Boolean,
  }),
  Schema.Struct({ ...Header, kind: Schema.Literal("sdk-stream-joined") }),
  Schema.Struct({ ...Header, kind: Schema.Literal("sdk-query-close-returned") }),
]);
export type NativeSupervisorSdkObservation = typeof NativeSupervisorSdkObservation.Type;
const decode = Schema.decodeUnknownPromise(NativeSupervisorSdkObservation, {
  onExcessProperty: "error",
});

/** One private actual-query observer. The service's serialized durable sink
 * binds records to its original Source/controller; these observations never
 * reconstruct authority or approve completion. No user/RPC event entry point. */
export class NativeSupervisorSdkJournal {
  private sequence = 0;
  private tail: Promise<void> = Promise.resolve();
  private fault: Error | undefined;
  private resolveFailure!: (error: Error) => void;
  readonly failure = new Promise<Error>((resolve) => {
    this.resolveFailure = resolve;
  });
  private readonly children = new Map<
    number,
    { child: NodeChildProcess.ChildProcess; closed: boolean }
  >();
  private readonly changes = new Set<() => void>();
  private sessionId: string | undefined;
  private submittedTurnId: string | undefined;
  private streamJoined = false;
  private queryCloseReturned = false;
  private resultSeen = false;
  private readonly sink: (observation: NativeSupervisorSdkObservation) => Promise<void>;
  constructor(sink: (observation: NativeSupervisorSdkObservation) => Promise<void>) {
    this.sink = sink;
  }

  private fail(cause: unknown): Error {
    if (!this.fault) {
      this.fault = cause instanceof Error ? cause : new Error("Original SDK observation failed.");
      this.resolveFailure(this.fault);
      this.notify();
    }
    return this.fault;
  }

  private append(record: Record<string, unknown>): Promise<void> {
    if (this.fault || this.sequence >= MAX_OBSERVATIONS) {
      const failed = Promise.reject(
        this.fail(new Error("Original SDK observation limit reached.")),
      );
      void failed.catch(() => {});
      return failed;
    }
    const input = { version: 1, sequence: this.sequence++, ...record };
    this.tail = this.tail.then(async () => {
      if (this.fault) throw this.fault;
      const event = await decode(input);
      await this.sink(Object.freeze(event));
    });
    // Preserve rejection for the caller/drain while handling fire-and-forget child callbacks.
    void this.tail.catch((cause) => {
      this.fail(cause);
    });
    return this.tail;
  }
  private notify() {
    for (const changed of this.changes) changed();
  }
  currentSdkSessionId(): string | undefined {
    return this.fault ? undefined : this.sessionId;
  }

  /** Only the adapter's actual spawn callback supplies this process object.
   * A captured PID alone, empty process list or terminated DTO cannot call it. */
  captureOwnedSdkChild(child: NodeChildProcess.ChildProcess): void {
    if (!child.pid || !Number.isInteger(child.pid) || this.children.has(child.pid) ||
      this.children.size >= 8 || this.sessionId || this.resultSeen || this.streamJoined || this.fault)
      throw this.fail(new Error("Original SDK child unavailable or already captured."));
    const pid = child.pid;
    const state = { child, closed: false };
    this.children.set(pid, state);
    void this.append({ kind: "child-spawned", pid });
    child.once("close", (exitCode, signal) => {
      state.closed = true;
      void this.append({ kind: "child-closed", pid, exitCode, signal }).then(
        () => this.notify(),
        () => this.notify(),
      );
    });
  }
  async turnSubmitted(turnId: string): Promise<void> {
    if (this.fault) throw this.fault;
    if (this.submittedTurnId === turnId) return; // Steering remains the same original turn.
    if (this.submittedTurnId) throw this.fail(new Error("Original SDK turn changed."));
    this.submittedTurnId = turnId;
    await this.append({ kind: "turn-submitted", turnId });
  }
  async observeSdkMessage(message: SDKMessage, currentTurnId: string | undefined): Promise<void> {
    if (message.type === "system" && message.subtype === "init") {
      if (this.sessionId || this.resultSeen || this.streamJoined ||
        ![...this.children.values()].some(child => !child.closed))
        throw this.fail(new Error("Original SDK init/session changed."));
      this.sessionId = message.session_id;
      await this.append({ kind: "sdk-init", sessionId: message.session_id, initId: message.uuid });
      return;
    }
    if (!currentTurnId || currentTurnId !== this.submittedTurnId) return;
    if (message.type !== "assistant" && message.type !== "result") return;
    if (message.type === "assistant" && message.parent_tool_use_id !== null) return;
    if (this.resultSeen || this.streamJoined) throw this.fail(new Error("Original SDK result/stream already ended."));
    if (!this.sessionId || message.session_id !== this.sessionId || this.children.size === 0)
      throw this.fail(new Error("Original SDK session unavailable."));
    if (message.type === "assistant") {
      await this.append({
        kind: "parent-assistant",
        sessionId: message.session_id,
        turnId: currentTurnId,
        messageId: message.message.id,
        messageModel: message.message.model,
        assistantId: message.uuid,
      });
    } else {
      this.resultSeen = true;
      await this.append({
        kind: "sdk-result",
        sessionId: message.session_id,
        turnId: currentTurnId,
        resultId: message.uuid,
        subtype: message.subtype,
        isError: message.is_error,
      });
    }
  }
  async sdkStreamJoined(): Promise<void> {
    if (this.streamJoined) throw this.fail(new Error("Original SDK stream already joined."));
    this.streamJoined = true;
    await this.append({ kind: "sdk-stream-joined" });
    this.notify();
  }
  async sdkQueryCloseReturned(): Promise<void> {
    if (this.queryCloseReturned) throw this.fail(new Error("Original SDK query already closed."));
    this.queryCloseReturned = true;
    await this.append({ kind: "sdk-query-close-returned" });
    this.notify();
  }
  /** Physical child close and completed SDK consumer/query callbacks are
   * separate observations; native still joins real message/model/result rows. */
  async drain(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const ready = () =>
      this.children.size > 0 &&
      this.streamJoined &&
      this.queryCloseReturned &&
      [...this.children.values()].every((value) => value.closed);
    if (!ready() && !this.fault)
      await new Promise<void>((resolve) => {
        const changed = () => {
          if (ready() || this.fault || signal.aborted) {
            this.changes.delete(changed);
            signal.removeEventListener("abort", changed);
            resolve();
          }
        };
        signal.addEventListener("abort", changed, { once: true });
        this.changes.add(changed);
        changed();
      });
    signal.throwIfAborted();
    if (this.fault) throw this.fault;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.tail.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (cause) => {
          signal.removeEventListener("abort", abort);
          reject(cause);
        },
      );
    });
  }
}
