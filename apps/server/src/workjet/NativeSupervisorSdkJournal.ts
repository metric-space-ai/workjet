// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off -- Capture actual owned SDK child handles, never PID claims from a DTO.
import type * as NodeChildProcess from "node:child_process";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isPattern(/^[!-~]{1,256}$/));
const Header = { version: Schema.Literal(1), sequence: Schema.Int };
export const NativeSupervisorSdkObservation = Schema.Union([
  Schema.Struct({ ...Header, kind: Schema.Literal("child-spawned"), pid: Schema.Int }),
  Schema.Struct({ ...Header, kind: Schema.Literal("child-closed"), pid: Schema.Int,
    exitCode: Schema.NullOr(Schema.Int), signal: Schema.NullOr(Schema.String) }),
  Schema.Struct({ ...Header, kind: Schema.Literal("sdk-init"), sessionId: Id, initId: Id }),
  Schema.Struct({ ...Header, kind: Schema.Literal("turn-submitted"), turnId: Id }),
  Schema.Struct({ ...Header, kind: Schema.Literal("parent-assistant"), sessionId: Id,
    turnId: Id, messageId: Id, messageModel: Id, assistantId: Id }),
  Schema.Struct({ ...Header, kind: Schema.Literal("sdk-result"), sessionId: Id,
    turnId: Id, resultId: Id, subtype: Id, isError: Schema.Boolean }),
  Schema.Struct({ ...Header, kind: Schema.Literal("sdk-stream-joined") }),
  Schema.Struct({ ...Header, kind: Schema.Literal("sdk-query-close-returned") }),
]);
export type NativeSupervisorSdkObservation = typeof NativeSupervisorSdkObservation.Type;
const decode = Schema.decodeUnknownPromise(NativeSupervisorSdkObservation, { onExcessProperty: "error" });

/** One private actual-query observer. The service's serialized durable sink
 * binds records to its original Source/controller; these observations never
 * reconstruct authority or approve completion. No user/RPC event entry point. */
export class NativeSupervisorSdkJournal {
  private sequence = 0;
  private tail: Promise<void> = Promise.resolve();
  private faulted = false;
  private readonly children = new Map<number, { child: NodeChildProcess.ChildProcess; closed: boolean }>();
  private readonly changes = new Set<() => void>();
  private sessionId: string | undefined;
  private submittedTurnId: string | undefined;
  private streamJoined = false;
  private queryCloseReturned = false;
  constructor(private readonly sink: (observation: NativeSupervisorSdkObservation) => Promise<void>) {}

  private append(record: Record<string, unknown>): Promise<void> {
    const input = { version: 1, sequence: this.sequence++, ...record };
    this.tail = this.tail.then(async () => {
      const event = await decode(input);
      await this.sink(Object.freeze(event));
    });
    // Preserve rejection for the caller/drain while handling fire-and-forget child callbacks.
    void this.tail.catch(() => { this.faulted = true; this.notify(); });
    return this.tail;
  }
  private notify() { for (const changed of this.changes) changed(); }
  currentSdkSessionId(): string | undefined { return this.faulted ? undefined : this.sessionId; }

  /** Only the adapter's actual spawn callback supplies this process object.
   * A captured PID alone, empty process list or terminated DTO cannot call it. */
  captureOwnedSdkChild(child: NodeChildProcess.ChildProcess): void {
    if (!child.pid || !Number.isInteger(child.pid) || this.children.has(child.pid))
      throw new Error("Original SDK child unavailable or already captured.");
    const pid = child.pid;
    const state = { child, closed: false };
    this.children.set(pid, state);
    void this.append({ kind: "child-spawned", pid });
    child.once("close", (exitCode, signal) => {
      state.closed = true;
      void this.append({ kind: "child-closed", pid, exitCode, signal }).then(
        () => this.notify(), () => this.notify(),
      );
    });
  }
  async turnSubmitted(turnId: string): Promise<void> {
    this.submittedTurnId = turnId;
    await this.append({ kind: "turn-submitted", turnId });
  }
  async observeSdkMessage(message: SDKMessage, currentTurnId: string | undefined): Promise<void> {
    if (message.type === "system" && message.subtype === "init") {
      if (this.children.size === 0 || (this.sessionId && this.sessionId !== message.session_id))
        throw new Error("Original SDK init/session changed.");
      this.sessionId = message.session_id;
      await this.append({ kind: "sdk-init", sessionId: message.session_id, initId: message.uuid });
      return;
    }
    if (!currentTurnId || currentTurnId !== this.submittedTurnId) return;
    if (message.type !== "assistant" && message.type !== "result") return;
    if (!this.sessionId || message.session_id !== this.sessionId || this.children.size === 0)
      throw new Error("Original SDK session unavailable.");
    if (message.type === "assistant") {
      if (message.parent_tool_use_id !== null) return;
      await this.append({ kind: "parent-assistant", sessionId: message.session_id,
        turnId: currentTurnId, messageId: message.message.id,
        messageModel: message.message.model, assistantId: message.uuid });
    } else {
      await this.append({ kind: "sdk-result", sessionId: message.session_id,
        turnId: currentTurnId, resultId: message.uuid, subtype: message.subtype,
        isError: message.is_error });
    }
  }
  async sdkStreamJoined(): Promise<void> {
    this.streamJoined = true;
    await this.append({ kind: "sdk-stream-joined" });
    this.notify();
  }
  async sdkQueryCloseReturned(): Promise<void> {
    this.queryCloseReturned = true;
    await this.append({ kind: "sdk-query-close-returned" });
    this.notify();
  }
  /** Physical child close and completed SDK consumer/query callbacks are
   * separate observations; native still joins real message/model/result rows. */
  async drain(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const ready = () => this.children.size > 0 && this.streamJoined && this.queryCloseReturned &&
      [...this.children.values()].every(value => value.closed);
    if (!ready() && !this.faulted) await new Promise<void>(resolve => {
      const changed = () => {
        if (ready() || this.faulted || signal.aborted) {
          this.changes.delete(changed); signal.removeEventListener("abort", changed); resolve();
        }
      };
      signal.addEventListener("abort", changed, { once: true });
      this.changes.add(changed);
      changed();
    });
    signal.throwIfAborted();
    await this.tail;
  }
}
