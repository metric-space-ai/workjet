import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ProjectOverview } from "@workjet/contracts";
import {
  ProjectOverviewCard,
  projectCardCrew,
  projectCardJourFixeLabel,
  projectCardMonogram,
} from "./ProjectOverviewCard";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import type { GalleryProject } from "../projectOverview";
import { PROJECT_OVERVIEW_TEXT, projectOverviewFormat } from "../projectOverviewText";
import type { PromptedProjectKpis } from "../projectKpis";
import {
  bestKnownProjectCard,
  readCachedProjectKpis,
  writeCachedProjectKpis,
} from "../projectCardCache";
import { exitModelFixture } from "../test/exitModelFixture";

// Diese Tests prüfen deutsche Texte: Oberflächensprache fest auf "de",
// damit "System" nicht von der Testumgebung (englisch) abhängt.
vi.mock("../hooks/useProjectOverviewLanguage", () => ({
  useProjectOverviewLanguage: () => "de",
}));

const project: GalleryProject = {
  key: "instance:greppy",
  id: "greppy",
  title: "greppy.xyz",
  local: null,
  native: true,
};
describe("project card text", () => {
  it("has German and English labels for opening the project and its website", () => {
    for (const language of ["de", "en"] as const) {
      const text = PROJECT_OVERVIEW_TEXT[language];
      expect(projectOverviewFormat(text.cardOpenWebsiteLabel, { title: "a", url: "b" })).toMatch(
        /a.*b/,
      );
      expect(projectOverviewFormat(text.cardOpenProjectLabel, { title: "a" })).toContain("a");
    }
    expect(PROJECT_OVERVIEW_TEXT.en.cardOpenWebsite).toBe("Open website");
    expect(PROJECT_OVERVIEW_TEXT.en.cardOpenProjectLabel).toBe("Open {title}");
  });
});
describe("compact project gallery", () => {
  it.each(["fzul.app", "i-hate-ai.community"])("uses the saved static preview for %s", (title) => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={{ ...project, title }} onOpen={() => {}} />,
    );
    expect(markup).toContain(`alt="Gespeicherte Vorschau von ${title}"`);
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<iframe");
    expect(markup).toContain("2026-10-07");
    // Native KPIs never read: no placeholder slots.
    expect(markup).not.toContain("data-workjet-project-card-slot=");
  });
  it("opens the project from the title and preview, and the website only via its own link", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={project} onOpen={() => {}} />,
    );
    expect(markup).toMatch(/<h2[^>]*><button[^>]*type="button"[^>]*>greppy.xyz<\/button><\/h2>/);
    expect(markup).not.toMatch(/<h2[^>]*><a/);
    expect(markup).toContain('data-workjet-action="project.open.gallery-title:instance:greppy"');
    expect(markup).toContain('data-workjet-action="project.open.gallery-preview:instance:greppy"');
    expect(markup.match(/href="https:\/\/greppy.xyz"/g)).toHaveLength(1);
    expect(markup).toMatch(
      /<a[^>]*href="https:\/\/greppy.xyz"[^>]*aria-label="Webseite von greppy.xyz öffnen \(https:\/\/greppy.xyz\)"|<a[^>]*aria-label="Webseite von greppy.xyz öffnen \(https:\/\/greppy.xyz\)"[^>]*href="https:\/\/greppy.xyz"/,
    );
    // #577: the website is a visible domain link; no tooltip-only icons.
    expect(markup).not.toContain('title="Webseite öffnen"');
    expect(markup).not.toContain('title="Projekt öffnen"');
    expect(markup).not.toContain("lucide-external-link");
    expect(markup).not.toContain("lucide-arrow-up-right");
    expect(markup).toContain('alt="Gespeicherte Vorschau von greppy.xyz"');
    expect(markup).toContain('aria-label="greppy.xyz öffnen"');
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("Hide preview");
    expect(markup).not.toContain("If the website blocks");
    expect(markup).not.toContain("Nicht eingerichtet");
    // KPIs not read yet: no placeholder values, no invented labels, no KPI strip.
    expect(markup).not.toContain("Nutzer");
    expect(markup).not.toContain("data-workjet-kpi-unknown");
    expect(markup).not.toContain("data-workjet-project-card-slots");
    expect(markup).not.toMatch(/>—</);
  });
  it("drops the preview area for a domain without a saved preview", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={{ ...project, title: "example.org" }} onOpen={() => {}} />,
    );
    expect(markup).toContain('href="https://example.org"');
    expect(markup).not.toContain("data-workjet-project-preview");
    expect(markup).not.toContain('aria-label="Logo von example.org"');
    expect(markup).toContain('aria-label="example.org öffnen"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("data-workjet-project-card-slot=");
    expect(markup).toContain("data-workjet-project-card-monogram");
  });
  it("retains archived values and exposes its actions through the compact menu", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
          ...project,
          local: {
            id: ProjectId.make("retained"),
            environmentId: EnvironmentId.make("environment"),
            title: project.title,
            updatedAt: "2026-10-06T18:00:00Z",
            ctoxRegistration: null,
            overview: {
              archived: true,
              websiteUrl: "https://fzul.app",
              slots: [{ kind: "text", label: "Status", value: "Retained" }, null, null],
            },
          },
        }}
        onOpen={() => {}}
        onSave={async () => true}
        canArchive
      />,
    );
    expect(markup).toContain('aria-label="Aktionen für greppy.xyz"');
    expect(markup).not.toContain("Configure greppy.xyz KPIs");
    expect(markup).not.toContain("lucide-pencil");
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("Retained");
  });
  it("keeps configuration available through a menu without exposing unsupported archive actions", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={project} onOpen={() => {}} onSave={async () => true} />,
    );
    expect(markup).not.toContain("Configure greppy.xyz KPIs");
    expect(markup).not.toContain("lucide-pencil");
    expect(markup).toContain('aria-label="Aktionen für greppy.xyz"');
    expect(markup).not.toContain("Projekt archivieren");
    expect(markup).not.toContain("Projekt wiederherstellen");
  });
  it("preserves all three configured fields and an explicitly cleared website", () => {
    const overview: ProjectOverview = {
      websiteUrl: null,
      slots: [
        { kind: "text", label: "Status", value: "Ready" },
        { kind: "link", label: "Plan", url: "https://greppy.xyz/plan" },
        { kind: "metric", label: "Queue", value: 7, unit: "tasks" },
      ],
    };
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
          ...project,
          local: {
            id: ProjectId.make("local"),
            environmentId: EnvironmentId.make("environment"),
            title: project.title,
            updatedAt: "2026-10-06T18:00:00Z",
            ctoxRegistration: null,
            overview,
          },
        }}
        onOpen={() => {}}
      />,
    );
    expect(markup).not.toContain("<iframe");
    expect(markup.match(/data-workjet-project-card-slot="/g)).toHaveLength(3);
    expect(markup).toContain("Ready");
    expect(markup).toContain('href="https://greppy.xyz/plan"');
    expect(markup).toContain("7 tasks");
    expect(markup).toMatch(/<dd class="[^"]*text-\[22px\][^"]*">7 tasks<\/dd>/);
    expect(markup).not.toMatch(/<dt[^>]*class="[^"]*truncate/);
  });
});

describe("inline card back", () => {
  it("shows neither a stamp nor a rating action while the exit valuation is unknown", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard project={project} onOpen={() => {}} ctoxInstanceId="welsch" />,
    );
    expect(markup).not.toContain("data-workjet-exit-model-stamp");
    expect(markup).not.toContain("Nicht bewertet");
    expect(markup).not.toContain("project.exit_model.rate");
  });
  it("renders the closed card without an expanded marker or a back face", () => {
    for (const props of [
      { onSave: async () => true },
      { onSaveConfiguration: async () => true },
      {},
    ]) {
      const markup = renderToStaticMarkup(
        <ProjectOverviewCard project={project} onOpen={() => {}} {...props} />,
      );
      expect(markup).not.toContain("data-workjet-project-card-expanded");
      expect(markup).not.toContain("data-workjet-project-card-backface");
      expect(markup).toContain('aria-label="Aktionen für greppy.xyz"');
    }
  });
});

describe("project card: last known state instead of state text", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: () => null,
    get length() {
      return memory.size;
    },
  };
  beforeEach(() => {
    memory.clear();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  const native: GalleryProject = {
    key: "instance:alpha",
    id: "alpha",
    title: "alpha",
    local: null,
    native: true,
  };
  const readyKpis: PromptedProjectKpis = {
    project_id: "alpha",
    revision: 3,
    items: [
      {
        prompt: { kpi_id: "kpi-1", prompt: "Weekly active users", revision: 3 },
        result: {
          status: "ready",
          snapshot: {
            project_id: "alpha",
            kpi_id: "kpi-1",
            prompt_revision: 3,
            label: "Aktive Nutzer",
            display_value: "412",
            unit: "",
            sources: [
              { kind: "native_metric", project_id: "alpha", connection_id: "c", metric_key: "u" },
            ],
            freshness: { calculated_at_ms: 1, refresh_at_ms: 2, fresh_until_ms: 3 },
          },
        },
      },
    ],
  };
  const stateTexts = [
    "nicht festgelegt",
    "nicht berechnet",
    "Nicht bewertet",
    "not set",
    "not calculated",
    "Not rated",
  ];

  it("keeps showing the old values when a read fails after a successful one", () => {
    // The successful read stores the values (the card's effect does this) …
    writeCachedProjectKpis("welsch", "alpha", readyKpis);
    // … then the next read fails: no live KPIs, the failure flag is set.
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={native}
        onOpen={() => {}}
        ctoxInstanceId="welsch"
        kpis={undefined}
        kpisUnavailable
        onSaveKpis={async () => true}
      />,
    );
    expect(markup).toContain("412");
    expect(markup).toContain("Aktive Nutzer");
    expect(markup).not.toContain("data-workjet-kpi-unknown");
  });

  it("a failed read never overwrites the stored values", () => {
    writeCachedProjectKpis("welsch", "alpha", readyKpis);
    const known = bestKnownProjectCard(
      { kpis: undefined, exitModel: undefined },
      { kpis: readCachedProjectKpis("welsch", "alpha") },
    );
    expect(known.kpis).toEqual(readyKpis);
  });

  it("shows no state text when the very first read fails", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={native}
        onOpen={() => {}}
        ctoxInstanceId="welsch"
        kpisUnavailable
        onSaveKpis={async () => true}
      />,
    );
    for (const text of stateTexts) expect(markup).not.toContain(text);
    // Unknown values drop out entirely: no „—“ and no empty KPI strip.
    expect(markup).not.toContain("data-workjet-project-card-slots");
    expect(markup).not.toMatch(/>—</);
    expect(markup).not.toContain("Kennzahlen festlegen");
  });

  it("offers exactly one 'Kennzahlen festlegen' button after a successful empty read", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={native}
        onOpen={() => {}}
        ctoxInstanceId="welsch"
        kpis={{ project_id: "alpha", revision: 1, items: [] }}
        onSaveKpis={async () => true}
      />,
    );
    expect(markup.match(/Kennzahlen festlegen/g)).toHaveLength(1);
    expect(markup).toMatch(/<button[^>]*data-workjet-action="project.kpis.define:instance:alpha"/);
    for (const text of stateTexts) expect(markup).not.toContain(text);
    expect(markup).not.toContain("data-workjet-project-card-slot=");
  });

  it("shows no stamp for a null exit valuation, only the secondary 'Bewerten' action", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
          ...native,
          configuration: { id: ProjectId.make("alpha"), title: "alpha", exitModel: null },
        }}
        onOpen={() => {}}
        ctoxInstanceId="welsch"
      />,
    );
    expect(markup).not.toContain("data-workjet-exit-model-stamp");
    expect(markup).not.toContain("Nicht bewertet");
    expect(markup.match(/>Bewerten</g)).toHaveLength(1);
    // Without an instance there is no way to start a valuation: nothing at all.
    const offline = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
          ...native,
          configuration: { id: ProjectId.make("alpha"), title: "alpha", exitModel: null },
        }}
        onOpen={() => {}}
      />,
    );
    expect(offline).not.toContain("Bewerten");
    expect(offline).not.toContain("data-workjet-exit-model-stamp");
  });

  it("stamps a value without a preview image, in a compact row instead of an empty area", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
          ...native,
          configuration: {
            id: ProjectId.make("alpha"),
            title: "alpha",
            exitModel: { ...exitModelFixture, project_id: ProjectId.make("alpha") },
          },
        }}
        onOpen={() => {}}
        ctoxInstanceId="welsch"
      />,
    );
    expect(markup).not.toContain("data-workjet-project-preview");
    expect(markup).toContain("data-workjet-project-stamp-row");
    expect(markup).toContain('data-workjet-exit-model-stamp=""');
  });
});

describe("whole card opens the project (WP-K2)", () => {
  it("makes the card itself a focusable open target and keeps configuring in the menu", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
          ...project,
          configuration: { id: ProjectId.make("greppy"), title: "greppy.xyz" },
        }}
        onOpen={() => {}}
        onSaveConfiguration={async () => true}
      />,
    );
    expect(markup).toMatch(/<article[^>]*tabindex="0"[^>]*aria-label="greppy.xyz öffnen"/);
    // The KPI strip is no longer one big configure button; „Konfigurieren“ sits in ⋯.
    expect(markup).not.toContain('data-workjet-action="project.configure.gallery:instance:greppy"');
  });

  it("shows the GitHub social preview when the project has no website snapshot", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
          key: "instance:molecularity",
          id: "molecularity",
          title: "molecularity",
          local: null,
          native: true,
          configuration: {
            id: ProjectId.make("molecularity"),
            title: "molecularity",
            publicUrl: null,
            repoUrl: "https://github.com/metric-space-ai/molecularity",
          },
        }}
        onOpen={() => {}}
      />,
    );
    expect(markup).toContain('data-workjet-project-preview="github"');
    expect(markup).toContain(
      'src="https://opengraph.githubassets.com/1/metric-space-ai/molecularity"',
    );
    expect(markup).toContain('alt="GitHub-Vorschau von molecularity"');
    expect(markup).not.toContain("data-workjet-project-card-content");
  });

  it("shows the next Regeltermin and the team as chips instead of an empty area", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{
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
        }}
        crew={{ workers: 3, disrupted: 1 }}
        onOpen={() => {}}
      />,
    );
    expect(markup).not.toContain("data-workjet-project-preview");
    expect(markup).toContain("data-workjet-project-card-content");
    expect(markup).toContain("Mi · 09:30");
    expect(markup).toContain('data-workjet-project-card-workers="3"');
    expect(markup).toMatch(/>Worker<\/dt>/);
    expect(markup).not.toContain("Lumas");
    expect(markup).toContain("1 gestört");
  });

  it("drops unknown values with their labels and shows only a calm monogram when nothing is known", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{ key: "instance:x", id: "x", title: "Kontor Nord", local: null, native: true }}
        onOpen={() => {}}
      />,
    );
    expect(markup).not.toContain("data-workjet-project-card-content");
    expect(markup).not.toContain("Regeltermin");
    expect(markup).not.toContain("Worker");
    expect(markup).not.toMatch(/>—</);
    expect(markup).not.toContain("data-workjet-project-card-slots");
    expect(markup).toMatch(/data-workjet-project-card-monogram=""[\s\S]*?aria-hidden="true"[^>]*>KN</);
  });

  it("keeps a known value and drops only the unknown one", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewCard
        project={{ key: "instance:x", id: "x", title: "X", local: null, native: true }}
        crew={{ workers: 0, disrupted: 0 }}
        onOpen={() => {}}
      />,
    );
    expect(markup).toContain('data-workjet-project-card-workers="0"');
    expect(markup).not.toContain("data-workjet-project-card-jour-fixe");
    expect(markup).not.toContain("data-workjet-project-card-monogram");
  });

  it("builds the monogram from up to two words", () => {
    expect(projectCardMonogram("Kontor")).toBe("K");
    expect(projectCardMonogram("hafen plan")).toBe("HP");
    expect(projectCardMonogram("greppy.xyz")).toBe("G");
    expect(projectCardMonogram("  ")).toBe("");
  });

  it("labels the weekly meeting by weekday and time", () => {
    expect(projectCardJourFixeLabel({ weekday: 1, time: "09:00" }, "de")).toBe("Mo · 09:00");
    expect(projectCardJourFixeLabel({ weekday: 7, time: "18:15" }, "en")).toBe("Sun · 18:15");
    expect(projectCardJourFixeLabel(null, "de")).toBeNull();
    expect(projectCardJourFixeLabel({ weekday: 9, time: "09:00" }, "de")).toBeNull();
  });

  it("counts the project's workers and the disrupted ones from its own histories", () => {
    const local = {
      id: ProjectId.make("p"),
      title: "P",
      environmentId: EnvironmentId.make("env"),
      updatedAt: "2026-10-15T00:00:00.000Z",
    } as unknown as NonNullable<GalleryProject["local"]>;
    const thread = (
      id: string,
      role: "supervisor" | "worker",
      status: string | null,
      extra: Record<string, unknown> = {},
    ) =>
      ({
        id,
        environmentId: "env",
        projectId: "p",
        archivedAt: null,
        deletedAt: null,
        workjetConfig: { schemaVersion: 2, team: { role } },
        session: status === null ? null : { status },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        ...extra,
      }) as unknown as EnvironmentThreadShell;
    const threads = [
      thread("supervisor", "supervisor", "ready"),
      // Running with a fresh sign of life; without one it counts as stuck (disrupted).
      thread("busy", "worker", "running", { updatedAt: new Date().toISOString() }),
      thread("broken", "worker", "error"),
      thread("done", "worker", "ready"),
      thread("other", "worker", "running", { projectId: "q" }),
      thread("archived", "worker", "running", { archivedAt: "2026-10-01T00:00:00.000Z" }),
    ];
    expect(projectCardCrew(local, threads)).toEqual({ workers: 3, disrupted: 1 });
    expect(projectCardCrew(null, threads)).toBeNull();
  });
});
