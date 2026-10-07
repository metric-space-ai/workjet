import { describe, expect, it } from "vite-plus/test";
import { projectKpiSuggestions, suggestedProjectKpis } from "./projectKpiSuggestions";

describe("project KPI suggestions", () => {
  it("suggests exactly three editable figures for each of Michael’s twelve projects without invented values", () => {
    expect(Object.keys(projectKpiSuggestions)).toHaveLength(12);
    for (const title of Object.keys(projectKpiSuggestions)) {
      const slots = suggestedProjectKpis(title);
      expect(slots).toHaveLength(3);
      expect(new Set(slots?.map((slot) => slot?.label)).size).toBe(3);
      expect(slots?.every((slot) => slot?.kind === "text" && slot.value === "—")).toBe(true);
    }
  });
  it("normalizes website names and leaves unrecognized projects to their real local statistics", () => {
    expect(suggestedProjectKpis("HTTPS://WWW.GREPPY.XYZ/")).toEqual(suggestedProjectKpis("greppy.xyz"));
    expect(suggestedProjectKpis("A new project")).toBeNull();
  });
});
