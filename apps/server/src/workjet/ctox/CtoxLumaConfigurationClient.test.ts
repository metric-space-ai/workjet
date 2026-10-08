import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeCtoxLumaConfigurationClient } from "./CtoxLumaConfigurationClient.ts";

const target = { endpoint: "https://native.invalid/mcp/instance-a", token: "synthetic-token" };
function transport(answer: unknown) {
  const requests: Array<{ url: string; authorization: string | undefined; params: unknown }> = [];
  const http = HttpClient.make((request) => Effect.gen(function* () {
    if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON body.");
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ params: Schema.Unknown })))(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);
    requests.push({ url: request.url, authorization: request.headers.authorization, params: body.params });
    return HttpClientResponse.fromWeb(request, Response.json({
      jsonrpc: "2.0", result: { content: [{ type: "text", text: "Receipt" }], structuredContent: answer },
    }));
  }));
  return { client: makeCtoxLumaConfigurationClient(http), requests };
}

describe("instance Luma native transport", () => {
  it.effect("retains the target and original revision, and never retries a stale update", () =>
    Effect.gen(function* () {
      const test = transport({ ok: false, conflict: true, revision: 2 });
      expect(yield* test.client.save(target, 1, { workerProfiles: [] }))
        .toEqual({ status: "conflict", revision: 2 });
      expect(test.requests).toEqual([{
        url: target.endpoint, authorization: "Bearer synthetic-token",
        params: { name: "business_os.luma_configuration_update",
          arguments: { expected_revision: 1, configuration: { workerProfiles: [] } } },
      }]);
    }),
  );
  it.effect("rejects unsafe revisions in native receipts", () => Effect.gen(function* () {
    const test = transport({ ok: true, revision: Number.MAX_SAFE_INTEGER + 1,
      configuration: {}, updated_at_ms: 1 });
    expect((yield* Effect.flip(test.client.read(target))).reason).toBe("remote-response-invalid");
  }));
  it.effect("rejects oversized writes before any provider request", () => Effect.gen(function* () {
    const test = transport({ ok: true, revision: 1 });
    expect((yield* Effect.flip(test.client.save(target, 0,
      { managedSystemPrompt: "x".repeat(1_024 * 1_024 + 1) }))).reason)
      .toBe("remote-response-invalid");
    expect(test.requests).toHaveLength(0);
  }));
});
