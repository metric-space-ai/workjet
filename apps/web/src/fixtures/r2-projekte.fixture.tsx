/**
 * Isolierte Fixture für die R2-Review-Fixes: Leerzustand ohne Instanz,
 * Galeriekarten, Projekt-Editor (Einstellungen › Projekte), Instanz-Ruhezustände
 * nach 10 s, Instanzauswahl als Zeilen und „Repository klonen“ mit Zielordner.
 * Kein Backend, keine Verbindungen. Ansicht per
 * `?view=kein|karten|editor|laden|verbinden|auswahl|klonen`.
 */
import type { CtoxManagedInstance } from "@workjet/contracts";
import { EnvironmentId, ProjectId } from "@workjet/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { InstanceOnboardingView } from "../components/ctox/InstanceOnboarding";
import { NoInstanceHero } from "../components/NoInstanceHero";
import { ProjectCloneFields, ProjectComputerSelect } from "../components/ProjectCreateSources";
import {
  buildProjectComputerOptions,
  knownCloneTargetFolders,
} from "../components/ProjectCreateSources.logic";
import { ProjectOverviewCard } from "../components/ProjectOverviewCard";
import { ProjectOverviewEditor } from "../components/ProjectOverviewEditor";
import { SidebarProvider } from "../components/ui/sidebar";
import type { GalleryProject } from "../projectOverview";
import "../index.css";

const view = new URLSearchParams(window.location.search).get("view") ?? "karten";

const instance = (id: string, displayName: string, status: string, ready: boolean) =>
  ({
    id,
    source: "ctox_dev",
    displayName,
    status,
    healthSummary: { dataPlaneReady: ready },
  }) as unknown as CtoxManagedInstance;
const instances = [
  instance("welsch", "welsch", "available", true),
  instance("thesen", "thesen", "available", false),
  instance("skf", "SKF", "offline", false),
];

const galleryProjects: GalleryProject[] = [
  { key: "instance:greppy", id: "greppy", title: "greppy.xyz", local: null, native: true },
  { key: "instance:ctox", id: "ctox", title: "ctox.dev", local: null, native: true },
  {
    key: "instance:molecularity",
    id: "molecularity",
    title: "molecularity",
    local: null,
    native: true,
  },
];

const computers = buildProjectComputerOptions([
  {
    environmentId: EnvironmentId.make("environment-local"),
    label: "Local",
    isPrimary: true,
    connected: true,
  },
]);

function CloneFixture() {
  const [baseDirectory, setBaseDirectory] = useState("~/projekte");
  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      <ProjectCloneFields
        computer={
          <ProjectComputerSelect
            options={computers}
            value={computers[0]!.environmentId}
            onChange={() => {}}
          />
        }
        providers={["url", "github", "gitlab"]}
        provider="url"
        onProviderChange={() => {}}
        repository="git@github.com:metric-space-ai/workjet-actions-runner.git"
        onRepositoryChange={() => {}}
        baseDirectory={baseDirectory}
        onBaseDirectoryChange={setBaseDirectory}
        targetFolders={knownCloneTargetFolders("~/projekte", [
          "/Users/dev/code/workjet",
          "/Users/dev/code/ctox",
          "/Volumes/tmp/claude-ia/r2-projekte",
        ])}
        onPickTarget={() => {}}
      />
    </div>
  );
}

function Fixture() {
  if (view === "kein")
    return (
      <SidebarProvider>
        <NoInstanceHero />
      </SidebarProvider>
    );
  if (view === "editor")
    return (
      <div className="mx-auto w-full max-w-3xl p-4">
        <ProjectOverviewEditor
          overview={{
            websiteUrl: "https://greppy.xyz",
            repositoryUrl: "https://github.com/metric-space-ai/greppy",
            slots: [null, null, null],
          }}
          configuration={{
            id: ProjectId.make("greppy"),
            title: "greppy.xyz",
            jourFixe: { weekday: 1, time: "09:00", timezone: "Europe/Berlin" },
          }}
          onSave={async () => true}
          onSaveConfiguration={async () => true}
          onCancel={() => {}}
        />
      </div>
    );
  if (view === "laden" || view === "verbinden" || view === "auswahl")
    return (
      <div className="flex h-dvh">
        <InstanceOnboardingView
          state={view === "laden" ? "loading" : view === "verbinden" ? "connecting" : "select"}
          instances={instances}
          selectedId={view === "auswahl" ? null : "welsch"}
          onSelect={() => {}}
          onRetry={() => {}}
          {...(view === "auswahl" ? {} : { slow: true })}
        />
      </div>
    );
  if (view === "klonen") return <CloneFixture />;
  return (
    <main className="mx-auto max-w-6xl px-5 py-6">
      <h1 className="mb-4 text-[22px] font-semibold">Alle Projekte</h1>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4 max-sm:grid-cols-1">
        {galleryProjects.map((project) => (
          <ProjectOverviewCard
            key={project.key}
            project={project}
            onOpen={() => {}}
            onSave={async () => true}
            onConfigure={() => {}}
            canArchive
          />
        ))}
      </div>
    </main>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: Fixture }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
