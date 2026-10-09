// @effect-diagnostics globalFetch:off -- Bounded, vendor-only discovery transport regression.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WORKJET_GATEWAY_KIMI_ENDPOINTS } from "@workjet/contracts";
import { discoverKimiConnection, KIMI_BASE_URLS } from "./KimiConnection.ts";
const codingUrl = "https://api.kimi.com/coding/v1";
const apiUrl = "https://api.moonshot.ai/v1";

// Captured from this owner's real Kimi Code GET /models on 2026-10-08.
// No guessed model IDs are introduced by these fixtures.
const liveModels = ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"];
const list = () => Response.json({ data: liveModels.map((id) => ({ id })) });

afterEach(() => vi.unstubAllGlobals());

describe("Kimi key origin discovery", () => {
  it("uses the accepted coding plan, probing both official endpoints without redirects", async () => {
    const requests: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, redirect: init.redirect });
      expect(init.headers).toEqual({
        authorization: "Bearer fixture-key",
        "User-Agent": "Workjet",
      });
      return url.startsWith(codingUrl) ? list() : new Response("", { status: 401 });
    });
    expect(await discoverKimiConnection("fixture-key")).toEqual({
      plan: "coding",
      upstreamBaseUrl: codingUrl,
      models: liveModels,
    });
    expect(requests.map((request) => request.url)).toEqual(
      KIMI_BASE_URLS.map((url) => `${url}/models`),
    );
    expect(requests.every((request) => request.redirect === "error")).toBe(true);
  });

  it("retains an explicitly configured, accepted origin when both lists work", async () => {
    vi.stubGlobal("fetch", list);
    expect((await discoverKimiConnection("fixture-key", apiUrl))?.upstreamBaseUrl).toBe(apiUrl);
  });

  it("chooses the platform only when its authenticated list succeeds", async () => {
    vi.stubGlobal("fetch", (url: string) =>
      url.startsWith(apiUrl) ? list() : new Response("", { status: 403 }),
    );
    expect((await discoverKimiConnection("fixture-key"))?.upstreamBaseUrl).toBe(apiUrl);
  });

  it.each(WORKJET_GATEWAY_KIMI_ENDPOINTS)(
    "selects the accepted $plan origin $upstreamBaseUrl automatically",
    async (endpoint) => {
      vi.stubGlobal("fetch", (url: string) =>
        url === `${endpoint.upstreamBaseUrl}/models` ? list() : new Response("", { status: 401 }),
      );
      expect(await discoverKimiConnection("fixture-key")).toEqual({
        ...endpoint,
        models: liveModels,
      });
    },
  );

  it("never reports provider text or an unverified origin when all endpoints fail", async () => {
    vi.stubGlobal("fetch", () => new Response("provider echoed fixture-key", { status: 401 }));
    const log = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    expect(await discoverKimiConnection("fixture-key")).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it.each([
    { data: [] },
    { data: [{ id: 42 }] },
    { data: [{ id: "" }] },
    { data: Array.from({ length: 257 }, () => ({ id: liveModels[0] })) },
    { error: "fixture-key" },
  ])("refuses malformed lists", async (body) => {
    vi.stubGlobal("fetch", () => Response.json(body));
    expect(await discoverKimiConnection("fixture-key")).toBeUndefined();
  });

  it("bounds streamed responses even without a declared length", async () => {
    vi.stubGlobal("fetch", () => new Response(" ".repeat(64 * 1024 + 1)));
    expect(await discoverKimiConnection("fixture-key")).toBeUndefined();
  });

  it("passes caller cancellation to both vendor requests", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      expect(init.signal?.aborted).toBe(true);
      throw new Error("private fetch failure");
    });
    expect(
      await discoverKimiConnection("fixture-key", undefined, controller.signal),
    ).toBeUndefined();
  });
});
