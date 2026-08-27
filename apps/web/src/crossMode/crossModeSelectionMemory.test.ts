import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVE_CTOX_INSTANCE_STORAGE_KEY,
  createCrossModeSelectionMemory,
} from "./crossModeSelectionMemory";

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  };
}

describe("cross-mode active CTOX instance persistence", () => {
  it("persists only the bounded active instance id and restores it", () => {
    const { storage, values } = memoryStorage();
    const first = createCrossModeSelectionMemory({ activeInstanceStorage: storage });

    first.remember({ mode: "business-os", ctoxInstanceId: "instance-alpha" });

    expect(values.get(ACTIVE_CTOX_INSTANCE_STORAGE_KEY)).toBe("instance-alpha");
    expect(JSON.stringify(Object.fromEntries(values))).not.toMatch(/secret|record|thread/u);
    expect(
      createCrossModeSelectionMemory({ activeInstanceStorage: storage }).read("business-os"),
    ).toEqual({ mode: "business-os", ctoxInstanceId: "instance-alpha" });
  });

  it("rejects invalid persisted or newly selected instance ids", () => {
    const { storage } = memoryStorage({
      [ACTIVE_CTOX_INSTANCE_STORAGE_KEY]: "not an opaque id",
    });
    const memory = createCrossModeSelectionMemory({ activeInstanceStorage: storage });

    expect(memory.read("business-os")).toBeNull();
    memory.remember({
      mode: "business-os",
      ctoxInstanceId: "x".repeat(129),
    } as never);
    expect(memory.read("business-os")).toBeNull();
  });

  it("keeps the in-memory source of truth usable when localStorage throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const memory = createCrossModeSelectionMemory({ activeInstanceStorage: storage });

    expect(() =>
      memory.remember({ mode: "business-os", ctoxInstanceId: "instance-alpha" }),
    ).not.toThrow();
    expect(memory.read("business-os")).toEqual({
      mode: "business-os",
      ctoxInstanceId: "instance-alpha",
    });
  });

  it("publishes one synchronous hook for Code-side scope activation", () => {
    const memory = createCrossModeSelectionMemory();
    const observed: Array<string | null> = [];
    const unsubscribe = memory.subscribeToActiveCtoxInstance(() => {
      observed.push(memory.readActiveCtoxInstanceId());
    });

    memory.remember({ mode: "business-os", ctoxInstanceId: "instance-alpha" });
    memory.remember({ mode: "business-os", ctoxInstanceId: "instance-alpha" });
    memory.remember({ mode: "business-os", ctoxInstanceId: "instance-beta" });
    memory.forget("business-os");
    unsubscribe();

    expect(observed).toEqual(["instance-alpha", "instance-beta", null]);
  });
});
