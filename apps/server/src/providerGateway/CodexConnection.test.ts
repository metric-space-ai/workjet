// @effect-diagnostics globalFetch:off -- Fixed authenticated Codex model-list regression.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { discoverCodexModels } from "./CodexConnection.ts";

const idToken = (accountId: string) =>
  `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.signature`;

afterEach(() => vi.unstubAllGlobals());

describe("Codex account model list", () => {
  it("reads only the authenticated fixed endpoint for the ID token account", async () => {
    const fetch = vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.144.1");
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({
        authorization: "Bearer fixture-access",
        "Chatgpt-Account-Id": "acct-fixture",
      });
      return Response.json({ models: [{ slug: "live-model" }, { slug: "live-model" }] });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await discoverCodexModels("fixture-access", idToken("acct-fixture"))).toEqual([
      "live-model",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed for missing account identity and malformed or oversized catalogs", async () => {
    const fetch = vi.fn(() => Response.json({ models: [{ slug: "live-model" }] }));
    vi.stubGlobal("fetch", fetch);
    expect(await discoverCodexModels("fixture-access", "invalid-token")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", () => Response.json({ models: [{ slug: "bad\nmodel" }] }));
    expect(await discoverCodexModels("fixture-access", idToken("acct-fixture"))).toBeUndefined();
    vi.stubGlobal("fetch", () => new Response("x".repeat(512 * 1024 + 1)));
    expect(await discoverCodexModels("fixture-access", idToken("acct-fixture"))).toBeUndefined();
  });
});
