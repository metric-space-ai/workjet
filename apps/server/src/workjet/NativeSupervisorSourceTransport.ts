// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Own the native child and its bounded private Unix socket at the Node service boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const REQUEST_BYTES = 262_144;
const RESPONSE_BYTES = 1_048_576;
const OPERATION_TIMEOUT_MS = 15_000;
// Four existing-account probes can each take 20s readiness + 10s proof + 10s consumer RPC.
const STARTUP_TIMEOUT_MS = 300_000;
const MAX_QUEUED = 16;
const RequestId = Schema.String.check(Schema.isPattern(/^[!-~]{1,256}$/));
const Request = Schema.Struct({
  version: Schema.Literal(1),
  requestId: RequestId,
  params: Schema.Tuple([Schema.Record(Schema.String, Schema.Unknown)]),
});
const SourceFacts = Schema.Struct({
  version: Schema.Literal(1),
  targetId: Schema.String,
  instanceId: Schema.String,
  publicIdentity: Schema.String,
  accountEpoch: Schema.Unknown,
  peerId: Schema.String,
  generation: Schema.Unknown,
  consumer: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeConsumer = Schema.decodeUnknownPromise(Schema.Struct({ computerId: Schema.String }));
const Ready = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  endpoint: Schema.String,
  transportReady: Schema.Literal(true),
  executionReady: Schema.Literal(false),
  source: Schema.optional(SourceFacts),
});
const Response = Schema.Struct({
  version: Schema.Literal(1),
  requestId: RequestId,
  result: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("reply"), reply: Schema.Unknown }),
    Schema.Struct({
      kind: Schema.Literal("unavailable"),
      code: Schema.Literal("native_supervisor_source_unavailable"),
    }),
  ]),
});
const decodeRequest = Schema.decodeUnknownPromise(Request, { onExcessProperty: "error" });
const decodeReady = Schema.decodeUnknownPromise(Schema.fromJsonString(Ready), {
  onExcessProperty: "error",
});
const decodeResponse = Schema.decodeUnknownPromise(Schema.fromJsonString(Response), {
  onExcessProperty: "error",
});

export class NativeSupervisorSourceTransportError extends Schema.TaggedErrorClass<NativeSupervisorSourceTransportError>()(
  "NativeSupervisorSourceTransportError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "startup-failed",
      "transport-lost",
      "outcome-unknown",
      "shutdown-incomplete",
    ]),
    requestId: Schema.optional(Schema.String),
    stage: Schema.optional(Schema.Literals(["spawn", "readiness", "private-endpoint", "connect"])),
  },
) {}

/** Internal retained enrollment reference, never a client/wire input or authority.
 * Native validates the original encrypted enrollment and current Source association.
 * Missing mapping must fail setup; computer/instance labels cannot replace targetId. */
export type NativeSupervisorSourceEnrollment = {
  readonly executable: string;
  readonly originalNativeRoot: string;
  readonly ipcDirectory: string;
} & (
  | { readonly targetId: string; readonly selected?: never }
  | {
      readonly targetId?: never;
      readonly selected: { readonly instanceId: string; readonly computerId: string };
    }
);
export interface NativeSupervisorSourceTransport {
  readonly processId: number;
  readonly endpoint: string;
  /** Actual bounded child startup frame for private retainStarted validation. */
  readonly startup: typeof Ready.Type;
  readonly executionReady: false;
  /** Non-secret association snapshot; never constructs execution authority. */
  readonly source?: typeof SourceFacts.Type;
  /** Caller retains the immutable operation UUID. No automatic replay/reconnect. */
  readonly request: (requestId: string, operation: Record<string, unknown>) => Promise<unknown>;
  /** Only this owned transport process exited; never an SDK stop witness. */
  readonly close: () => Promise<{
    readonly exitCode: number | null;
    readonly signal: string | null;
  }>;
}
const failure = (reason: NativeSupervisorSourceTransportError["reason"], requestId?: string) =>
  new NativeSupervisorSourceTransportError({ reason, ...(requestId ? { requestId } : {}) });

function deadline<A>(promise: Promise<A>, ms: number, error: NativeSupervisorSourceTransportError) {
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(error), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

/** Root/NodeService owns the returned resource, independent of BrowserWindow/guest.
 * Starts only the supplied original native enrollment. No grant, pairing, SDK or
 * instance-model fallback occurs here. Native returns the actual private endpoint. */
export async function openNativeSupervisorSourceTransport(
  enrollment: NativeSupervisorSourceEnrollment,
): Promise<NativeSupervisorSourceTransport> {
  if (
    !NodePath.isAbsolute(enrollment.executable) ||
    !NodePath.isAbsolute(enrollment.originalNativeRoot) ||
    !NodePath.isAbsolute(enrollment.ipcDirectory) ||
    (enrollment.selected
      ? [enrollment.selected.instanceId, enrollment.selected.computerId].some(
          (value) =>
            !value || value.length > 256 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value),
        )
      : !enrollment.targetId || enrollment.targetId.includes("\0"))
  )
    throw failure("invalid-input");
  const child = NodeChildProcess.spawn(
    enrollment.executable,
    enrollment.selected
      ? [
          "sync",
          "supervisor-source-selected",
          enrollment.selected.instanceId,
          enrollment.selected.computerId,
          enrollment.ipcDirectory,
          "--root",
          enrollment.originalNativeRoot,
        ]
      : [
          "sync",
          "supervisor-source",
          enrollment.targetId,
          enrollment.ipcDirectory,
          "--root",
          enrollment.originalNativeRoot,
        ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.resume();
  let exited = false;
  const exit = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.once("close", (exitCode, signal) => {
      exited = true;
      resolve({ exitCode, signal });
    });
  });
  // Error listeners are attached before startup; stderr never becomes a credential-bearing error.
  const startup = new Promise<string>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const finish = (cause?: NativeSupervisorSourceTransportError, line?: string) => {
      child.stdout.off("data", data);
      child.off("error", error);
      child.off("close", closed);
      if (cause) reject(cause);
      else resolve(line!);
    };
    const data = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 16_384) return finish(failure("startup-failed"));
      const newline = buffered.indexOf(10);
      if (newline !== -1) finish(undefined, buffered.subarray(0, newline).toString("utf8"));
    };
    const error = () => finish(failure("startup-failed"));
    const closed = () => finish(failure("startup-failed"));
    child.stdout.on("data", data);
    child.once("error", error);
    child.once("close", closed);
  });
  child.on("error", () => {});
  const stopChild = async () => {
    if (!exited && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    return deadline(exit, OPERATION_TIMEOUT_MS, failure("shutdown-incomplete"));
  };
  let socket: NodeNet.Socket | undefined;
  let stage: NonNullable<NativeSupervisorSourceTransportError["stage"]> = "spawn";
  try {
    stage = "readiness";
    const line = await deadline(startup, STARTUP_TIMEOUT_MS, failure("startup-failed"));
    const ready = await decodeReady(line).catch(() => {
      throw failure("startup-failed");
    });
    child.stdout.resume();
    if (enrollment.selected) {
      if (!ready.source || ready.source.instanceId !== enrollment.selected.instanceId)
        throw failure("startup-failed");
      const consumer = await decodeConsumer(ready.source.consumer);
      if (consumer.computerId !== enrollment.selected.computerId) throw failure("startup-failed");
    } else if (ready.source && ready.source.targetId !== enrollment.targetId) {
      throw failure("startup-failed");
    }
    stage = "private-endpoint";
    const directory = await NodeFSP.realpath(enrollment.ipcDirectory);
    const dir = await NodeFSP.lstat(directory);
    const endpoint = await NodeFSP.lstat(ready.endpoint);
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !dir.isDirectory() ||
      dir.uid !== uid ||
      (dir.mode & 0o777) !== 0o700 ||
      !NodePath.isAbsolute(ready.endpoint) ||
      NodePath.dirname(ready.endpoint) !== directory ||
      !endpoint.isSocket() ||
      endpoint.uid !== uid ||
      (endpoint.mode & 0o777) !== 0o600 ||
      exited
    )
      throw failure("startup-failed");
    stage = "connect";
    const connection = NodeNet.createConnection(ready.endpoint);
    socket = connection;
    await deadline(
      new Promise<void>((resolve, reject) => {
        connection.once("connect", resolve);
        connection.once("error", () => reject(failure("startup-failed")));
      }),
      OPERATION_TIMEOUT_MS,
      failure("startup-failed"),
    );
    let closed = false;
    let active:
      | {
          requestId: string;
          resolve: (reply: unknown) => void;
          reject: (error: NativeSupervisorSourceTransportError) => void;
          timer: ReturnType<typeof setTimeout>;
          decoding: boolean;
        }
      | undefined;
    let received = Buffer.alloc(0);
    let tail: Promise<unknown> = Promise.resolve();
    let queued = 0;
    const retire = () => {
      closed = true;
      if (active) {
        clearTimeout(active.timer);
        active.reject(failure("outcome-unknown", active.requestId));
        active = undefined;
      }
      received = Buffer.alloc(0);
      connection.destroy();
    };
    connection.on("error", retire);
    connection.on("close", retire);
    child.once("close", retire);
    connection.on("data", (chunk: Buffer) => {
      const pending = active;
      if (!pending || pending.decoding) return retire();
      received = Buffer.concat([received, chunk]);
      if (received.length < 4) return;
      const length = received.readUInt32BE(0);
      if (!length || length > RESPONSE_BYTES || received.length > length + 4) return retire();
      if (received.length < length + 4) return;
      pending.decoding = true;
      let json: string;
      try {
        json = new TextDecoder("utf-8", { fatal: true }).decode(received.subarray(4));
      } catch {
        return retire();
      }
      received = Buffer.alloc(0);
      void decodeResponse(json).then((response) => {
        if (active !== pending || closed) return;
        if (response.requestId !== pending.requestId || response.result.kind !== "reply")
          return retire();
        clearTimeout(pending.timer);
        active = undefined;
        pending.resolve(response.result.reply);
      }, retire);
    });
    let closing: ReturnType<NativeSupervisorSourceTransport["close"]> | undefined;
    return {
      processId: child.pid!,
      endpoint: ready.endpoint,
      startup: ready,
      executionReady: false,
      ...(ready.source ? { source: ready.source } : {}),
      request(requestId, operation) {
        if (closed || queued >= MAX_QUEUED)
          return Promise.reject(failure("transport-lost", requestId));
        queued++;
        const response = tail.then(async () => {
          if (closed) throw failure("transport-lost", requestId);
          const input = await decodeRequest({ version: 1, requestId, params: [operation] }).catch(
            () => {
              throw failure("invalid-input", requestId);
            },
          );
          let bytes: Buffer;
          try {
            bytes = Buffer.from(JSON.stringify(input));
          } catch {
            throw failure("invalid-input", requestId);
          }
          if (bytes.length > REQUEST_BYTES) throw failure("invalid-input", requestId);
          // Awaited validation must not let local retirement race a subsequent write.
          if (closed || exited) throw failure("transport-lost", requestId);
          const frame = Buffer.allocUnsafe(bytes.length + 4);
          frame.writeUInt32BE(bytes.length, 0);
          bytes.copy(frame, 4);
          return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(retire, OPERATION_TIMEOUT_MS);
            timer.unref();
            active = { requestId, resolve, reject, timer, decoding: false };
            // From the attempted write onward EOF/unavailable is an ambiguous outcome.
            connection.write(frame, (error) => {
              if (error) retire();
            });
          });
        });
        tail = response.catch(() => undefined);
        return response.finally(() => {
          queued--;
        });
      },
      close() {
        if (!closing) {
          retire();
          closing = stopChild();
        }
        return closing;
      },
    };
  } catch {
    socket?.destroy();
    await stopChild();
    throw new NativeSupervisorSourceTransportError({ reason: "startup-failed", stage });
  }
}

/** Acquire in the managed service scope, never the UI connection scope. */
export const acquireNativeSupervisorSourceTransport = Effect.fn(
  "NativeSupervisorSourceTransport.acquire",
)(function* (enrollment: NativeSupervisorSourceEnrollment) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNativeSupervisorSourceTransport(enrollment),
      catch: (cause) =>
        Schema.is(NativeSupervisorSourceTransportError)(cause) ? cause : failure("startup-failed"),
    }),
    (transport) =>
      Effect.tryPromise({
        try: () => transport.close(),
        catch: () => failure("shutdown-incomplete"),
      }).pipe(Effect.orDie),
  );
});
