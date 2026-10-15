import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PROJECT_OVERVIEW_TEXT } from "../../projectOverviewText";
import { SidebarProvider } from "../ui/sidebar";
import { buildProjectSwitcherEntries } from "./projectSwitcher.logic";
import { ProjectSwitcherList, SidebarProjectSwitcher } from "./SidebarProjectSwitcher";
import sidebarSource from "../Sidebar.tsx?raw";

const text = PROJECT_OVERVIEW_TEXT.de;
const entries = buildProjectSwitcherEntries([
  { id: "lgh", title: "Light Gun Heroes", metaCandidates: ["light-gun-heroes"] },
  { id: "m1", title: "metric", metaCandidates: ["metric", "welsch"] },
  { id: "m2", title: "Metric", metaCandidates: ["Metric-Archiv", "welsch"] },
]);

const visibleText = (html: string) =>
  html
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

describe("Projektliste der Seitenleiste", () => {
  it("zeigt „metric“ und „Metric“ als zwei unterscheidbare Einträge", () => {
    const html = renderToStaticMarkup(
      <ProjectSwitcherList
        entries={entries}
        selectedId="lgh"
        label={text.chooseProject}
        emptyText={text.noProjectFound}
        onChoose={() => {}}
      />,
    );
    const rows = html
      .split("<li>")
      .slice(1)
      .map((row) => visibleText(row).join(" · "));
    expect(rows).toHaveLength(3);
    const metricRows = rows.filter((row) => row.toLowerCase().startsWith("metric"));
    expect(metricRows).toEqual(["metric · metric", "Metric · Metric-Archiv"]);
    expect(new Set(metricRows.map((row) => row.toLowerCase())).size).toBe(2);
  });

  it("kürzt einen langen Projektnamen nicht mit „…“", () => {
    const long = "Light Gun Heroes – Arcade Remaster für Lichtpistolen und Röhrenmonitore";
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarProjectSwitcher
          entries={buildProjectSwitcherEntries([{ id: "lgh", title: long }])}
          selectedId="lgh"
          open={false}
          onOpenChange={() => {}}
          onSelectAll={() => {}}
          onSelect={() => {}}
          onCreateProject={() => {}}
          text={text}
        />
      </SidebarProvider>,
    );
    expect(html).toContain(long);
    expect(html).not.toContain("…");
    const current = html.slice(html.indexOf("data-project-switcher-current"));
    const nameSpan = current.slice(0, current.indexOf(long));
    expect(nameSpan).not.toContain("truncate");
    expect(nameSpan).toContain("whitespace-normal");
  });

  it("ersetzt in der Seitenleiste das alte Menü mit gekürzten Namen", () => {
    expect(sidebarSource).toContain("<SidebarProjectSwitcher");
    expect(sidebarSource).not.toContain("<MenuRadioItem");
    expect(sidebarSource).toContain("<span>{overviewText.newThread}</span>");
    expect(sidebarSource).not.toContain("overviewText.newThreadShort");
  });
});
