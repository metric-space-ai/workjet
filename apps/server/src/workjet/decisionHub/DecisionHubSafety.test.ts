import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { normalizeDecisionHubEndpoint } from "./DecisionHubConnectionRegistry.ts";
import { isDecisionHubResponseWithinLimit, mapRemoteStatus } from "./DecisionHubMcpClient.ts";
import { decisionHubContinuationIds, decisionHubRetryDelayMs } from "./DecisionHubReconciler.ts";

describe("Decision Hub safety boundaries", () => {
  it("accepts HTTPS and loopback HTTP endpoints but rejects credentialed or remote HTTP URLs", async () => {
    await expect(
      Effect.runPromise(normalizeDecisionHubEndpoint("https://mcp.ctox.dev/tenant")),
    ).resolves.toBe("https://mcp.ctox.dev/tenant/mcp");
    await expect(
      Effect.runPromise(normalizeDecisionHubEndpoint("http://127.0.0.1:8788/mcp")),
    ).resolves.toBe("http://127.0.0.1:8788/mcp");
    await expect(
      Effect.runPromise(normalizeDecisionHubEndpoint("http://example.com/mcp")),
    ).rejects.toMatchObject({ reason: "invalid-endpoint" });
    await expect(
      Effect.runPromise(normalizeDecisionHubEndpoint("https://user:secret@example.com/mcp")),
    ).rejects.toMatchObject({ reason: "invalid-endpoint" });
  });

  it("bounds remote responses by UTF-8 bytes and normalizes only known statuses", () => {
    expect(isDecisionHubResponseWithinLimit("a".repeat(256 * 1_024))).toBe(true);
    expect(isDecisionHubResponseWithinLimit("é".repeat(256 * 1_024))).toBe(false);
    expect(mapRemoteStatus("entschieden")).toBe("resolved");
    expect(mapRemoteStatus("unknown")).toBeUndefined();
  });

  it("derives deterministic continuation ids and bounded deterministic backoff", () => {
    expect(decisionHubContinuationIds("decision-7", 3)).toEqual(
      decisionHubContinuationIds("decision-7", 3),
    );
    expect(decisionHubContinuationIds("decision-7", 4)).not.toEqual(
      decisionHubContinuationIds("decision-7", 3),
    );
    expect(decisionHubRetryDelayMs(4, "decision-7")).toBe(decisionHubRetryDelayMs(4, "decision-7"));
    expect(decisionHubRetryDelayMs(99, "decision-7")).toBeLessThanOrEqual(345_000);
  });
});
