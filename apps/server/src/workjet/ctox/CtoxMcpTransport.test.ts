import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error),
      ).not.toContain("private");
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
