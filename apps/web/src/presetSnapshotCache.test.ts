import { describe, expect, it } from "vite-plus/test";

import {
  presetSnapshotCacheKey,
  readCachedPresetSnapshot,
  writeCachedPresetSnapshot,
} from "./presetSnapshotCache";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("last known presets (Presets nachgeklickt, Punkt 2)", () => {
  it("round-trips a read snapshot per environment and instance", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: memoryStorage(),
      configurable: true,
    });
    const snapshot = { revision: 7, configuration: null, updatedAtMs: 1 };
    writeCachedPresetSnapshot("env", "welsch.ctox.dev", snapshot);
    expect(readCachedPresetSnapshot("env", "welsch.ctox.dev")).toEqual(snapshot);
    expect(readCachedPresetSnapshot("env", "other")).toBeNull();
  });

  it("ignores broken entries instead of throwing", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: memoryStorage(),
      configurable: true,
    });
    localStorage.setItem(presetSnapshotCacheKey("env", "x"), "{not json");
    expect(readCachedPresetSnapshot("env", "x")).toBeNull();
    localStorage.setItem(presetSnapshotCacheKey("env", "y"), JSON.stringify({ revision: -1 }));
    expect(readCachedPresetSnapshot("env", "y")).toBeNull();
  });
});
