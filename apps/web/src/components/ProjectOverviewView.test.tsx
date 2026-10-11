import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { buildProjectOwnerOverview } from "../projectOverviewModel";
import { overviewFixture } from "../fixtures/project-overview.fixture-data";
import { ProjectOverviewView } from "./ProjectOverviewView";

function render(variant: Parameters<typeof overviewFixture>[0], language: "de" | "en") {
  return renderToStaticMarkup(
    <ProjectOverviewView
      data={buildProjectOwnerOverview({ ...overviewFixture(variant), language })}
      onOpenChat={() => {}}
      onOpenJourFixe={() => {}}
    />,
  );
}
describe("owner overview DOM", () => {
  it.each(["de", "en"] as const)(
    "has no unavailability captions in any %s fixture (criterion 1)",
    (language) => {
      for (const variant of ["empty", "molecularity", "full"] as const) {
        const html = render(variant, language);
        expect(html).not.toMatch(/not yet available|noch nicht verfügbar/iu);
        expect(html.match(/data-workjet-overview-kpi="/gu)).toHaveLength(5);
        expect(html).not.toContain("<pre");
        expect(html).not.toMatch(/raw data|Rohdaten/iu);
        expect(html).not.toContain("<details open");
      }
    },
  );
  it("omits the Needs you element when there are no decisions (criterion 5)", () => {
    for (const variant of ["empty", "molecularity"] as const) {
      const html = render(variant, "de");
      expect(html).not.toContain('data-workjet-overview-section="decisions"');
      expect(html).not.toContain("Braucht dich");
    }
    const full = render("full", "de");
    expect(full).toContain('data-workjet-overview-section="decisions"');
    expect(full).toContain("Aktion prüfen und entscheiden");
  });
  it("places disruption and escalation rows before goals and uses all five colors", () => {
    const html = render("full", "de");
    const goals = html.indexOf('data-workjet-overview-section="goals"');
    for (const alert of ["disruption", "escalation"])
      expect(html.indexOf(`data-workjet-overview-alert="${alert}"`)).toBeLessThan(goals);
    for (const color of ["red", "blue", "amber", "gray", "green"])
      expect(html).toContain(`data-workjet-overview-status="${color}"`);
  });
  it("keeps only one facts list with dashes for empty facts", () => {
    const html = render("molecularity", "en");
    expect(html.match(/data-workjet-overview-facts=""/gu)).toHaveLength(1);
    expect(html).toMatch(/Last Jour fixe<\/dt><dd>—<\/dd>/u);
    expect(html).toMatch(/Owner decisions<\/dt><dd>—<\/dd>/u);
  });
  it("localizes the control chip without changing the stored tick", () => {
    const html = render("molecularity", "en");
    expect(html).toContain("Last control");
    expect(html).not.toContain("Letzte Kontrolle");
    expect(render("molecularity", "de")).toContain("Letzte Kontrolle");
  });
});
