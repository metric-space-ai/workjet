// @effect-diagnostics globalFetch:off -- Vendor-only plan-detection regression.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { discoverZaiConnection, ZAI_BASE_URLS } from "./ZaiConnection.ts";

// Real stored-account GET /models and bounded inference, 2026-10-09.
const model = "glm-5.3-flash";
const list = () => Response.json({ data: [{ id: model }] });
const answer = () => Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] });
afterEach(() => vi.unstubAllGlobals());

describe("Z.ai plan discovery", () => {
  it("distinguishes identical lists by actual inference without returning the credential", async () => {
    const requests: Array<string> = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      requests.push(url);
      expect(init.redirect).toBe("error");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer fixture-key");
      if (url.endsWith("/models")) return list();
      expect(JSON.parse(init.body as string)).toMatchObject({ model, max_tokens: 8, stream: false });
      return url.startsWith(ZAI_BASE_URLS[1])
        ? Response.json({ error: { code: "1113", message: "fixture-key" } }, { status: 429 })
        : answer();
    });
    const result = await discoverZaiConnection("fixture-key", [model], ZAI_BASE_URLS[1]);
    expect(result).toEqual({ upstreamBaseUrl: ZAI_BASE_URLS[0], models: [model], probeModel: model });
    expect(JSON.stringify(result)).not.toContain("fixture-key");
    expect(requests).toEqual([
      `${ZAI_BASE_URLS[1]}/models`,
      `${ZAI_BASE_URLS[1]}/chat/completions`,
      `${ZAI_BASE_URLS[0]}/models`,
      `${ZAI_BASE_URLS[0]}/chat/completions`,
    ]);
  });

  it("retains an explicitly accepted platform and never calls a second inference", async () => {
    const fetch = vi.fn((url: string) => url.endsWith("/models") ? list() : answer());
    vi.stubGlobal("fetch", fetch);
    expect((await discoverZaiConnection("fixture-key", [model], ZAI_BASE_URLS[1]))?.upstreamBaseUrl).toBe(ZAI_BASE_URLS[1]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["1302", "1308", "1309", "1310"])("does not turn a real Coding quota %s into billed API fallback", async (code) => {
    const fetch = vi.fn((url: string) => url.endsWith("/models") ? list() : Response.json({ error: { code } }, { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    expect(await discoverZaiConnection("fixture-key", [model], ZAI_BASE_URLS[0])).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("tries the platform when the coding credential is genuinely refused", async () => {
    vi.stubGlobal("fetch", (url: string) =>
      url.startsWith(ZAI_BASE_URLS[0]) ? new Response("", { status: 401 }) :
        url.endsWith("/models") ? list() : answer(),
    );
    expect((await discoverZaiConnection("fixture-key", [model]))?.upstreamBaseUrl).toBe(ZAI_BASE_URLS[1]);
  });

  it.each([
    { data: [] },
    { data: [{ id: 42 }] },
    { data: [{ id: " " }] },
    { data: [{ id: model + "\n" }] },
    { data: Array.from({ length: 257 }, () => ({ id: model })) },
    { error: "fixture-key" },
  ])("refuses malformed model lists before inference", async (body) => {
    const fetch = vi.fn(() => Response.json(body));
    vi.stubGlobal("fetch", fetch);
    expect(await discoverZaiConnection("fixture-key", [model])).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not infer success from HTTP 200 without an inference result", async () => {
    vi.stubGlobal("fetch", (url: string) => url.endsWith("/models") ? list() : Response.json({ choices: [] }));
    expect(await discoverZaiConnection("fixture-key", [model])).toBeUndefined();
  });

  it("bounds bodies and never sends the credential to a custom origin", async () => {
    const fetch = vi.fn(() => new Response(" ".repeat(64 * 1024 + 1)));
    vi.stubGlobal("fetch", fetch);
    expect(await discoverZaiConnection("fixture-key", [model], "https://other.invalid")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(await discoverZaiConnection("fixture-key", [model])).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains cancellation and does not probe inference for an unlisted selection", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      expect(init.signal?.aborted).toBe(true);
      throw new Error("private transport failure");
    });
    vi.stubGlobal("fetch", fetch);
    expect(await discoverZaiConnection("fixture-key", [model], undefined, controller.signal)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", list);
    expect(await discoverZaiConnection("fixture-key", [])).toBeUndefined();
  });
});
