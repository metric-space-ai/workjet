/**
 * Isolierte Fixture für die R2-Review-Fixes: Leerzustand ohne Instanz,
 * Galeriekarten, Projekt-Editor (Einstellungen › Projekte), Instanz-Ruhezustände
 * nach 10 s, Instanzauswahl als Zeilen und „Repository klonen“ mit Zielordner.
 * Kein Backend, keine Verbindungen. Ansicht per
 * `?view=kein|karten|editor|laden|verbinden|auswahl|klonen|kpi|kacheln`.
 *
 * `kacheln` (WP-K1): sechs Kacheln in den Zuständen vorhanden ×2, leer, definiert
 * aber nicht berechnet, Lesen gescheitert ohne und mit gespeichertem Stand.
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
import { ProjectGallery } from "../routes/_chat.index";
import type { GalleryProject } from "../projectOverview";
import type { PromptedProjectKpis } from "../projectKpis";
import { exitModelFixture } from "../test/exitModelFixture";
import "../index.css";

const view = new URLSearchParams(window.location.search).get("view") ?? "karten";

/** Merkt gespeicherte Konfigurationen der Karten-Rückseite (nur Fixture-Nachweis). */
const savedConfigurations: string[] = [];
(window as unknown as { savedConfigurations: string[] }).savedConfigurations = savedConfigurations;
/** Merkt geöffnete Projekte (WP-K2: ganze Kachel öffnet). */
const openedProjects: string[] = [];
(window as unknown as { openedProjects: string[] }).openedProjects = openedProjects;

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
    configuration: {
      id: ProjectId.make("molecularity"),
      title: "molecularity",
      publicUrl: "https://molecularity.example",
      repoUrl: "https://github.com/metric-space-ai/molecularity",
      jourFixe: { weekday: 2, time: "10:00", timezone: "Europe/Berlin" },
      exitModel: { ...exitModelFixture, project_id: ProjectId.make("molecularity") },
    },
  },
  { key: "instance:fzul", id: "fzul", title: "fzul.app", local: null, native: true },
  {
    key: "instance:i-hate-ai",
    id: "i-hate-ai",
    title: "i-hate-ai.community",
    local: null,
    native: true,
  },
  {
    // Regression coverage: automatic syncs stored an unmarked websiteUrl: null;
    // the card must still fall back to the domain preview.
    key: "local:kunstmen",
    id: "kunstmen",
    title: "kunstmen.com",
    local: {
      id: ProjectId.make("kunstmen"),
      title: "kunstmen.com",
      environmentId: EnvironmentId.make("environment-local"),
      updatedAt: "2026-10-12T00:00:00.000Z",
      ctoxRegistration: null,
      overview: {
        tokenBudget: { limitBillions: null, revision: 0, jourFixe: null },
        websiteUrl: null,
        slots: [null, null, null],
      },
    },
    native: false,
  },
  {
    // WP-K2: keine Website, Git-Remote auf GitHub → Social-Preview des Repos.
    key: "local:workjet",
    id: "workjet",
    title: "Workjet",
    local: {
      id: ProjectId.make("workjet"),
      title: "Workjet",
      environmentId: EnvironmentId.make("environment-local"),
      updatedAt: "2026-10-12T00:00:00.000Z",
      ctoxRegistration: null,
      overview: { websiteUrl: null, websiteUrlCleared: true, slots: [null, null, null] },
      repositoryIdentity: {
        canonicalKey: "github.com/metric-space-ai/workjet",
        locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:metric-space-ai/workjet.git" },
        provider: "github",
        owner: "metric-space-ai",
        name: "workjet",
      },
    } as unknown as NonNullable<GalleryProject["local"]>,
    native: false,
  },
  {
    // WP-K2: weder Website noch GitHub → Regeltermin und Team statt leerer Fläche.
    key: "instance:lernwerk",
    id: "lernwerk",
    title: "Lernwerk",
    local: null,
    native: true,
    configuration: {
      id: ProjectId.make("lernwerk"),
      title: "Lernwerk",
      jourFixe: { weekday: 3, time: "09:30", timezone: "Europe/Berlin" },
    },
  },
];

/** WP-K2: Teamstand je Kachel ohne Vorschau (synthetisch). */
const fixtureCrew: Record<string, { lumas: number; disrupted: number }> = {
  "instance:lernwerk": { lumas: 3, disrupted: 1 },
  "local:workjet": { lumas: 2, disrupted: 0 },
  "instance:nordlicht": { lumas: 1, disrupted: 0 },
  "instance:hafen": { lumas: 4, disrupted: 2 },
};

/** WP-K1: KPI-Datensätze der Kachel-Ansicht (synthetisch). */
const readyKpi = (projectId: string, id: string, label: string, value: string) => ({
  prompt: { kpi_id: id, prompt: `${label} der letzten Woche`, revision: 1 },
  result: {
    status: "ready" as const,
    snapshot: {
      project_id: projectId,
      kpi_id: id,
      prompt_revision: 1,
      label,
      display_value: value,
      unit: "",
      sources: [
        {
          kind: "native_metric" as const,
          project_id: projectId,
          connection_id: "fixture",
          metric_key: id,
        },
      ],
      freshness: { calculated_at_ms: 1, refresh_at_ms: 2, fresh_until_ms: 3 },
    },
  },
});
const tileKpis = (projectId: string, values: [string, string][]): PromptedProjectKpis => ({
  project_id: projectId,
  revision: 1,
  items: values.map(([label, value], index) =>
    readyKpi(projectId, `kpi-${index + 1}`, label, value),
  ),
});
const tileExit = (projectId: string) => ({
  ...exitModelFixture,
  project_id: ProjectId.make(projectId),
});
const tileConfig = (projectId: string, exit: boolean) => ({
  id: ProjectId.make(projectId),
  title: projectId,
  exitModel: exit ? tileExit(projectId) : null,
});
const tileProjects: {
  project: GalleryProject;
  kpis: PromptedProjectKpis | undefined;
  failed: boolean;
}[] = [
  {
    project: {
      key: "instance:greppy",
      id: "greppy",
      title: "greppy.xyz",
      local: null,
      native: true,
      configuration: { ...tileConfig("greppy", true), publicUrl: "https://greppy.xyz" },
    },
    kpis: tileKpis("greppy", [
      ["Nutzer", "1.284"],
      ["Abfragen", "38.112"],
      ["Latenz", "41 ms"],
    ]),
    failed: false,
  },
  {
    project: {
      key: "instance:ctox",
      id: "ctox",
      title: "ctox.dev",
      local: null,
      native: true,
      configuration: { ...tileConfig("ctox", true), publicUrl: "https://ctox.dev" },
    },
    kpis: tileKpis("ctox", [
      ["Läufe", "212"],
      ["Erfolg", "94 %"],
      ["Warteschlange", "7"],
    ]),
    failed: false,
  },
  {
    // Erfolgreich gelesen, keine Kennzahl festgelegt, keine Bewertung.
    project: {
      key: "instance:nordlicht",
      id: "nordlicht",
      title: "Nordlicht",
      local: null,
      native: true,
      configuration: tileConfig("nordlicht", false),
    },
    kpis: { project_id: "nordlicht", revision: 1, items: [] },
    failed: false,
  },
  {
    // Kennzahlen festgelegt, aber noch nicht berechnet.
    project: {
      key: "instance:hafen",
      id: "hafen",
      title: "Hafenplan",
      local: null,
      native: true,
      configuration: tileConfig("hafen", false),
    },
    kpis: {
      project_id: "hafen",
      revision: 1,
      items: [
        {
          prompt: { kpi_id: "kpi-1", prompt: "Buchungen pro Woche", revision: 1 },
          result: { status: "resolving" },
        },
        {
          prompt: { kpi_id: "kpi-2", prompt: "Umsatz im Monat", revision: 1 },
          result: { status: "missing_source", reason_code: "no_source" },
        },
      ],
    },
    failed: false,
  },
  {
    // Lesen gescheitert (Zeitüberschreitung), nie zuvor gelesen.
    project: { key: "instance:kontor", id: "kontor", title: "Kontor", local: null, native: true },
    kpis: undefined,
    failed: true,
  },
  {
    // Lesen gescheitert, aber ein gespeicherter Stand liegt vor (localStorage).
    project: { key: "instance:werft", id: "werft", title: "Werft", local: null, native: true },
    kpis: undefined,
    failed: true,
  },
];
if (view === "kacheln") {
  try {
    localStorage.setItem(
      "workjet.projectCard.v1:welsch:werft",
      JSON.stringify({
        kpis: tileKpis("werft", [
          ["Aufträge", "56"],
          ["Marge", "18 %"],
          ["Offen", "3"],
        ]),
        exitModel: tileExit("werft"),
      }),
    );
    localStorage.removeItem("workjet.projectCard.v1:welsch:kontor");
  } catch {
    // Fixture ohne Speicher: die Kachel zeigt dann „—“.
  }
}

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
  // Gescheiterte Kennzahlen: die echte Galerie, ohne Zustandszeile. Reads laufen ins Leere.
  if (view === "kpi")
    return (
      <div className="h-dvh bg-background text-foreground">
        <ProjectGallery
          instanceId="fixture"
          registryStatus={undefined}
          lastUpdatedAt={undefined}
          projectsUnavailable={false}
          createForm={null}
          projects={galleryProjects.map((project) => ({
            ...project,
            onOpen: () => {},
            canArchive: false,
            statistics: { chatCount: null, activeChatCount: null, lastActivityAt: null },
          }))}
        />
      </div>
    );
  if (view === "kacheln")
    return (
      <main className="mx-auto max-w-6xl px-5 py-6">
        <h1 className="mb-4 text-[22px] font-semibold">Alle Projekte</h1>
        <div
          className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4 max-sm:grid-cols-1"
          data-workjet-project-gallery-grid=""
        >
          {tileProjects.map(({ project, kpis, failed }) => (
            <div key={project.key} className="min-w-0" data-workjet-project-tile="">
              <ProjectOverviewCard
                project={project}
                ctoxInstanceId="welsch"
                kpis={kpis}
                kpisUnavailable={failed}
                crew={fixtureCrew[project.key] ?? null}
                onOpen={() => openedProjects.push(project.key)}
                onSave={async () => true}
                onSaveKpis={async () => true}
                onRefreshKpis={async () => true}
                canArchive
              />
            </div>
          ))}
        </div>
      </main>
    );
  return (
    <main className="mx-auto max-w-6xl px-5 py-6">
      <h1 className="mb-4 text-[22px] font-semibold">Alle Projekte</h1>
      <div
        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4 max-sm:grid-cols-1"
        data-workjet-project-gallery-grid=""
      >
        {galleryProjects.map((project) => (
          <ProjectOverviewCard
            key={project.key}
            project={project}
            crew={fixtureCrew[project.key] ?? null}
            onOpen={() => openedProjects.push(project.key)}
            onSave={async () => true}
            onSaveConfiguration={
              project.configuration
                ? async () => {
                    savedConfigurations.push(project.id);
                    return true;
                  }
                : undefined
            }
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
