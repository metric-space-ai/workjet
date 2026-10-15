import { describe, expect, it, vi } from "vite-plus/test";
import { API_KEY_MODEL_BASE_URLS, discoverApiKeyModels } from "./ApiKeyModelConnection.ts";

// IDs observed in real authenticated GET /models on 2026-10-09.
const liveModels = { minimax: ["MiniMax-M3", "MiniMax-M3.1-Flash-Preview"], xai: ["grok-4.7"] };

describe("private API-key model discovery", () => {
  it.each(["minimax", "xai"] as const)("uses only the official %s endpoint", async (provider) => {
    const request = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ data: liveModels[provider].map((id) => ({ id })) }),
    );
    expect(
      await discoverApiKeyModels(provider, "fixture-key", undefined, undefined, request),
    ).toEqual({
      upstreamBaseUrl: API_KEY_MODEL_BASE_URLS[provider],
      models: liveModels[provider],
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(`${API_KEY_MODEL_BASE_URLS[provider]}/models`);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer fixture-key" },
    });
    expect(request.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("never sends a key to an unrecognized saved origin", async () => {
    const request = vi.fn(async () => Response.json({ data: [{ id: liveModels.xai[0] }] }));
    expect(
      await discoverApiKeyModels(
        "xai",
        "fixture-key",
        "https://other.example/v1",
        undefined,
        request,
      ),
    ).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 503])(
    "discards the body of HTTP %s without claiming rejected credentials",
    async (status) => {
      const response = new Response("provider echoed fixture-key", { status });
      const request = async () => response;
      expect(
        await discoverApiKeyModels("xai", "fixture-key", undefined, undefined, request),
      ).toBeUndefined();
      expect(response.body?.locked).toBe(false);
    },
  );

  it.each([
    { data: [] },
    { data: [{ id: 42 }] },
    { data: [{ id: "" }] },
    { data: [{ id: liveModels.xai[0] }], has_more: true },
    { data: Array.from({ length: 1025 }, () => ({ id: liveModels.xai[0] })) },
    { error: "fixture-key" },
  ])("refuses malformed or incomplete lists", async (body) => {
    expect(
      await discoverApiKeyModels("xai", "fixture-key", undefined, undefined, async () =>
        Response.json(body),
      ),
    ).toBeUndefined();
  });

  it("bounds undeclared response bytes", async () => {
    expect(
      await discoverApiKeyModels(
        "xai",
        "fixture-key",
        undefined,
        undefined,
        async () => new Response(" ".repeat(64 * 1024 + 1)),
      ),
    ).toBeUndefined();
  });

  it("cancels a pending reader when the caller aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const request = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: () => controller.abort(),
          cancel: () => {
            cancelled = true;
          },
        }),
      );
    expect(
      await discoverApiKeyModels("xai", "fixture-key", undefined, controller.signal, request),
    ).toBeUndefined();
    expect(cancelled).toBe(true);
  });

  it("does not start an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => new Response(""));
    expect(
      await discoverApiKeyModels("xai", "fixture-key", undefined, controller.signal, request),
    ).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});
