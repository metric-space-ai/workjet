import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { decodeLiveProviderModels } from "./LiveProviderCatalog.ts";
import { makePublicModelCatalogCache } from "./PublicModelCatalogCache.ts";

// These IDs were observed in the real configured Kimi Code GET /models on 2026-10-08.
const iso = (milliseconds: number) => DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
const catalog = (now: number) => ({
  schemaVersion: 1,
  checkedAt: iso(now),
  expiresAt: iso(now + 60_000),
  providers: [{ provider: "kimi", status: "observed", models: ["k3", "kimi-for-coding"] }],
});
const DAY = 24 * 60 * 60 * 1_000;
const harness = () => {
  let now = DAY;
  let saved = "";
  let calls = 0;
  let unavailable = false;
  const cache = () =>
    makePublicModelCatalogCache({
      now: () => now,
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
      fetch: async () => {
        calls++;
        if (unavailable) throw new Error("unavailable");
        return catalog(now);
      },
    });
  return {
    cache,
    advance: (ms: number) => {
      now += ms;
    },
    offline: () => {
      unavailable = true;
    },
    saved: () => saved,
    replace: (value: string) => {
      saved = value;
    },
    calls: () => calls,
    now: () => now,
  };
};
describe("PublicModelCatalogCache", () => {
  it("refreshes once on startup and once daily while coalescing concurrent consumers", async () => {
    const h = harness();
    const cache = h.cache();
    await Promise.all([cache.refresh(), cache.read(), cache.read()]);
    expect(h.calls()).toBe(1);
    h.advance(DAY - 1);
    await cache.read();
    expect(h.calls()).toBe(1);
    h.advance(1);
    await Promise.all([cache.read(), cache.read()]);
    expect(h.calls()).toBe(2);
    expect(JSON.parse(h.saved()).catalog.checkedAt).toBe(iso(h.now()));
  });
  it("keeps last observed suggestions after restart/offline without making them live proof", async () => {
    const h = harness();
    await h.cache().refresh();
    h.advance(DAY);
    h.offline();
    const restarted = h.cache();
    const value = await restarted.read();
    expect(value?.checkedAt).toBe(iso(DAY));
    expect(decodeLiveProviderModels(value, "kimi", h.now(), true)).toEqual([
      "k3",
      "kimi-for-coding",
    ]);
    expect(decodeLiveProviderModels(value, "kimi", h.now())).toBeUndefined();
    await restarted.read();
    expect(h.calls()).toBe(2);
  });
  it("expires old observations and refuses malformed/cache-poisoned entries", async () => {
    const h = harness();
    await h.cache().refresh();
    h.advance(7 * DAY + 1);
    h.offline();
    expect(await h.cache().read()).toBeUndefined();
    h.replace(
      JSON.stringify({ schemaVersion: 1, savedAtMs: h.now() + DAY, catalog: catalog(h.now()) }),
    );
    expect(await h.cache().read()).toBeUndefined();
    h.replace("invalid");
    expect(await h.cache().read()).toBeUndefined();
  });
  it("does not let cache-write failure break valid in-memory suggestions", async () => {
    const observed = catalog(DAY);
    const cache = makePublicModelCatalogCache({
      now: () => DAY,
      read: async () => {
        throw new Error("missing");
      },
      write: async () => {
        throw new Error("read-only");
      },
      fetch: async () => ({ ...observed, unrelatedPrivateValue: "must-not-persist" }),
    });
    expect(await cache.read()).toEqual(observed);
  });
});
