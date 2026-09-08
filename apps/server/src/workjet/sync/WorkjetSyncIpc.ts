import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import {
  CTOX_SYNC_IPC_PROTOCOL_VERSION,
  CTOX_SYNC_IPC_MAX_FRAME_BYTES,
  CTOX_SYNC_IPC_DEADLINE_MILLIS,
  SyncIpcRequestSchema,
  SyncIpcResponseSchema,
  type SyncIpcRequest,
  type SyncIpcResponse,
} from "@workjet/contracts/ctoxSync";
import * as Schema from "effect/Schema";

export class SyncIpcError extends Schema.TaggedErrorClass<SyncIpcError>()("SyncIpcError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

const decodeRequest = Schema.decodeUnknownSync(SyncIpcRequestSchema, { onExcessProperty: "error" });
const decodeResponse = Schema.decodeUnknownSync(SyncIpcResponseSchema, {
  onExcessProperty: "error",
});

/** The native host supplies LocalTransport's Unix socket or named-pipe endpoint. */
export function requestSyncAuthority(
  endpoint: string,
  input: SyncIpcRequest,
  signal?: AbortSignal,
): Promise<SyncIpcResponse> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: (deadlineSignal) =>
        exchangeSyncAuthority(
          endpoint,
          input,
          signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal,
        ),
      catch: (cause) =>
        new SyncIpcError({
          message: cause instanceof Error ? cause.message : "CTOX Sync IPC failed",
          cause,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: CTOX_SYNC_IPC_DEADLINE_MILLIS,
        orElse: () =>
          Effect.fail(
            new SyncIpcError({ message: "CTOX Sync authority did not answer before its deadline" }),
          ),
      }),
    ),
  );
}

function exchangeSyncAuthority(
  endpoint: string,
  input: SyncIpcRequest,
  signal: AbortSignal,
): Promise<SyncIpcResponse> {
  if (!endpoint.startsWith("/") && !endpoint.startsWith("\\\\.\\pipe\\")) {
    return Promise.reject(
      new Error("CTOX Sync requires a local Unix socket or Windows named pipe"),
    );
  }
  if (signal?.aborted) return Promise.reject(new Error("CTOX Sync request aborted"));
  let payload: Buffer;
  try {
    const request = decodeRequest(input);
    if (
      request.version !== CTOX_SYNC_IPC_PROTOCOL_VERSION ||
      !request.requestId ||
      request.requestId.length > 256
    ) {
      throw new Error("Invalid CTOX Sync request version or ID");
    }
    payload = Buffer.from(JSON.stringify(request));
    if (payload.byteLength > CTOX_SYNC_IPC_MAX_FRAME_BYTES)
      throw new Error("CTOX Sync request exceeds its frame budget");
  } catch (cause) {
    return Promise.reject(cause);
  }
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(endpoint);
    let finished = false;
    let received = Buffer.alloc(0);
    const finish = (error?: Error, result?: SyncIpcResponse) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const abort = () => finish(new Error("CTOX Sync request aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    // Also cover cancellation between the initial check and listener registration.
    if (signal?.aborted) abort();
    socket.once("connect", () => {
      if (finished) return;
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.byteLength);
      socket.write(Buffer.concat([header, payload]));
    });
    socket.on("data", (chunk: Buffer) => {
      if (finished) return;
      if (received.byteLength + chunk.byteLength > CTOX_SYNC_IPC_MAX_FRAME_BYTES + 4) {
        finish(new Error("CTOX Sync response exceeds its frame budget"));
        return;
      }
      received = Buffer.concat([received, chunk]);
      if (received.byteLength < 4) return;
      const size = received.readUInt32BE(0);
      if (size === 0 || size > CTOX_SYNC_IPC_MAX_FRAME_BYTES || received.byteLength > size + 4) {
        finish(new Error("Invalid CTOX Sync response framing"));
        return;
      }
      if (received.byteLength !== size + 4) return;
      try {
        const response = decodeResponse(JSON.parse(received.subarray(4).toString("utf8")));
        if (
          response.version !== CTOX_SYNC_IPC_PROTOCOL_VERSION ||
          response.requestId !== input.requestId
        ) {
          throw new Error("CTOX Sync response does not match this request or protocol");
        }
        finish(undefined, response);
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error("Invalid CTOX Sync response"));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () =>
      finish(new Error("CTOX Sync disconnected before confirming the request")),
    );
  });
}
