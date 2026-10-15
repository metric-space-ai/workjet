import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PROJECT_OVERVIEW_TEXT } from "../../projectOverviewText";
import chatRouteSource from "../../routes/_chat.tsx?raw";
import sidebarSource from "../Sidebar.tsx?raw";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarAddPersistentWorker } from "./SidebarAddPersistentWorker";
import { SidebarProjectNav } from "./SidebarProjectNav";

const text = PROJECT_OVERVIEW_TEXT.de;

const visibleText = (html: string) =>
  html
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

describe("Icon-Leiste unter dem Projektnamen (Michael, 15.10.)", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <SidebarProjectNav
        label="Light Gun Heroes"
        text={text}
        onHome={() => {}}
        onOverview={() => {}}
        overviewActive
        onSettings={() => {}}
        onSearch={() => {}}
      />
    </SidebarProvider>,
  );

  it("zeigt nur Icons, keine Zeilen mit Text", () => {
    expect(visibleText(html)).toEqual([]);
    expect(html.match(/<button/g)).toHaveLength(4);
  });

  it("hat Haus, Übersicht, Projekteinstellungen und Suche in dieser Reihenfolge", () => {
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(labels).toEqual([
      "Light Gun Heroes",
      text.allProjects,
      text.overview,
      text.projectSettings,
      text.search,
    ]);
  });

  it("markiert die aktive Ansicht", () => {
    expect(html).toMatch(/aria-label="Übersicht"[^>]*aria-pressed="true"/);
  });
});

describe("Seitenleiste ohne „Neue Unterhaltung“", () => {
  it("zeigt in einem Projekt die Leiste, in „Alle Projekte“ weder Leiste noch Suche", () => {
    expect(sidebarSource).toContain("{navProject !== null ? (");
    expect(sidebarSource).toContain("<SidebarProjectNav");
    expect(sidebarSource).toContain("{searchOpen ? (");
    expect(sidebarSource).toContain("if (!hasNavProject) closeThreadSearch();");
  });

  it("hat kein Tastenkürzel für „Neue Unterhaltung“ mehr", () => {
    expect(chatRouteSource).not.toContain("startNewThreadFromContext");
    expect(chatRouteSource).not.toContain('openCommandPalette({ open: "new-thread-in" })');
  });

  it("kürzt Worker-Namen im Team nicht mit „…“", () => {
    expect(sidebarSource).toContain('"whitespace-normal break-words leading-snug"');
  });
});

describe("Plus unter „Persistente Worker“", () => {
  it("ist ein Icon mit Tooltip, das Formular bleibt bis zum Klick zu", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarAddPersistentWorker text={text} onCreate={async () => true} />
      </SidebarProvider>,
    );
    // Kein sichtbarer Text: der Zuklappen-Pfeil ist ein Icon-Button (A-06), kein Text, keine Felder.
    expect(visibleText(html)).toEqual([]);
    expect(html).toContain('data-state="closed"');
    expect(html).not.toContain(text.goal);
    expect(html).toContain(`aria-label="${text.addPersistentWorker}"`);
    expect(html).toContain('data-workjet-action="project.worker.persistent.add"');
  });

  it("klappt inline auf: Name, Ziel, Abbrechen, Anlegen", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarAddPersistentWorker text={text} defaultOpen onCreate={async () => true} />
      </SidebarProvider>,
    );
    const words = visibleText(html);
    expect(words).toEqual(
      expect.arrayContaining([text.addPersistentWorker, text.name, text.goal, text.create]),
    );
    expect(html).not.toContain('role="dialog"');
  });

  it("nutzt denselben Anlegeweg wie die Projektübersicht", () => {
    expect(sidebarSource).toContain('section === "parents" && addPersistentWorker !== null');
  });
});
