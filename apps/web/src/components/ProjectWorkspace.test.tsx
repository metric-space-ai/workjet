import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkjetJourFixeMeeting,
  ApprovalRequestId,
} from "@workjet/contracts";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import fixture from "../../../../packages/contracts/src/workjetJourFixeMeeting.fixture.json" with { type: "json" };
import { ProjectWorkspace } from "./ProjectWorkspace";
import { ProjectOverviewView } from "./ProjectOverviewView";
import { ProjectOverviewQuestion } from "./ProjectOverviewDecisions";
import {
  buildProjectOwnerOverview,
  isRunningProjectOneShot,
  projectOverviewWorkerState,
} from "../projectOverviewModel";
import { projectOverviewLanguage } from "../projectOverviewText";
import type { GalleryProject } from "../projectOverview";

const source = EnvironmentId.make("desktop");
const target = EnvironmentId.make("gpu3");
const projectId = ProjectId.make("real-project");
const parentId = ThreadId.make("supervisor");
const createdAt = "2026-10-07T00:00:00Z";
const project: GalleryProject = {
  key: "native:real-project",
  id: projectId,
  title: "Remote project",
  native: true,
  local: {
    id: projectId,
    environmentId: source,
    title: "Remote project",
    updatedAt: createdAt,
    overview: null,
    ctoxRegistration: null,
    faviconPath: null,
  },
};
function shell(
  environmentId: EnvironmentId,
  role: "supervisor" | "specialist" | "worker",
  archivedAt: string | null = null,
): EnvironmentThreadShell {
  const id = role === "supervisor" ? parentId : ThreadId.make(role + "-thread");
  return {
    id,
    environmentId,
    projectId,
    title:
      role === "worker"
        ? "Build on gpu3"
        : role === "specialist"
          ? "Measurements"
          : "Source supervisor",
    branch: role === "worker" ? "codex/remote-work" : null,
    worktreePath: null,
    archivedAt,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
    pinnedAt: null,
    snoozedUntil: null,
    session: null,
    latestTurn: null,
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      role: role === "worker" ? "worker" : "orchestrator",
      parent: role === "worker" ? { environmentId: source, threadId: parentId } : null,
      team: {
        role,
        projectId,
        threadId: id,
        parentThreadId: role === "supervisor" ? null : parentId,
        packageId: "one-pr",
        goal: "Verify the measured fracture cases.",
        createdAt,
      },
    },
  } as unknown as EnvironmentThreadShell;
}
const supervisor = shell(source, "supervisor");
const specialist = shell(source, "specialist");
const worker = shell(target, "worker");
const native = Schema.decodeUnknownSync(WorkjetJourFixeMeeting)(
  fixture.valid_cases.find((item) => item.type === "Meeting")!.value,
);
const meeting = {
  ...native,
  project_id: project.id,
  scheduled_at_ms: Date.parse(createdAt),
  state: "confirmed" as const,
  todos: { ...native.todos!, status: "confirmed" as const, confirmed_at_ms: Date.parse(createdAt) },
};
const overview = (
  threads: readonly EnvironmentThreadShell[],
  extra: Partial<Parameters<typeof buildProjectOwnerOverview>[0]> = {},
) => buildProjectOwnerOverview({ project, threads, language: "de", ...extra });
const markup = (threads: readonly EnvironmentThreadShell[], language: "de" | "en" = "de") =>
  renderToStaticMarkup(
    <ProjectOverviewView
      data={overview(threads, { language })}
      onOpenChat={() => {}}
      onOpenJourFixe={() => {}}
    />,
  );

describe("owner project overview", () => {
  it("renders exactly four honest KPIs and explains unavailable values without zero placeholders", () => {
    const data = overview([supervisor, specialist]);
    expect(data.kpis).toHaveLength(4);
    expect(data.kpis.every((kpi) => kpi.value === null)).toBe(true);
    expect(data.kpis.find((kpi) => kpi.id === "tasks")?.explanation).toContain("Erledigungsstand");
    const html = markup([supervisor, specialist]);
    expect(html).not.toContain("Sessions");
    expect(html).not.toContain("Latency");
    expect(html).not.toContain(">—<");
  });
  it("uses confirmed to-dos before persistent goals without inventing completion", () => {
    const data = overview([supervisor, specialist], { meeting });
    expect(data.confirmed).toBe(true);
    expect(data.goals.map((goal) => goal.title)).toEqual(
      meeting.todos.items.map((item) => item.title),
    );
    expect(data.goals.every((goal) => goal.state === data.text.unknown)).toBe(true);
    expect(data.kpis.find((kpi) => kpi.id === "tasks")?.value).toBeNull();
  });
  it("rejects another project's meeting and keeps saved persistent goals", () => {
    const data = overview([supervisor, specialist], {
      meeting: { ...meeting, project_id: "foreign-project" },
    });
    expect(data.confirmed).toBe(false);
    expect(data.lastMeeting).toBeNull();
    expect(data.goals[0]?.title).toBe("Verify the measured fracture cases.");
  });
  it("does not present a future meeting as a completed last meeting", () => {
    expect(
      overview([supervisor], { meeting: { ...meeting, scheduled_at_ms: Date.now() + 86_400_000 } })
        .lastMeeting,
    ).toBeNull();
  });
  it("requires merge timestamps and a past Jour fixe for the PR-period KPI", () => {
    const pr = {
      url: "https://github.com/metric-space-ai/workjet/pull/207",
      number: 207,
      title: "Measured result",
      state: "merged" as const,
    };
    expect(overview([supervisor], { meeting, pullRequests: [pr] }).kpis[1]?.value).toBeNull();
    expect(
      overview([supervisor], {
        meeting,
        pullRequests: [{ ...pr, mergedAt: "2026-10-08T00:00:00Z" }],
      }).kpis[1]?.value,
    ).toBe("1");
    expect(overview([supervisor], { meeting }).kpis[1]?.value).toBeNull();
  });
  it("keeps confirmed merges separate from closed proposals", () => {
    const data = overview([supervisor], {
      pullRequests: [
        {
          url: "https://github.com/metric-space-ai/workjet/pull/207",
          number: 207,
          title: "E5",
          state: "merged",
        },
        {
          url: "https://github.com/metric-space-ai/workjet/pull/208",
          number: 208,
          title: "Abandoned",
          state: "closed",
        },
      ],
    });
    expect(data.merged.map((pr) => pr.number)).toEqual([207]);
  });
  it("keeps only running one-shots in the active project team, preserving idle workers for archive", () => {
    const running = { ...worker, backgroundLiveness: "working" as const };
    expect(isRunningProjectOneShot(worker)).toBe(false);
    expect(isRunningProjectOneShot(running)).toBe(true);
    expect(overview([supervisor, running]).workers).toEqual([running]);
    expect(overview([supervisor, worker]).workers).toEqual([]);
    expect(overview([supervisor, worker]).all).toContain(worker);
    expect(overview([worker]).all).toEqual([]);
  });
  it("uses status words for pending questions, errors, running and waiting workers", () => {
    expect(projectOverviewWorkerState(worker)).toBe("waiting");
    expect(projectOverviewWorkerState({ ...worker, hasPendingUserInput: true })).toBe("asks");
    expect(
      projectOverviewWorkerState({
        ...worker,
        session: { ...supervisor.session!, status: "error" },
      }),
    ).toBe("disrupted");
    expect(projectOverviewWorkerState({ ...worker, backgroundLiveness: "working" })).toBe(
      "running",
    );
  });
  it("keeps technical configuration and prompts inside collapsed diagnosis", () => {
    const html = markup([supervisor, specialist]);
    const diagnosis = html.indexOf('data-workjet-overview-section="diagnosis"');
    expect(html.slice(0, diagnosis)).not.toContain("gpt-6.1-sol");
    expect(html.slice(diagnosis)).toContain("gpt-6.1-sol");
    expect(html).not.toContain("<details open");
    expect(html).toContain("noch nicht verfügbar");
  });
  it("keeps the native supervisor route unknown rather than substituting its local thread model", () => {
    expect(markup([supervisor])).not.toContain("gpt-6.1-sol");
  });
  it("follows the mock's section order and translates all overview navigation in both languages", () => {
    for (const language of ["de", "en"] as const) {
      const html = markup([supervisor], language);
      const positions = ["decisions", "goals", "results", "history", "diagnosis"].map((section) =>
        html.indexOf('data-workjet-overview-section="' + section + '"'),
      );
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(html).toContain(language === "de" ? "Braucht dich" : "Needs you");
      expect(html).not.toContain(language === "de" ? "Open decisions" : "Braucht dich");
      expect(html).toContain('lang="' + language + '"');
    }
  });
  it("offers the real Jour fixe action even if its schedule is not available", () => {
    expect(markup([supervisor])).toContain("Jour fixe beitreten");
    expect(markup([supervisor])).toContain("noch nicht verfügbar");
  });
  it("shows the actual pending question and its answer choices", () => {
    const html = renderToStaticMarkup(
      <ProjectOverviewQuestion
        language="de"
        pending={{
          requestId: ApprovalRequestId.make("question"),
          createdAt,
          questions: [
            {
              id: "boundary",
              header: "Scope",
              question: "Soll die Zeitintegration vor dem Bruchmodell geprüft werden?",
              options: [
                { label: "Zeitintegration zuerst", description: "Priorisiert die Integration." },
              ],
              multiSelect: false,
            },
          ],
        }}
        onAnswer={async () => true}
      />,
    );
    expect(html).toContain("Soll die Zeitintegration");
    expect(html).toContain("Zeitintegration zuerst");
    expect(html).toContain("Antworten");
    expect(html).not.toContain("request_user_input");
  });
  it("preserves the connected overview entry and localized Jour fixe action", () => {
    const html = renderToStaticMarkup(
      <ProjectWorkspace
        project={project}
        threads={[supervisor]}
        onOpenChat={() => {}}
        onOpenJourFixe={() => {}}
        onAddParent={async () => true}
      />,
    );
    expect(html).toContain('data-workjet-project-overview="real-project"');
    expect(html).toContain("Jour fixe beitreten");
  });
  it("resolves the saved UI setting before the browser language", () => {
    expect(projectOverviewLanguage("de", "en-US")).toBe("de");
    expect(projectOverviewLanguage("en", "de-DE")).toBe("en");
    expect(projectOverviewLanguage("system", "de-DE")).toBe("de");
  });
});
