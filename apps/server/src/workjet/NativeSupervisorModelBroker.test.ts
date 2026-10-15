// @effect-diagnostics nodeBuiltinImport:off -- Isolated loopback/native-protocol fixtures, never real SDK/model/authority evidence.
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import type * as NodeStreamWeb from "node:stream/web";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import {
  acquireNativeSupervisorModelBroker,
  NativeSupervisorModelBrokerError,
} from "./NativeSupervisorModelBroker.ts";

const offerId = "11111111-1111-4111-8111-111111111111";
const controllerId = "22222222-2222-4222-8222-222222222222";
const Operation = Schema.Struct({
  version: Schema.Literal(1),
  action: Schema.Literals(["model_invoke", "model_read"]),
  offer_id: Schema.String,
  controller_id: Schema.String,
  operation_id: Schema.String,
  model_operation: Schema.optional(Schema.String),
  body_json: Schema.optional(Schema.String),
  sdk_session_id: Schema.optional(Schema.String),
  sequence: Schema.optional(Schema.Number),
});
const decodeOperation = Schema.decodeUnknownPromise(Operation);
type Operation = typeof Operation.Type;
const pending = (operation: Operation) => ({
  version: 1,
  state: "model_pending",
  execution_ready: false,
  ...(operation.action === "model_invoke"
    ? { operation_id: operation.operation_id }
    : { sequence: operation.sequence, done: false }),
});
const done = (operation: Operation, failed = false) => ({
  version: 1,
  state: failed ? "model_failed" : "model_done",
  sequence: operation.sequence,
  done: true,
  execution_ready: false,
});
const chunk = (
  operation: Operation,
  bytes: string | Buffer,
  streaming = true,
  httpStatus = 200,
) => ({
  version: 1,
  state: "model_chunk",
  sequence: operation.sequence,
  http_status: httpStatus,
  streaming,
  body_base64: Buffer.from(bytes).toString("base64"),
  done: false,
  execution_ready: false,
});
const fixture = Effect.fn("NativeSupervisorModelBroker.fixture")(function* (
  reply: (operation: Operation) => unknown | Promise<unknown>,
) {
  const calls: Array<{ requestId: string; operation: Operation }> = [];
  let session: string | undefined = "fixture-sdk-session";
  const broker = yield* acquireNativeSupervisorModelBroker({
    offerId,
    controllerId,
    currentSdkSessionId: () => session,
    transport: {
      request: async (requestId, input) => {
        const operation = await decodeOperation(input);
        calls.push({ requestId, operation });
        return reply(operation);
      },
    },
  });
  return {
    broker,
    calls,
    setSession: (value: string | undefined) => {
      session = value;
    },
  };
});
// This owned Node client exercises exact byte-stream/disconnect semantics of the
// SDK-only loopback fixture; it never calls a tenant or provider HTTP endpoint.
function rawRequest(
  url: string,
  options: { method: string; headers?: Record<string, string>; body: string },
) {
  return new Promise<{
    status: number;
    headers: { get: (name: string) => string | null };
    body: {
      getReader: () => NodeStreamWeb.ReadableStreamDefaultReader<Uint8Array>;
    };
    text: () => Promise<string>;
  }>((resolve, reject) => {
    const request = NodeHttp.request(
      url,
      {
        method: options.method,
        headers: { "content-length": Buffer.byteLength(options.body), ...options.headers },
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: {
            get: (name) => {
              const value = response.headers[name];
              return typeof value === "string" ? value : (value?.join(", ") ?? null);
            },
          },
          body: { getReader: () => NodeStream.Readable.toWeb(response).getReader() },
          text: async () => {
            const chunks: Array<Buffer> = [];
            for await (const chunk of response)
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return Buffer.concat(chunks).toString("utf8");
          },
        });
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}
const post = (
  broker: { baseUrl: string; authToken: string },
  body = '{"messages":[]}',
  path = "/v1/messages",
) =>
  rawRequest(broker.baseUrl + path, {
    method: "POST",
    headers: { "x-api-key": broker.authToken, "content-type": "application/json" },
    body,
  });

it.effect(
  "streams original bytes before native completion; preserves retained IDs and exact sequence",
  () =>
    Effect.gen(function* () {
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { broker, calls } = yield* fixture((operation) => {
        if (operation.action === "model_invoke") return pending(operation);
        if (operation.sequence === 0) return chunk(operation, "data: fixture-first\n\n");
        if (operation.sequence === 1)
          return next.then(() => chunk(operation, "data: fixture-last\n\n"));
        return done(operation);
      });
      const response = yield* Effect.promise(() => post(broker, '{"stream":true,"messages":[]}'));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      const first = yield* Effect.promise(() => reader.read());
      expect(Buffer.from(first.value!).toString()).toBe("data: fixture-first\n\n");
      expect(first.done).toBe(false);
      release();
      let tail = "";
      for (;;) {
        const part = yield* Effect.promise(() => reader.read());
        if (part.done) break;
        tail += Buffer.from(part.value!).toString();
      }
      expect(tail).toBe("data: fixture-last\n\n");
      expect(calls.map((call) => call.operation.sequence)).toEqual([undefined, 0, 1, 2]);
      const id = calls[0]!.operation.operation_id;
      for (const { requestId, operation } of calls) {
        expect(operation.offer_id).toBe(offerId);
        expect(operation.controller_id).toBe(controllerId);
        expect(operation.operation_id).toBe(id);
        expect(requestId).toContain(id);
      }
      expect(calls[0]!.operation.body_json).toBe('{"stream":true,"messages":[]}');
      expect(calls[0]!.operation.sdk_session_id).toBe("fixture-sdk-session");
      expect(yield* Effect.promise(() => broker.close())).toEqual({
        localRequestsDrained: true,
        outcomeUnknownOperationIds: [],
        executionReady: false,
      });
    }).pipe(Effect.scoped),
);

it.effect("re-reads a pending sequence without reinvoking or acknowledging it early", () =>
  Effect.gen(function* () {
    let reads = 0;
    const { broker, calls } = yield* fixture((operation) => {
      if (operation.action === "model_invoke") return pending(operation);
      if (reads++ === 0) return pending(operation);
      return operation.sequence === 0
        ? chunk(operation, '{"input_tokens":7}', false)
        : done(operation);
    });
    const response = yield* Effect.promise(() =>
      post(broker, '{"messages":[]}', "/v1/messages/count_tokens?beta=true"),
    );
    expect(yield* Effect.promise(() => response.text())).toBe('{"input_tokens":7}');
    expect(calls.filter((call) => call.operation.action === "model_invoke")).toHaveLength(1);
    expect(calls.map((call) => call.operation.sequence)).toEqual([undefined, 0, 0, 1]);
    expect(calls[0]!.operation.model_operation).toBe("count_tokens");
  }).pipe(Effect.scoped),
);

it.effect("keeps real upstream failure status/body and has no alternate account/model path", () =>
  Effect.gen(function* () {
    const bytes =
      '{"type":"error","error":{"type":"authentication_error","message":"fixture rejection"}}';
    const { broker, calls } = yield* fixture((operation) =>
      operation.action === "model_invoke"
        ? pending(operation)
        : operation.sequence === 0
          ? chunk(operation, bytes, false, 401)
          : done(operation, true),
    );
    const response = yield* Effect.promise(() => post(broker));
    expect(response.status).toBe(401);
    expect(yield* Effect.promise(() => response.text())).toBe(bytes);
    expect(calls[0]!.operation.body_json).toBe('{"messages":[]}');
    expect(yield* Effect.promise(() => broker.close())).toMatchObject({
      outcomeUnknownOperationIds: [],
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "rejects wrong credentials, unsupported routes, oversized/invalid JSON and missing actual session before dispatch",
  () =>
    Effect.gen(function* () {
      const { broker, calls, setSession } = yield* fixture((operation) => pending(operation));
      const wrong = yield* Effect.promise(() =>
        rawRequest(broker.baseUrl + "/v1/messages", { method: "POST", body: "{}" }),
      );
      expect(wrong.status).toBe(401);
      yield* Effect.promise(() => wrong.text());
      for (const [body, path, expected] of [
        ["{}", "/business_commands", 404],
        ["not-json", "/v1/messages", 400],
        ['{"payload":"' + "x".repeat(98_304) + '"}', "/v1/messages", 413],
      ] as const) {
        const response = yield* Effect.promise(() => post(broker, body, path));
        expect(response.status).toBe(expected);
        yield* Effect.promise(() => response.text());
      }
      setSession(undefined);
      const absent = yield* Effect.promise(() => post(broker));
      expect(absent.status).toBe(400);
      yield* Effect.promise(() => absent.text());
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect.each([
  "invoke-error",
  "wrong-operation",
  "bad-sequence",
  "bad-base64",
  "oversized-frame",
  "authority-claim",
])("retires on %s after dispatch without retry or a native/SDK cancellation claim", (mode) =>
  Effect.gen(function* () {
    const { broker, calls } = yield* fixture((operation) => {
      if (operation.action === "model_invoke") {
        if (mode === "invoke-error") throw new Error("fixture post-dispatch unknown");
        if (mode === "wrong-operation")
          return { ...pending(operation), operation_id: controllerId };
        return pending(operation);
      }
      const frame = chunk(operation, "fixture");
      if (mode === "bad-sequence") return { ...frame, sequence: 9 };
      if (mode === "bad-base64") return { ...frame, body_base64: "%%%=" };
      if (mode === "oversized-frame") return chunk(operation, Buffer.alloc(32_769));
      return { ...frame, execution_ready: true };
    });
    const response = yield* Effect.promise(() => post(broker));
    expect(response.status).toBe(502);
    yield* Effect.promise(() => response.text());
    const fatal = yield* Effect.promise(() => broker.failure);
    expect(fatal).toBeInstanceOf(NativeSupervisorModelBrokerError);
    const second = yield* Effect.promise(() => post(broker));
    expect(second.status).toBe(503);
    yield* Effect.promise(() => second.text());
    expect(calls.filter((call) => call.operation.action === "model_invoke")).toHaveLength(1);
    const stopped = yield* Effect.promise(() => broker.close());
    expect(stopped.outcomeUnknownOperationIds).toEqual([calls[0]!.operation.operation_id]);
    expect(stopped.executionReady).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("does not forward a frame into a replaced SDK session", () =>
  Effect.gen(function* () {
    let replaced = () => {};
    const { broker, calls, setSession } = yield* fixture((operation) => {
      if (operation.action === "model_invoke") return pending(operation);
      replaced();
      return chunk(operation, "must-not-forward");
    });
    replaced = () => setSession("different-fixture-session");
    const response = yield* Effect.promise(() => post(broker));
    expect(response.status).toBe(502);
    expect(yield* Effect.promise(() => response.text())).not.toContain("must-not-forward");
    expect(calls).toHaveLength(2);
    expect(yield* Effect.promise(() => broker.failure)).toMatchObject({
      reason: "native-protocol",
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "closing drains local requests without waiting for or replaying an unresolved native invocation",
  () =>
    Effect.gen(function* () {
      let observed!: () => void;
      const invoked = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const never = new Promise<unknown>(() => {});
      const { broker, calls } = yield* fixture(() => {
        observed();
        return never;
      });
      const request = post(broker)
        .then((response) => response.text())
        .catch(() => "closed");
      yield* Effect.promise(() => invoked);
      const result = yield* Effect.promise(() => broker.close());
      expect(result).toEqual({
        localRequestsDrained: true,
        outcomeUnknownOperationIds: [calls[0]!.operation.operation_id],
        executionReady: false,
      });
      yield* Effect.promise(() => request);
      expect(calls).toHaveLength(1);
      expect(yield* Effect.promise(() => broker.close())).toEqual(result);
    }).pipe(Effect.scoped),
);

it.effect(
  "an SDK client disconnect after a chunk retires the original operation and rejects SDK retry dispatch",
  () =>
    Effect.gen(function* () {
      const never = new Promise<unknown>(() => {});
      const { broker, calls } = yield* fixture((operation) =>
        operation.action === "model_invoke"
          ? pending(operation)
          : operation.sequence === 0
            ? chunk(operation, "data: fixture-first\n\n")
            : never,
      );
      const response = yield* Effect.promise(() => post(broker));
      const reader = response.body!.getReader();
      expect((yield* Effect.promise(() => reader.read())).done).toBe(false);
      yield* Effect.promise(() => reader.cancel());
      expect(yield* Effect.promise(() => broker.failure)).toMatchObject({
        reason: "client-disconnected",
      });
      const retry = yield* Effect.promise(() => post(broker));
      expect(retry.status).toBe(503);
      yield* Effect.promise(() => retry.text());
      expect(calls.filter((call) => call.operation.action === "model_invoke")).toHaveLength(1);
      expect((yield* Effect.promise(() => broker.close())).outcomeUnknownOperationIds).toEqual([
        calls[0]!.operation.operation_id,
      ]);
    }).pipe(Effect.scoped),
);
it.effect(
  "native failed publication after success-status chunks cannot become successful HTTP completion",
  () =>
    Effect.gen(function* () {
      const { broker } = yield* fixture((operation) =>
        operation.action === "model_invoke"
          ? pending(operation)
          : operation.sequence === 0
            ? chunk(operation, "data: fixture-partial\n\n")
            : done(operation, true),
      );
      const outcome = yield* Effect.promise(() =>
        post(broker)
          .then((response) => response.text())
          .catch(() => "connection-closed"),
      );
      expect(outcome).toBe("connection-closed");
      expect(yield* Effect.promise(() => broker.failure)).toMatchObject({
        reason: "native-unavailable",
      });
      expect(yield* Effect.promise(() => broker.close())).toMatchObject({
        outcomeUnknownOperationIds: [],
        executionReady: false,
      });
    }).pipe(Effect.scoped),
);
