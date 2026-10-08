import { describe, expect, it } from "vite-plus/test";
import { decodeLiveProviderModels, readPublicModelCatalog } from "./LiveProviderCatalog.ts";

// Exact IDs from configured Kimi account GET/models,2026-10-08; no guessed models.
const catalog = () => ({
  schemaVersion: 1,
  checkedAt: "1970-01-01T00:00:01.000Z",
  expiresAt: "1970-01-01T00:01:01.000Z",
  providers: [{ provider: "kimi", status: "observed", models: ["k3", "kimi-for-coding", "k3"] }],
});
describe("LiveProviderCatalog", () => {
  it("uses only fresh exact IDs for the corresponding provider", () => {
    expect(decodeLiveProviderModels(catalog(), "kimi", 1_000)).toEqual(["k3", "kimi-for-coding"]);
    expect(decodeLiveProviderModels(catalog(), "codex", 1_000)).toBeUndefined();
    expect(decodeLiveProviderModels(catalog(), "kimi", 61_000)).toBeUndefined();
    expect(decodeLiveProviderModels(catalog(), "kimi", -10_000)).toBeUndefined();
  });
  it("refuses unavailable, malformed or duplicated provider observations", () => {
    const value = catalog();
    expect(
      decodeLiveProviderModels(
        { ...value, providers: [{ ...value.providers[0], status: "unavailable" }] },
        "kimi",
        1_000,
      ),
    ).toBeUndefined();
    expect(
      decodeLiveProviderModels(
        { ...value, providers: [...value.providers, ...value.providers] },
        "kimi",
        1_000,
      ),
    ).toBeUndefined();
    expect(
      decodeLiveProviderModels(
        { ...value, providers: [{ ...value.providers[0], models: [null] }] },
        "kimi",
        1_000,
      ),
    ).toBeUndefined();
  });
  it("bounds list count and freshness without a static fallback", () => {
    const value = catalog();
    expect(
      decodeLiveProviderModels({ ...value, expiresAt: "1970-01-01T00:06:40.000Z" }, "kimi", 1_000),
    ).toBeUndefined();
    expect(
      decodeLiveProviderModels(
        {
          ...value,
          providers: [{ ...value.providers[0], models: Array.from({ length: 1025 }, () => "k3") }],
        },
        "kimi",
        1_000,
      ),
    ).toBeUndefined();
  });
  it("reads the fixed public endpoint without account credentials or redirects", async () => {
    const value = await readPublicModelCatalog(async (url, init) => {
      expect(url).toBe("https://llm.ctox.dev/catalog");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).not.toHaveProperty("Authorization");
      return Response.json(catalog());
    });
    expect(decodeLiveProviderModels(value, "kimi", 1_000)).toEqual(["k3", "kimi-for-coding"]);
  });
  it("discards non-success and oversized responses", async () => {
    await expect(
      readPublicModelCatalog(async () => new Response("", { status: 503 })),
    ).rejects.toThrow();
    await expect(
      readPublicModelCatalog(async () => new Response(" ".repeat(128 * 1024 + 1))),
    ).rejects.toThrow();
  });
});
