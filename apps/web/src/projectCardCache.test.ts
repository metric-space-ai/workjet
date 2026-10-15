import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProjectId } from "@workjet/contracts";
import {
  bestKnownProjectCard,
  projectCardCacheKey,
  readCachedExitModel,
  readCachedProjectKpis,
  writeCachedExitModel,
  writeCachedProjectKpis,
} from "./projectCardCache";
import type { PromptedProjectKpis } from "./projectKpis";
import { exitModelFixture } from "./test/exitModelFixture";

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
  key: () => null,
  get length() {
    return memory.size;
  },
};

const kpis: PromptedProjectKpis = {
  project_id: "alpha",
  revision: 1,
  items: [
    {
      prompt: { kpi_id: "kpi-1", prompt: "Weekly users", revision: 1 },
      result: { status: "resolving" },
    },
  ],
};

describe("project card cache", () => {
  beforeEach(() => {
    memory.clear();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps KPIs and the exit valuation per instance and project", () => {
    writeCachedProjectKpis("welsch", "alpha", kpis);
    const exit = { ...exitModelFixture, project_id: ProjectId.make("alpha") };
    writeCachedExitModel("welsch", "alpha", exit);
    expect(readCachedProjectKpis("welsch", "alpha")).toEqual(kpis);
    expect(readCachedExitModel("welsch", "alpha")?.result?.expected_exit_equity_eur).toBe(
      exit.result?.expected_exit_equity_eur,
    );
    // The KPI write did not drop the exit valuation and vice versa.
    writeCachedProjectKpis("welsch", "alpha", { ...kpis, revision: 2 });
    expect(readCachedExitModel("welsch", "alpha")).not.toBeUndefined();
    expect(readCachedProjectKpis("thesen", "alpha")).toBeUndefined();
    expect(readCachedExitModel("welsch", "beta")).toBeUndefined();
  });

  it("distinguishes 'read, no valuation' (null) from 'never read' (undefined)", () => {
    expect(readCachedExitModel("welsch", "alpha")).toBeUndefined();
    writeCachedExitModel("welsch", "alpha", null);
    expect(readCachedExitModel("welsch", "alpha")).toBeNull();
  });

  it("rejects values of another project and broken entries", () => {
    writeCachedProjectKpis("welsch", "alpha", { ...kpis, project_id: "beta" });
    expect(memory.size).toBe(0);
    memory.set(projectCardCacheKey("welsch", "alpha"), "{not json");
    expect(readCachedProjectKpis("welsch", "alpha")).toBeUndefined();
    memory.set(
      projectCardCacheKey("welsch", "alpha"),
      JSON.stringify({ kpis: { project_id: "alpha", items: "x" }, exitModel: { foo: 1 } }),
    );
    expect(readCachedProjectKpis("welsch", "alpha")).toBeUndefined();
    expect(readCachedExitModel("welsch", "alpha")).toBeUndefined();
  });

  it("survives a storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(() => writeCachedProjectKpis("welsch", "alpha", kpis)).not.toThrow();
    expect(readCachedProjectKpis("welsch", "alpha")).toBeUndefined();
  });

  it("prefers the live state and falls back to the stored one only when unknown", () => {
    const stored = { kpis, exitModel: null };
    const live = { ...kpis, revision: 9 };
    expect(bestKnownProjectCard({ kpis: live, exitModel: undefined }, stored).kpis).toBe(live);
    expect(bestKnownProjectCard({ kpis: undefined, exitModel: undefined }, stored)).toEqual({
      kpis,
      exitModel: null,
    });
    // A live "no valuation" is a real answer and replaces a stored one.
    const exit = { ...exitModelFixture, project_id: ProjectId.make("alpha") };
    expect(
      bestKnownProjectCard({ kpis: undefined, exitModel: null }, { exitModel: exit }).exitModel,
    ).toBeNull();
  });
});
