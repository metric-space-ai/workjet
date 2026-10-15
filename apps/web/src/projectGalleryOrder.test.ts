import { describe, expect, it } from "vite-plus/test";
import {
  formatKpiTrend,
  createGalleryOrderWriter,
  type GalleryOrderState,
  galleryProjectIdsForSave,
  kpiTrendPercent,
  moveGalleryItem,
  orderGalleryProjects,
} from "./projectGalleryOrder";

const project = (id: string, native = true) => ({ key: `env:${id}`, id, native });

function writerFixture() {
  let current: GalleryOrderState = { revision: 4, projectIds: ["a", "b"] };
  const writes: {
    previous: GalleryOrderState;
    ids: readonly string[];
    resolve: (order: GalleryOrderState | null) => void;
    reject: (error: Error) => void;
  }[] = [];
  const applied: GalleryOrderState[] = [];
  const pending: boolean[] = [];
  const writer = createGalleryOrderWriter({
    current: () => current,
    persist: (previous, ids) =>
      new Promise((resolve, reject) => {
        writes.push({ previous, ids, resolve, reject });
      }),
    apply: (order) => {
      current = order;
      applied.push(order);
    },
    pending: (value) => pending.push(value),
  });
  return { writer, writes, applied, pending, current: () => current };
}

describe("scoped gallery saves", () => {
  it("rejects an overlapping move and uses the confirmed revision for the next save", async () => {
    const f = writerFixture();
    const first = f.writer.save(["b", "a"]);
    expect(await f.writer.save(["a", "b"])).toBe(false);
    expect(f.writes).toHaveLength(1);
    f.writes[0]!.resolve({ revision: 5, projectIds: ["b", "a"] });
    expect(await first).toBe(true);
    const next = f.writer.save(["a", "b"]);
    expect(f.writes[1]!.previous.revision).toBe(5);
    f.writes[1]!.resolve({ revision: 6, projectIds: ["a", "b"] });
    expect(await next).toBe(true);
    expect(f.pending).toEqual([true, false, true, false]);
  });
  it("drops a late success after the old instance view is disposed", async () => {
    const f = writerFixture();
    const first = f.writer.save(["b", "a"]);
    f.writer.dispose();
    f.writes[0]!.resolve({ revision: 5, projectIds: ["b", "a"] });
    expect(await first).toBe(false);
    expect(f.applied).toHaveLength(1);
    expect(await f.writer.save(["a", "b"])).toBe(false);
  });
  it("drops a late failure after the old view is disposed", async () => {
    const f = writerFixture();
    const first = f.writer.save(["b", "a"]);
    f.writer.dispose();
    f.writes[0]!.reject(new Error("Connection ended"));
    expect(await first).toBe(false);
    expect(f.applied).toHaveLength(1);
    expect(f.pending).toEqual([true]);
  });
  it("restores the confirmed order on a declined save and permits a retry", async () => {
    const f = writerFixture();
    const first = f.writer.save(["b", "a"]);
    f.writes[0]!.resolve(null);
    expect(await first).toBe(false);
    expect(f.current()).toEqual({ revision: 4, projectIds: ["a", "b"] });
    const retry = f.writer.save(["b", "a"]);
    expect(f.writes[1]!.previous.revision).toBe(4);
    f.writes[1]!.resolve({ revision: 5, projectIds: ["b", "a"] });
    expect(await retry).toBe(true);
  });
  it("takes custody of the requested order instead of retaining a mutable caller array", async () => {
    const f = writerFixture();
    const ids = ["b", "a"];
    const first = f.writer.save(ids);
    ids.reverse();
    expect(f.writes[0]!.ids).toEqual(["b", "a"]);
    f.writes[0]!.resolve(null);
    await first;
  });
});

describe("gallery order", () => {
  it("places saved native projects first in saved order and keeps unknown ones after them", () => {
    const projects = [project("a"), project("b"), project("c"), project("local", false)];
    const ordered = orderGalleryProjects(projects, ["c", "a"]);
    expect(ordered.map((item) => item.id)).toEqual(["c", "a", "b", "local"]);
  });

  it("keeps the incoming order when nothing is saved", () => {
    const projects = [project("a"), project("b")];
    expect(orderGalleryProjects(projects, []).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("persists only native projects", () => {
    expect(galleryProjectIdsForSave([project("a"), project("local", false), project("b")])).toEqual(
      ["a", "b"],
    );
  });

  it("moves an item to the drop position", () => {
    expect(moveGalleryItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveGalleryItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveGalleryItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

describe("KPI trend", () => {
  it("computes the change against the previous value", () => {
    expect(kpiTrendPercent(12, 10)).toBe(20);
    expect(kpiTrendPercent(8, 10)).toBe(-20);
  });

  it("has no trend without a usable baseline", () => {
    expect(kpiTrendPercent(5, 0)).toBeNull();
    expect(kpiTrendPercent(null, 10)).toBeNull();
    expect(formatKpiTrend(null)).toBeNull();
  });

  it("formats a signed label with a real minus sign", () => {
    expect(formatKpiTrend(kpiTrendPercent(12, 10))).toBe("+20 %");
    expect(formatKpiTrend(kpiTrendPercent(9, 10))).toBe("−10 %");
    expect(formatKpiTrend(kpiTrendPercent(10, 10))).toBe("0 %");
  });
});
