/**
 * Isolierte Fixture für den Seitenleistenkopf (#579, #580, 15.10.): Projektumschalter
 * mit 15 Projekten (inkl. „metric“/„Metric“ und „Light Gun Heroes“), darunter die
 * Icon-Leiste (Alle Projekte, Übersicht, Projekteinstellungen, Suche) und das Team
 * mit dem Plus unter „Persistente Worker“. Kein Backend, keine Verbindungen.
 * Ansicht per `?view=switcher|kopf|alle|suche|plus|schmal` (schmal: 200 px breite Leiste).
 */
import { EnvironmentId, ProjectId } from "@workjet/contracts";
import { CheckIcon, SearchIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import type { AvailableProject } from "./availableProjects";
import { SidebarAddPersistentWorker } from "./components/sidebar/SidebarAddPersistentWorker";
import { SidebarProjectNav } from "./components/sidebar/SidebarProjectNav";
import { SidebarProjectSwitcher } from "./components/sidebar/SidebarProjectSwitcher";
import {
  buildProjectSwitcherEntries,
  projectFolderName,
} from "./components/sidebar/projectSwitcher.logic";
import { SidebarProvider } from "./components/ui/sidebar";
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

const team = {
  supervisor: [{ title: "Projekt-Supervisor", state: "Bereit", dot: "bg-emerald-500" }],
  parents: [
    { title: "Release-Koordination und Abnahme", state: "Arbeitet", dot: "bg-sky-500" },
    { title: "Kundenkommunikation", state: "Wartet", dot: "bg-amber-500" },
  ],
  workers: [{ title: "PR #742 Seitenleiste", state: "Arbeitet", dot: "bg-sky-500" }],
};
const teamLabels = {
  supervisor: "Supervisor",
  parents: "Persistente Worker",
  workers: "Einmal-Worker",
} as const;

function TeamRow(props: { readonly title: string; readonly state: string; readonly dot: string }) {
  return (
    <li className="flex min-h-9 list-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm hover:bg-sidebar-row-hover">
      <span className={`block size-2 shrink-0 rounded-full ${props.dot}`} />
      <span className="min-w-0 flex-1 whitespace-normal break-words font-medium leading-snug">
        {props.title}
      </span>
      <span className="shrink-0 text-xs text-secondary-label">{props.state}</span>
      <span className="inline-flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground">
        <CheckIcon aria-hidden className="size-3" />
        Erledigen
      </span>
    </li>
  );
}

function Kopf() {
  const [switcherOpen, setSwitcherOpen] = useState(view === "switcher");
  const [selectedId, setSelectedId] = useState<string | null>(view === "alle" ? null : "p0");
  const [searchOpen, setSearchOpen] = useState(view === "suche");
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
        {selectedId !== null ? (
          <SidebarProjectNav
            label="Light Gun Heroes"
            text={text}
            onHome={() => setSelectedId(null)}
            onOverview={() => {}}
            overviewActive
            onSettings={() => {}}
            searchActive={searchOpen}
            onSearch={() => setSearchOpen((open) => !open)}
          />
        ) : null}
        {selectedId !== null && searchOpen ? (
          <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground">
            <SearchIcon className="size-4 shrink-0" />
            <input
              autoFocus
              type="search"
              placeholder={text.search}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-sidebar-muted-foreground"
            />
            <XIcon className="size-3" />
          </div>
        ) : null}
        {selectedId !== null ? (
          <ul className="flex flex-col gap-px">
            <li aria-hidden className="mx-2.5 mb-1 mt-1 h-px list-none bg-sidebar-border" />
            {(["supervisor", "parents", "workers"] as const).map((section) => [
              <li key={`${section}-h`} className="mb-0.5 mt-3 list-none px-2.5 first:mt-1">
                <span className="text-xs font-medium text-sidebar-muted-foreground">
                  {teamLabels[section]}
                </span>
              </li>,
              ...team[section].map((row) => <TeamRow key={row.title} {...row} />),
              section === "parents" ? (
                <li key="add" className="list-none">
                  <SidebarAddPersistentWorker
                    text={text}
                    defaultOpen={view === "plus"}
                    onCreate={async () => true}
                  />
                </li>
              ) : null,
            ])}
          </ul>
        ) : null}
      </aside>
    </SidebarProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Kopf />);
