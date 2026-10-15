/**
 * Isolierte Fixture für den Seitenleistenkopf (#579, #580): Projektumschalter
 * mit 15 Projekten (inkl. „metric“/„Metric“ und „Light Gun Heroes“) und das
 * Menü „Neue Unterhaltung in“. Kein Backend, keine Verbindungen.
 * Ansicht per `?view=switcher|neu|kopf|schmal` (schmal: 200 px breite Leiste).
 */
import { EnvironmentId, ProjectId } from "@workjet/contracts";
import { LayoutDashboardIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import type { AvailableProject } from "./availableProjects";
import { buildNewThreadMenuEntries, NewThreadInMenu } from "./components/NewThreadInMenu";
import { SidebarProjectSwitcher } from "./components/sidebar/SidebarProjectSwitcher";
import {
  buildProjectSwitcherEntries,
  projectFolderName,
} from "./components/sidebar/projectSwitcher.logic";
import { SidebarMenuButton, SidebarProvider } from "./components/ui/sidebar";
import { PROJECT_OVERVIEW_TEXT } from "./projectOverviewText";
import "./index.css";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  throw new Error("Seitenleisten-Fixture braucht einen lokalen Entwicklungsserver.");
}

const view = new URLSearchParams(window.location.search).get("view") ?? "switcher";
const text = PROJECT_OVERVIEW_TEXT.de;
const titles = [
  "Light Gun Heroes",
  "metric",
  "Metric",
  "molecularity",
  "ctox.dev",
  "greppy.xyz",
  "fzul.app",
  "i-hate-ai.community",
  "Workjet",
  "Slide Engine",
  "learnordie",
  "Thesen Recherche",
  "SKF Wartung",
  "News",
  "Regeltermin",
];
const computerLabels = new Map([
  ["env-mac", "MacBook"],
  ["env-gpu3", "gpu3"],
]);
const projects: AvailableProject[] = titles.map((title, index) => ({
  kind: "local",
  id: ProjectId.make(`p${index}`),
  title,
  environmentId: EnvironmentId.make(index === 2 ? "env-gpu3" : "env-mac"),
  path: index === 2 ? "/home/metric/Metric" : `/Users/michael/${title}`,
}));
const switcherEntries = buildProjectSwitcherEntries(
  projects.map((project) => ({
    id: project.id,
    title: project.title,
    metaCandidates: [projectFolderName(project.path), computerLabels.get(project.environmentId)],
  })),
);

function Kopf() {
  const [switcherOpen, setSwitcherOpen] = useState(view === "switcher");
  const [menuOpen, setMenuOpen] = useState(view === "neu");
  const [selectedId, setSelectedId] = useState<string | null>("p0");
  return (
    <SidebarProvider>
      <aside
        className={`flex h-screen ${view === "schmal" ? "w-[200px]" : "w-[260px]"} max-w-full flex-col gap-1 bg-sidebar p-2 text-sidebar-foreground`}
      >
        <div className="flex items-center gap-1">
          <SidebarProjectSwitcher
            entries={switcherEntries}
            selectedId={selectedId}
            open={switcherOpen}
            onOpenChange={setSwitcherOpen}
            onSelectAll={() => setSelectedId(null)}
            onSelect={setSelectedId}
            onCreateProject={() => {}}
            text={text}
          />
        </div>
        <div className="relative">
          <SidebarMenuButton
            type="button"
            className="text-sidebar-foreground"
            onClick={() => setMenuOpen(true)}
          >
            <PlusIcon aria-hidden className="size-4 shrink-0" />
            <span>{text.newThread}</span>
          </SidebarMenuButton>
          <NewThreadInMenu
            hideTrigger
            title={text.newThreadIn}
            entries={buildNewThreadMenuEntries(
              projects,
              null,
              (id) => computerLabels.get(id) ?? null,
            )}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onCreateProject={() => {}}
            onSelect={() => setMenuOpen(false)}
          />
        </div>
        <SidebarMenuButton type="button">
          <LayoutDashboardIcon aria-hidden className="size-4 shrink-0" />
          <span>{text.overview}</span>
        </SidebarMenuButton>
        <SidebarMenuButton type="button" className="text-sidebar-muted-foreground">
          <SettingsIcon aria-hidden className="size-4 shrink-0" />
          <span>{text.projectSettings}</span>
        </SidebarMenuButton>
        <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground">
          <SearchIcon className="size-4 shrink-0" />
          <span>{text.search}</span>
        </div>
      </aside>
    </SidebarProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Kopf />);
