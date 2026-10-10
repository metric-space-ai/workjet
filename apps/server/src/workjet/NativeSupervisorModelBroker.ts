// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Own the bounded SDK-only loopback HTTP resource in the Node service scope.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { NativeSupervisorSourceTransport } from "./NativeSupervisorSourceTransport.ts";

const BODY_BYTES = 98_304;
const FRAME_BYTES = 32_768;
const REPLY_BYTES = 8_388_608;
const MAX_OPERATIONS = 64;
const DEADLINE_MS = 300_000;
const UUID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
const SessionId = Schema.String.check(Schema.isPattern(/^[!-~]{1,256}$/));
const Sequence = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 }));
const Common = { version: Schema.Literal(1), execution_ready: Schema.Literal(false) };
const Pending = Schema.Struct({
  ...Common,
  state: Schema.Literal("model_pending"),
  operation_id: UUID,
});
const ReadReply = Schema.Union([
  Schema.Struct({
    ...Common,
    state: Schema.Literal("model_pending"),
    sequence: Sequence,
    done: Schema.Literal(false),
  }),
  Schema.Struct({
    ...Common,
    state: Schema.Literal("model_done"),
    sequence: Sequence,
    done: Schema.Literal(true),
  }),
  Schema.Struct({
    ...Common,
    state: Schema.Literal("model_failed"),
    sequence: Sequence,
    done: Schema.Literal(true),
  }),
  Schema.Struct({
    ...Common,
    state: Schema.Literal("model_chunk"),
    sequence: Sequence,
    http_status: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 599 })),
    streaming: Schema.Boolean,
    body_base64: Schema.String,
    done: Schema.Literal(false),
  }),
]);
const Binding = Schema.Struct({ offerId: UUID, controllerId: UUID });
const decodeBinding = Schema.decodeUnknownPromise(Binding, { onExcessProperty: "error" });
const decodePending = Schema.decodeUnknownPromise(Pending, { onExcessProperty: "error" });
const decodeRead = Schema.decodeUnknownPromise(ReadReply, { onExcessProperty: "error" });
const decodeBody = Schema.decodeUnknownPromise(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeSession = Schema.decodeUnknownPromise(SessionId);

export class NativeSupervisorModelBrokerError extends Schema.TaggedErrorClass<NativeSupervisorModelBrokerError>()(
  "NativeSupervisorModelBrokerError",
  {
    reason: Schema.Literals([
      "invalid-binding",
      "native-unavailable",
      "native-protocol",
      "sdk-session-unavailable",
      "client-disconnected",
      "closed",
      "deadline",
    ]),
    operationId: Schema.optional(Schema.String),
  },
) {}
const isBrokerError = Schema.is(NativeSupervisorModelBrokerError);
const failure = (reason: NativeSupervisorModelBrokerError["reason"], operationId?: string) =>
  new NativeSupervisorModelBrokerError({ reason, ...(operationId ? { operationId } : {}) });

/** Private service inputs, never renderer/RPC authority. The session getter must
 * be connected to the real SDK init observer; it is correlation only. Native
 * owns the original controller, account, model selection and publication guard. */
export interface NativeSupervisorModelBrokerOptions {
  readonly offerId: string;
  readonly controllerId: string;
  readonly transport: Pick<NativeSupervisorSourceTransport, "request">;
  readonly currentSdkSessionId: () => string | undefined;
}
export interface NativeSupervisorModelBroker {
  readonly baseUrl: string;
  /** Random SDK-only loopback credential. Never an upstream account credential;
   * keep in memory and the owned SDK environment, never a projection/journal. */
  readonly authToken: string;
  readonly failure: Promise<NativeSupervisorModelBrokerError>;
  readonly close: () => Promise<{
    readonly localRequestsDrained: true;
    readonly outcomeUnknownOperationIds: ReadonlyArray<string>;
    readonly executionReady: false;
  }>;
}

function respond(response: NodeHttp.ServerResponse, status: number, message: string) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
}
function tokenMatches(value: string | undefined, token: string) {
  if (!value) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(token);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
}
async function pause(signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, 100);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
async function untilAborted<A>(pending: Promise<A>, signal: AbortSignal): Promise<A> {
  signal.throwIfAborted();
  return new Promise<A>((resolve, reject) => {
    const done = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      done();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        done();
        resolve(value);
      },
      (cause) => {
        done();
        reject(cause);
      },
    );
  });
}
async function waitDrain(response: NodeHttp.ServerResponse, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const clear = () => {
      response.off("drain", drained);
      response.off("close", stopped);
      response.off("error", stopped);
      signal.removeEventListener("abort", stopped);
    };
    const drained = () => {
      clear();
      resolve();
    };
    const stopped = () => {
      clear();
      reject(failure("client-disconnected"));
    };
    response.once("drain", drained);
    response.once("close", stopped);
    response.once("error", stopped);
    signal.addEventListener("abort", stopped, { once: true });
  });
}
async function readBody(request: NodeHttp.IncomingMessage) {
  let size = 0;
  const chunks: Array<Buffer> = [];
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  await decodeBody(body);
  return body;
}

/** LLM API only. No Business OS HTTP bridge, fallback, grant or SDK authority.
 * Each HTTP request invokes once; reads retain the same original operation and
 * advance only after an actual chunk is forwarded. Any ambiguous dispatch
 * retires the broker; the caller must stop/join its genuine SDK separately. */
export async function openNativeSupervisorModelBroker(
  options: NativeSupervisorModelBrokerOptions,
): Promise<NativeSupervisorModelBroker> {
  let binding: typeof Binding.Type;
  try {
    binding = await decodeBinding({ offerId: options.offerId, controllerId: options.controllerId });
  } catch {
    throw failure("invalid-binding");
  }
  const token = NodeCrypto.randomBytes(32).toString("hex");
  let fatal: NativeSupervisorModelBrokerError | undefined;
  let resolveFailure!: (error: NativeSupervisorModelBrokerError) => void;
  const failed = new Promise<NativeSupervisorModelBrokerError>((resolve) => {
    resolveFailure = resolve;
  });
  let closing = false;
  let operations = 0;
  const unknown = new Set<string>();
  const controllers = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  const retire = (error: NativeSupervisorModelBrokerError) => {
    if (!fatal) {
      fatal = error;
      resolveFailure(error);
    }
    for (const controller of controllers) controller.abort(error);
  };
  const processRequest = async (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) => {
    if (
      !tokenMatches(request.headers["x-api-key"] as string | undefined, token) &&
      !tokenMatches(request.headers.authorization?.replace(/^Bearer /, ""), token)
    ) {
      request.resume();
      return respond(response, 401, "Private SDK credential required.");
    }
    if (closing || fatal) {
      request.resume();
      return respond(response, 503, "Original native model connection is unavailable.");
    }
    if (request.method !== "POST") {
      request.resume();
      return respond(response, 405, "Only SDK model POST operations are supported.");
    }
    const path = request.url?.split("?")[0];
    const modelOperation =
      path === "/v1/messages"
        ? "messages"
        : path === "/v1/messages/count_tokens"
          ? "count_tokens"
          : undefined;
    if (!modelOperation) {
      request.resume();
      return respond(response, 404, "Unsupported SDK model operation.");
    }
    if (controllers.size >= 2 || operations >= MAX_OPERATIONS) {
      request.resume();
      return respond(response, 429, "Original model operation budget reached.");
    }
    if (Number(request.headers["content-length"]) > BODY_BYTES) {
      request.resume();
      return respond(response, 413, "SDK request exceeds the native model envelope.");
    }
    const controller = new AbortController();
    controllers.add(controller);
    const disconnected = () => {
      if (!response.writableFinished) controller.abort(failure("client-disconnected"));
    };
    response.once("close", disconnected);
    const timer = setTimeout(() => controller.abort(failure("deadline")), DEADLINE_MS);
    timer.unref();
    let operationId: string | undefined;
    let dispatched = false;
    try {
      const body = await untilAborted(readBody(request), controller.signal);
      if (body === undefined) {
        request.resume();
        return respond(response, 413, "SDK request exceeds the native model envelope.");
      }
      const session = await decodeSession(options.currentSdkSessionId());
      controller.signal.throwIfAborted();
      if (options.currentSdkSessionId() !== session)
        return respond(response, 400, "Observed SDK session changed before dispatch.");
      if (operations >= MAX_OPERATIONS)
        return respond(response, 429, "Original model operation budget reached.");
      operationId = NodeCrypto.randomUUID();
      const retained = {
        version: 1,
        offer_id: binding.offerId,
        controller_id: binding.controllerId,
        operation_id: operationId,
      };
      operations++;
      dispatched = true;
      unknown.add(operationId);
      const invoke = await decodePending(
        await untilAborted(
          options.transport.request("model-invoke:" + operationId, {
            ...retained,
            action: "model_invoke",
            model_operation: modelOperation,
            body_json: body,
            sdk_session_id: session,
          }),
          controller.signal,
        ),
      );
      if (invoke.operation_id !== operationId) throw failure("native-protocol", operationId);
      let sequence = 0;
      let reads = 0;
      let total = 0;
      let status: number | undefined;
      let streaming: boolean | undefined;
      for (;;) {
        controller.signal.throwIfAborted();
        if (options.currentSdkSessionId() !== session)
          throw failure("sdk-session-unavailable", operationId);
        const frame = await decodeRead(
          await untilAborted(
            options.transport.request(
              "model-read:" + operationId + ":" + sequence + ":" + reads++,
              { ...retained, action: "model_read", sequence },
            ),
            controller.signal,
          ),
        );
        controller.signal.throwIfAborted();
        if (options.currentSdkSessionId() !== session || frame.sequence !== sequence)
          throw failure("native-protocol", operationId);
        if (frame.state === "model_pending") {
          await pause(controller.signal);
          continue;
        }
        if (frame.state === "model_done" || frame.state === "model_failed") {
          unknown.delete(operationId);
          if (status === undefined)
            return respond(response, 502, "Native model operation produced no response.");
          if (frame.state === "model_failed" && status >= 200 && status < 300) {
            retire(failure("native-unavailable", operationId));
            response.destroy();
            return;
          }
          response.end();
          return;
        }
        const bytes = Buffer.from(frame.body_base64, "base64");
        total += bytes.length;
        if (
          !bytes.length ||
          bytes.length > FRAME_BYTES ||
          total > REPLY_BYTES ||
          bytes.toString("base64") !== frame.body_base64 ||
          (status !== undefined && status !== frame.http_status) ||
          (streaming !== undefined && streaming !== frame.streaming)
        )
          throw failure("native-protocol", operationId);
        if (status === undefined) {
          status = frame.http_status;
          streaming = frame.streaming;
          response.writeHead(status, {
            "content-type": streaming ? "text/event-stream" : "application/json",
            "cache-control": "no-store",
          });
          response.flushHeaders();
        }
        if (!response.write(bytes)) await waitDrain(response, controller.signal);
        // No sequence is advanced while the same retained frame is pending.
        sequence++;
      }
    } catch (cause) {
      if (dispatched) {
        const error = isBrokerError(cause) ? cause : failure("native-unavailable", operationId);
        retire(error);
        respond(response, 502, "Original native model operation could not be completed.");
      } else {
        respond(response, 400, "Valid SDK JSON and an observed SDK session are required.");
      }
    } finally {
      clearTimeout(timer);
      response.off("close", disconnected);
      controllers.delete(controller);
    }
  };
  const server = NodeHttp.createServer({ maxHeaderSize: 8_192 }, (request, response) => {
    const task = processRequest(request, response).catch(() => {
      response.destroy();
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  server.maxHeadersCount = 32;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.timeout = DEADLINE_MS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => retire(failure("native-unavailable")));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw failure("invalid-binding");
  }
  let close: ReturnType<NativeSupervisorModelBroker["close"]> | undefined;
  return {
    baseUrl: "http://127.0.0.1:" + address.port,
    authToken: token,
    failure: failed,
    close: () =>
      (close ??= (async () => {
        closing = true;
        for (const controller of controllers) controller.abort(failure("closed"));
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        await stopped;
        await Promise.all([...tasks]);
        return {
          localRequestsDrained: true,
          outcomeUnknownOperationIds: [...unknown],
          executionReady: false,
        };
      })()),
  };
}

export const acquireNativeSupervisorModelBroker = (options: NativeSupervisorModelBrokerOptions) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNativeSupervisorModelBroker(options),
      catch: () => failure("invalid-binding"),
    }),
    (broker) => Effect.promise(() => broker.close()).pipe(Effect.orDie),
  );
