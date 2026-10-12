/**
 * Isolierte Fixture für „Projekt anlegen“ mit den Quellen Neu | Aus Ordner |
 * Repository klonen, das Dropdown „Neue Unterhaltung in …“ und die Datei- und
 * Inhaltssuche unter „Suchen“ (Screenshots, kein Backend, keine Verbindungen).
 * Ansicht per `?view=neu|ordner|klonen|leer|menu|dateien|inhalt`.
 */
import { EnvironmentId, ProjectId, type ProjectContentMatch } from "@workjet/contracts";
import { SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { buildNewThreadMenuEntries, NewThreadInMenu } from "../components/NewThreadInMenu";
import {
  ProjectCloneFields,
  ProjectComputerSelect,
  ProjectCreateRequirementLine,
  ProjectCreateSourceSegment,
  ProjectFolderFields,
} from "../components/ProjectCreateSources";
import {
  buildProjectComputerOptions,
  type ProjectCreateSource,
} from "../components/ProjectCreateSources.logic";
import {
  SidebarContentResultList,
  SidebarFileResultList,
  SidebarSearchModeSegment,
  sidebarSearchPlaceholder,
} from "../components/sidebar/SidebarProjectSearch";
import { Button } from "../components/ui/button";
import { InlinePanel } from "../components/ui/inline-panel";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarMenuButton, SidebarProvider } from "../components/ui/sidebar";
import type { SidebarSearchMode } from "../commandPaletteBus";
import "../index.css";

const view = new URLSearchParams(window.location.search).get("view") ?? "neu";

const computers = buildProjectComputerOptions([
  {
    environmentId: EnvironmentId.make("environment-local"),
    label: "Local",
    isPrimary: true,
    connected: true,
  },
  {
    environmentId: EnvironmentId.make("environment-gpu3"),
    label: "gpu3-a4500",
    isPrimary: false,
    connected: true,
  },
]);

function ProjectCreatePanel(props: { readonly initial: ProjectCreateSource }) {
  const [source, setSource] = useState<ProjectCreateSource>(props.initial);
  const [environmentId, setEnvironmentId] = useState(computers[0]!.environmentId);
  const noInstance = view === "leer";
  const title =
    source === "folder" ? "workjet-site" : source === "clone" ? "ctox" : "Jour fixe Vertrieb";
  const computer = (
    <ProjectComputerSelect options={computers} value={environmentId} onChange={setEnvironmentId} />
  );
  return (
    <InlinePanel
      triggerLabel="Projekt anlegen"
      open
      onOpenChange={() => {}}
      segment={<ProjectCreateSourceSegment value={source} onChange={setSource} />}
      submitLabel="Anlegen"
      submitDisabled={noInstance}
      onSubmit={() => {}}
      {...(noInstance
        ? {
            status: (
              <ProjectCreateRequirementLine
                text="Keine Instanz verbunden"
                actionLabel="Einstellungen › Instanzen"
                onAction={() => {}}
              />
            ),
          }
        : {})}
    >
      {source === "folder" ? (
        <ProjectFolderFields
          computer={computer}
          path="~/projekte/workjet-site"
          onPathChange={() => {}}
          onPick={() => {}}
          suggestions={[
            { name: "workjet-site", fullPath: "/Users/dev/projekte/workjet-site" },
            { name: "workjet-slides", fullPath: "/Users/dev/projekte/workjet-slides" },
            { name: "workjet-actions", fullPath: "/Users/dev/projekte/workjet-actions" },
          ]}
          onSuggestion={() => {}}
        />
      ) : source === "clone" ? (
        <ProjectCloneFields
          computer={computer}
          providers={["url", "github", "gitlab"]}
          provider="url"
          onProviderChange={() => {}}
          repository="git@github.com:metricspace/ctox.git"
          onRepositoryChange={() => {}}
          baseDirectory="~/projekte"
          onBaseDirectoryChange={() => {}}
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <label className="grid gap-1 text-sm">
          Name
          <Input aria-label="Projektname" value={noInstance ? "" : title} onChange={() => {}} />
        </label>
        <div className="grid gap-1 text-sm">
          <span>Instanz</span>
          <Select value={noInstance ? "" : "welsch"}>
            <SelectTrigger aria-label="Instanz" disabled={noInstance}>
              <SelectValue>{noInstance ? "Keine Instanz verbunden" : "welsch"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="welsch">welsch</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      </div>
    </InlinePanel>
  );
}

const project = (id: string, title: string) => ({
  kind: "local" as const,
  id: ProjectId.make(id),
  title,
  environmentId: EnvironmentId.make("environment-local"),
  path: `/Users/dev/projekte/${id}`,
});

const contentMatches: ProjectContentMatch[] = [
  {
    path: "apps/web/src/routes/_chat.index.tsx",
    lineNumber: 1121,
    lineContent: '        triggerLabel="Projekt anlegen"',
    matchRanges: [{ start: 22, end: 37 }],
  },
  {
    path: "apps/web/src/components/ProjectCreateSources.logic.ts",
    lineNumber: 22,
    lineContent: '  { value: "folder", label: "Aus Ordner" },',
    matchRanges: [{ start: 29, end: 39 }],
  },
  {
    path: "apps/web/src/components/useProjectCreateSources.ts",
    lineNumber: 143,
    lineContent:
      "      const picked = await pickProjectFolder((options) => api.dialogs.pickFolder(options), {",
    matchRanges: [{ start: 27, end: 44 }],
  },
] as unknown as ProjectContentMatch[];

function SidebarFixture() {
  const mode: SidebarSearchMode =
    view === "dateien" ? "files" : view === "inhalt" ? "content" : "threads";
  const [menuOpen, setMenuOpen] = useState(view === "menu");
  const query = view === "dateien" ? "projekt" : view === "inhalt" ? "Projekt anlegen" : "";
  return (
    <SidebarProvider>
      <aside className="flex h-screen w-[min(100%,20rem)] flex-col gap-1 border-r border-border bg-sidebar p-2 text-sidebar-foreground">
        <div className="flex items-center gap-1">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm font-medium">
            <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
            <input
              aria-label="Suchen"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-sidebar-muted-foreground"
              placeholder={sidebarSearchPlaceholder(mode, "Suchen")}
              defaultValue={query}
            />
            {query ? (
              <Button size="icon-xs" variant="ghost" aria-label="Suche leeren" className="size-5">
                <XIcon className="size-3" />
              </Button>
            ) : null}
          </div>
          <SidebarMenuButton size="icon" aria-label="Neue Unterhaltung">
            <SquarePenIcon />
          </SidebarMenuButton>
          <NewThreadInMenu
            entries={buildNewThreadMenuEntries(
              [
                project("workjet-site", "Workjet Website"),
                project("ctox", "CTOX"),
                project("slides", "Jour-fixe-Folien"),
              ],
              null,
            )}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onSelect={() => setMenuOpen(false)}
            onCreateProject={() => {}}
          />
        </div>
        {mode !== "threads" ? (
          <SidebarSearchModeSegment mode={mode} onModeChange={() => {}} />
        ) : null}
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {mode === "files" ? (
            <SidebarFileResultList
              matches={[
                {
                  name: "ProjectCreateSources.tsx",
                  path: "apps/web/src/components/ProjectCreateSources.tsx",
                },
                {
                  name: "ProjectCreateSources.logic.ts",
                  path: "apps/web/src/components/ProjectCreateSources.logic.ts",
                },
                { name: "projectPaths.ts", path: "apps/web/src/lib/projectPaths.ts" },
                { name: "projectOverview.ts", path: "apps/web/src/projectOverview.ts" },
              ]}
              activeIndex={0}
              theme="dark"
              onHighlight={() => {}}
              onOpen={() => {}}
            />
          ) : mode === "content" ? (
            <SidebarContentResultList
              matches={contentMatches}
              activeIndex={0}
              theme="dark"
              onHighlight={() => {}}
              onOpen={() => {}}
            />
          ) : null}
        </div>
      </aside>
    </SidebarProvider>
  );
}

function Fixture() {
  if (view === "menu" || view === "dateien" || view === "inhalt") return <SidebarFixture />;
  const initial: ProjectCreateSource =
    view === "ordner" ? "folder" : view === "klonen" ? "clone" : "new";
  return (
    <div className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <h1 className="font-semibold text-lg">Projekte</h1>
        <ProjectCreatePanel initial={initial} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
