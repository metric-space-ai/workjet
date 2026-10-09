import { describe, expect, it } from "vite-plus/test";
import { mergeProjectKpiRead } from "./projectKpiProjection";

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
