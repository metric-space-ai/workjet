import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { discoverClaudeModels, repairClaudeModelIds } from "./ClaudeConnection.ts";

// Observed by the real authenticated GET/models on2026-10-08; no invented IDs.
const model = "claude-opus-5-5";
const legacy = model.replace(/-(\d+)$/, ".$1");
const reply = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
afterEach(() => vi.unstubAllGlobals());

describe("Claude live model identity", () => {
  it("repairs the observed spelling only when the live list contains its target", () => {
    expect(repairClaudeModelIds([legacy, model], [model])).toEqual([model]);
    expect(repairClaudeModelIds([legacy], [])).toEqual([legacy]);
    expect(repairClaudeModelIds([model], [model])).toEqual([model]);
  });

  it("uses the fixed provider origin and discards transport credentials", async () => {
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      reply({ data: [{ id: model }], has_more: false }),
    );
    vi.stubGlobal("fetch", request);
    expect(await discoverClaudeModels("credential-in-memory")).toEqual([model]);
    expect(request.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/models?limit=1000");
    const options = request.mock.calls[0]?.[1] as RequestInit;
    expect(options.redirect).toBe("error");
    expect(options.headers).toMatchObject({ authorization: "Bearer credential-in-memory" });
  });

  it("refuses denied, malformed, incomplete and oversized observations", async () => {
    for (const response of [
      reply({ error: "credential-in-memory" }, { status: 401 }),
      reply({ data: [{ id: model }], has_more: true }),
      reply({ data: [{ id: model + "\n" }] }),
      reply({ data: [] }),
      reply({ data: [{ id: model }] }, { headers: { "content-length": "131073" } }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      expect(await discoverClaudeModels("credential-in-memory")).toBeUndefined();
    }
  });

  it("honors caller cancellation without returning response text", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ data: [{ id: model }] })),
    );
    expect(await discoverClaudeModels("credential-in-memory", controller.signal)).toBeUndefined();
  });
});
