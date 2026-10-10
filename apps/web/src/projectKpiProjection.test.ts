import { describe, expect, it } from "vite-plus/test";
import { mergeProjectKpiRead, readGalleryProjectKpis } from "./projectKpiProjection";

describe("gallery KPI read admission", () => {
  it("loads visible cards despite a stalled first read, with at most two readers", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximum = 0;
    const visited: string[] = [];
    let finishVisible!: () => void;
    const visible = new Promise<void>((resolve) => {
      finishVisible = resolve;
    });
    const reading = readGalleryProjectKpis(
      ["blocked", "second", "ctox", "greppy"],
      async (id) => {
        active++;
        maximum = Math.max(maximum, active);
        visited.push(id);
        if (id === "blocked") await blocked;
        active--;
        if (id === "greppy") finishVisible();
      },
      () => true,
    );
    await visible;
    expect(visited).toEqual(["blocked", "second", "ctox", "greppy"]);
    expect(maximum).toBe(2);
    release();
    await reading;
    expect(active).toBe(0);
  });

  it("continues other project reads after a transport rejection", async () => {
    const visited: string[] = [];
    await readGalleryProjectKpis(
      ["failed", "second", "ctox"],
      async (id) => {
        visited.push(id);
        if (id === "failed") throw new Error("transport closed");
      },
      () => true,
    );
    expect(visited).toEqual(["failed", "second", "ctox"]);
  });

  it("does not admit more reads after the gallery scope closes", async () => {
    let active = true;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const visited: string[] = [];
    const reading = readGalleryProjectKpis(
      ["first", "second", "ctox"],
      async (id) => {
        visited.push(id);
        await blocked;
      },
      () => active,
    );
    active = false;
    release();
    await reading;
    expect(visited).toEqual(["first", "second"]);
  });
});

describe("native gallery KPI read recovery", () => {
  it("preserves a configured revision when an older startup read finishes afterwards", () => {
    const configured = { project_id: "ctox", revision: 2, items: [] };
    const saved = { instanceId: "own", records: { ctox: configured } };
    expect(
      mergeProjectKpiRead(saved, "own", "ctox", {
        project_id: "ctox",
        revision: 0,
        items: [],
      }),
    ).toBe(saved);
  });

  it("publishes one successful project without dropping other restored records", () => {
    const retained = { project_id: "greppy", revision: 1, items: [] };
    const recovered = { project_id: "ctox", revision: 0, items: [] };
    expect(
      mergeProjectKpiRead(
        { instanceId: "own", records: { greppy: retained } },
        "own",
        "ctox",
        recovered,
      ).records,
    ).toEqual({ greppy: retained, ctox: recovered });
  });

  it("does not accept a receipt belonging to a different project", () => {
    const previous = { instanceId: "own", records: {} };
    expect(
      mergeProjectKpiRead(previous, "own", "ctox", {
        project_id: "foreign",
        revision: 1,
        items: [],
      }),
    ).toBe(previous);
  });

  it("starts the new instance projection without exposing another instance's records", () => {
    expect(
      mergeProjectKpiRead(
        {
          instanceId: "old",
          records: { greppy: { project_id: "greppy", revision: 9, items: [] } },
        },
        "new",
        "ctox",
        { project_id: "ctox", revision: 0, items: [] },
      ),
    ).toEqual({
      instanceId: "new",
      records: { ctox: { project_id: "ctox", revision: 0, items: [] } },
    });
  });
});
