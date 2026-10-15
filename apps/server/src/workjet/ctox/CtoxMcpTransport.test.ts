import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  CTOX_MCP_SERVER_NAME,
  makeCtoxMcpTransport,
  normalizeCtoxMcpEndpoint,
} from "./CtoxMcpTransport.ts";
import {
  DecisionHubMcpClient,
  layer as decisionHubLayer,
} from "../decisionHub/DecisionHubMcpClient.ts";

const RequestBody = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const target = { endpoint: "https://mcp.ctox.dev/mcp/instance-a", token: "test-only-token" };

function fakeDaemon(answer: (body: typeof RequestBody.Type) => Response) {
  const calls: Array<{
    url: string;
    authorization: string | undefined;
    body: typeof RequestBody.Type;
  }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON request body");
      const body = decodeRequest(new TextDecoder().decode(request.body.body));
      calls.push({ url: request.url, authorization: request.headers.authorization, body });
      return HttpClientResponse.fromWeb(request, answer(body));
    }),
  );
  return { client, calls, transport: makeCtoxMcpTransport(client) };
}

const rpcResult = (result: unknown) => Response.json({ jsonrpc: "2.0", result });

describe("shared CTOX MCP transport", () => {
  it.effect("preserves managed instance routes, local endpoints and self-hosted base paths", () =>
    Effect.gen(function* () {
      for (const [input, expected] of [
        ["https://mcp.ctox.dev/mcp/instance-a", "https://mcp.ctox.dev/mcp/instance-a"],
        ["https://mcp.ctox.dev/mcp/instance-a/", "https://mcp.ctox.dev/mcp/instance-a"],
        ["http://127.0.0.1:8788", "http://127.0.0.1:8788/mcp"],
        ["http://[::1]:8788/mcp", "http://[::1]:8788/mcp"],
        ["https://example.com/ctox", "https://example.com/ctox/mcp"],
        ["https://example.com/ctox/mcp", "https://example.com/ctox/mcp"],
      ] as const) {
        expect(yield* normalizeCtoxMcpEndpoint(input)).toBe(expected);
      }
    }),
  );

  it.effect(
    "probes Business OS without requiring Decision Hub and keeps the configured route",
    () =>
      Effect.gen(function* () {
        const remote = fakeDaemon((body) =>
          rpcResult(
            body.method === "initialize"
              ? { serverInfo: { name: CTOX_MCP_SERVER_NAME } }
              : { tools: [{ name: "business_os.get_module" }] },
          ),
        );
        yield* remote.transport.probe(target, ["business_os.get_module"]);
        expect(remote.calls.map(({ body }) => body.method)).toEqual(["initialize", "tools/list"]);
        expect(
          remote.calls.every(
            ({ url, authorization }) =>
              url === target.endpoint && authorization === `Bearer ${target.token}`,
          ),
        ).toBe(true);
        expect(new Set(remote.calls.map(({ body }) => body.id)).size).toBe(2);
        expect(
          yield* Effect.flip(remote.transport.probe(target, ["business_os.write_app_file"])),
        ).toMatchObject({ reason: "remote-tools-missing" });
      }),
  );

  it.effect("refuses a different server before discovering or calling tools", () =>
    Effect.gen(function* () {
      const remote = fakeDaemon(() => rpcResult({ serverInfo: { name: "different-server" } }));
      expect(yield* Effect.flip(remote.transport.probe(target, []))).toMatchObject({
        reason: "remote-identity-mismatch",
      });
      expect(remote.calls).toHaveLength(1);
    }),
  );

  it.effect("requires the retry argument contract, not only the tool name", () =>
    Effect.gen(function* () {
      for (const inputSchema of [
        undefined,
        {},
        { properties: {} },
        { properties: { idempotency_key: { type: "number" } } },
      ]) {
        const remote = fakeDaemon((body) =>
          rpcResult(
            body.method === "initialize"
              ? { serverInfo: { name: CTOX_MCP_SERVER_NAME } }
              : { tools: [{ name: "business_os.modify_app", inputSchema }] },
          ),
        );
        expect(
          yield* Effect.flip(
            remote.transport.probe(target, ["business_os.modify_app"], {
              "business_os.modify_app": ["idempotency_key"],
            }),
          ),
        ).toMatchObject({ reason: "remote-tools-missing" });
        expect(remote.calls.map(({ body }) => body.method)).toEqual(["initialize", "tools/list"]);
      }
    }),
  );

  it.effect("does not retry writes or expose peer error messages", () =>
    Effect.gen(function* () {
      const remote = fakeDaemon(() =>
        Response.json({
          error: { code: -32000, message: "private peer data", data: { token: "private-token" } },
        }),
      );
      const error = yield* Effect.flip(
        remote.transport.callTool(target, "business_os.modify_app", {
          module_id: "app-a",
          instruction: "Update the title",
        }),
      );
      expect(error).toMatchObject({ reason: "remote-response-invalid" });
      expect(yield* encodeJson(error)).not.toContain("private");
      expect(remote.calls).toHaveLength(1);
    }),
  );

  it.effect("preserves a structured tool denial for the domain adapter", () =>
    Effect.gen(function* () {
      const result = { isError: true, structuredContent: { code: "permission_denied" } };
      const remote = fakeDaemon(() => rpcResult(result));
      expect(
        yield* remote.transport.callTool(target, "business_os.get_module", { module_id: "a" }),
      ).toEqual(result);
    }),
  );

  it.effect("rejects oversized UTF-8 responses and invalid envelopes", () =>
    Effect.gen(function* () {
      for (const response of [
        () => rpcResult({ structuredContent: "é".repeat(150_000) }),
        () => new Response("not JSON"),
        () => rpcResult(undefined),
      ]) {
        const remote = fakeDaemon(response);
        expect(
          yield* Effect.flip(remote.transport.callTool(target, "business_os.get_module", {})),
        ).toMatchObject({ reason: "remote-response-invalid" });
      }
    }),
  );

  it.effect("keeps the existing Decision Hub typed contract on the shared transport", () =>
    Effect.gen(function* () {
      const remote = fakeDaemon((body) => {
        if (body.method === "initialize")
          return rpcResult({ serverInfo: { name: CTOX_MCP_SERVER_NAME } });
        if (body.method === "tools/list")
          return rpcResult({
            tools: [
              { name: "decision_hub.request_decision" },
              { name: "decision_hub.get_decision" },
            ],
          });
        return rpcResult({
          structuredContent: {
            decision_id: "decision-a",
            status: "entschieden",
            resolution: { option_id: "option-a", comment: "Proceed" },
            updated_at_ms: 3,
          },
        });
      });
      const service = yield* DecisionHubMcpClient.pipe(
        Effect.provide(decisionHubLayer),
        Effect.provideService(HttpClient.HttpClient, remote.client),
      );
      yield* service.probe(target);
      expect(yield* service.getDecision(target, "decision-a")).toEqual({
        decisionId: "decision-a",
        status: "resolved",
        selectedOptionId: "option-a",
        comment: "Proceed",
        resolutionVersion: 3,
      });
    }),
  );
});

it.effect(
  "distinguishes rejected authentication without retrying or disclosing response data",
  () =>
    Effect.gen(function* () {
      for (const [status, reason] of [
        [401, "authentication-required"],
        [403, "connection-unavailable"],
        [503, "connection-unavailable"],
      ] as const) {
        const remote = fakeDaemon(() => new Response("private authentication details", { status }));
        const error = yield* Effect.flip(remote.transport.probe(target, []));
        expect(error).toMatchObject({ reason });
        expect(remote.calls).toHaveLength(1);
        expect(yield* encodeJson(error)).not.toContain("private");
        const service = yield* DecisionHubMcpClient.pipe(
          Effect.provide(decisionHubLayer),
          Effect.provideService(HttpClient.HttpClient, remote.client),
        );
        expect(yield* Effect.flip(service.probe(target, []))).toMatchObject({ reason });
      }
    }),
);

it.effect("classifies native JSON-RPC failures on HTTP 200 without exposing native messages", () =>
  Effect.gen(function* () {
    for (const [message, code, expected] of [
      [
        "source supervisor is not registered natively",
        "internal_error",
        "native-supervisor-unregistered",
      ],
      ["native supervisor history missing", "internal_error", "native-supervisor-history-missing"],
      [
        "native supervisor history missing: private token=secret",
        "internal_error",
        "internal_error",
      ],
      ["private policy details", "permission_denied", "permission_denied"],
      ["private token=secret", "private-code", "remote-error"],
    ] as const) {
      const spans: Tracer.Span[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const remote = fakeDaemon(() =>
        Response.json({ jsonrpc: "2.0", error: { code: -32603, message, data: { code } } }),
      );
      const result = yield* remote.transport
        .callTool(target, "business_os.workjet_worker_dispatch", { task: "private task" })
        .pipe(Effect.result, Effect.withTracer(tracer));
      expect(result._tag).toBe("Failure");
      const call = spans.find((span) => span.name === "CtoxMcpTransport.call");
      expect(call?.attributes.get("httpStatus")).toBe(200);
      expect(call?.attributes.get("failureReason")).toBe(expected);
      const attributes = yield* encodeJson(
        spans.map((span) => Object.fromEntries(span.attributes)),
      );
      expect(attributes).not.toContain(message);
      expect(attributes).not.toContain("private");
      expect(attributes).not.toContain(target.token);
    }
  }),
);

it.effect("records safe MCP failure classifications without arguments or credentials", () =>
  Effect.gen(function* () {
    for (const [status, failureReason] of [
      [403, "permission-denied"],
      [429, "rate-limited"],
    ] as const) {
      const spans: Tracer.Span[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const remote = fakeDaemon(() => new Response("private body", { status }));
      yield* remote.transport
        .probe(target, ["business_os.workjet_worker_dispatch"])
        .pipe(Effect.result, Effect.withTracer(tracer));
      const call = spans.find((span) => span.name === "CtoxMcpTransport.call");
      expect(call?.attributes.get("method")).toBe("initialize");
      expect(call?.attributes.get("httpStatus")).toBe(status);
      expect(call?.attributes.get("failureReason")).toBe(failureReason);
      const probe = spans.find((span) => span.name === "CtoxMcpTransport.probe");
      expect(probe?.attributes.get("reason")).toBe("connection-unavailable");
      const attributes = yield* encodeJson(
        spans.map((span) => Object.fromEntries(span.attributes)),
      );
      expect(attributes).not.toContain(target.token);
      const ownAttributes = yield* encodeJson(
        spans
          .filter((span) => span.name.startsWith("CtoxMcpTransport."))
          .map((span) => Object.fromEntries(span.attributes)),
      );
      expect(ownAttributes).not.toContain(target.endpoint);
      expect(attributes).not.toContain("private");
    }
  }),
);
