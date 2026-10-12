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
  projectGoalSentence,
  projectOverviewWorkerState,
} from "../projectOverviewModel";
import { projectOverviewLanguage, readSystemLanguages } from "../projectOverviewText";
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
  it("shows only Supervisor escalations in Needs you and marks workers waiting for Supervisor", () => {
    const waiting = { ...specialist, waitingOnSupervisor: true, hasPendingUserInput: false };
    const escalation = { ...supervisor, hasPendingUserInput: true };
    expect(
      overview([escalation, waiting, { ...worker, hasPendingApprovals: true }]).decisions,
    ).toEqual([escalation]);
    expect(projectOverviewWorkerState(waiting)).toBe("waitingSupervisor");
    expect(markup([supervisor, waiting])).toContain("wartet auf Supervisor");
  });
  it("keeps an inactive one-shot's old failure out of the project's current disruptions", () => {
    const failedWorker = {
      ...worker,
      session: { ...worker.session, status: "error" },
    } as EnvironmentThreadShell;
    expect(overview([supervisor, failedWorker]).disruptions).toEqual([]);
    expect(overview([supervisor, failedWorker]).all).toContain(failedWorker);
    const failedParent = {
      ...specialist,
      session: { ...specialist.session, status: "error" },
    } as EnvironmentThreadShell;
    expect(overview([supervisor, failedParent]).disruptions).toEqual([failedParent]);
  });
  it("does not attribute the supervisor's Luma or the control computer to a native specialist", () => {
    const crew = {
      ...specialist,
      workjetConfig: {
        ...specialist.workjetConfig,
        ctoxCrewChat: {},
      },
    } as unknown as EnvironmentThreadShell;
    const data = { ...overview([crew]), supervisorLumaId: "supervisor-identity" };
    const html = renderToStaticMarkup(<ProjectOverviewView data={data} onOpenChat={() => {}} />);
    expect(html).not.toContain("supervisor-identity");
    expect(html).not.toContain("controlEnvironmentId");
    expect(html).not.toMatch(/>desktop</u);
  });
  it("labels stale native KPI values instead of implying a current measurement", () => {
    const kpis = {
      project_id: project.id,
      revision: 1,
      items: [
        {
          prompt: { kpi_id: "green-cases", prompt: "Count verified cases", revision: 1 },
          result: {
            status: "stale" as const,
            snapshot: {
              project_id: project.id,
              kpi_id: "green-cases",
              prompt_revision: 1,
              label: "Messfälle grün",
              display_value: "0 von 5",
              unit: "",
              sources: [
                {
                  kind: "github_metric" as const,
                  project_id: project.id,
                  connection_id: "github",
                  metric_key: "verified.cases",
                },
              ],
              freshness: {
                calculated_at_ms: 1791399600000,
                refresh_at_ms: 1791400200000,
                fresh_until_ms: 1791400800000,
              },
            },
          },
        },
      ],
    };
    expect(overview([], { kpis }).kpis[0]).toMatchObject({
      value: "0 von 5",
      note: "veraltet",
    });
    expect(overview([], { kpis, language: "en" }).kpis[0]?.note).toContain("out of date");
  });
  it("keeps the goal sentence separate from handoff paths and technical directions", () => {
    expect(
      projectGoalSentence(
        "1) Molecularity auf gpu3 baubar machen (Linux, Vulkan 1.4; glslc fehlt). Ergebnisse als PRs.",
      ),
    ).toBe("Molecularity auf gpu3 baubar machen.");
    expect(
      projectGoalSentence(
        "Übergabe docs/HANDOFF.md, Aufgaben 2 und 4: XPBD gegen Zentral-Differenzen vergleichen (V2/V4), dann Bruch xpbd1_fracture_v1.rs prüfen. Ergebnisse als PRs.",
      ),
    ).toBe("XPBD gegen Zentral-Differenzen vergleichen, dann Bruch prüfen.");
    if (specialist.workjetConfig.schemaVersion !== 2)
      throw new Error("Expected current worker config");
    const full = "Molecularity bauen (glslc fehlt).";
    const thread = {
      ...specialist,
      workjetConfig: {
        ...specialist.workjetConfig,
        team: { ...specialist.workjetConfig.team!, goal: full },
      },
    } as EnvironmentThreadShell;
    const html = markup([supervisor, thread]);
    expect(overview([thread]).goals[0]?.title).toBe("Molecularity bauen.");
    expect(html).toContain("Molecularity bauen.");
    expect(html).not.toContain(full);
  });
  it("counts durable goal statuses without treating completed turns as completed goals", () => {
    const goal = {
      objective: "Verify the fracture cases.",
      status: "active" as const,
      revision: 1,
      continuationCount: 0,
      lastCompletedTurnId: null,
      pendingContinuation: null,
      reason: null,
      updatedAt: createdAt,
    };
    const withGoal = {
      ...specialist,
      workjetConfig: { ...specialist.workjetConfig, goal },
    } as EnvironmentThreadShell;
    expect(overview([supervisor, withGoal]).kpis[2]?.value).toBe("1");
    const complete = {
      ...withGoal,
      workjetConfig: { ...withGoal.workjetConfig, goal: { ...goal, status: "complete" as const } },
    } as EnvironmentThreadShell;
    expect(overview([supervisor, complete]).kpis[2]?.value).toBe("0");
    expect(overview([supervisor, complete]).goals[0]?.state).toBe("erledigt");
    expect(overview([supervisor, withGoal, specialist]).kpis[2]?.value).toBe("—");
  });
  it("keeps an active one-shot that is waiting for its owner's answer", () => {
    expect(isRunningProjectOneShot({ ...worker, hasPendingUserInput: true })).toBe(true);
  });

  it("renders five KPI tiles that always show a value or a dash, never an explanation", () => {
    const data = overview([supervisor, specialist]);
    expect(data.kpis).toHaveLength(5);
    expect(data.kpis.every((kpi) => kpi.value === "—")).toBe(true);
    expect(data.kpis.find((kpi) => kpi.id === "tokens")?.label).toBe("Token-Budget");
    expect(data.kpis.every((kpi) => !("explanation" in kpi))).toBe(true);
    const html = markup([supervisor, specialist]);
    expect(html).not.toContain("Sessions");
    expect(html).not.toContain("Latency");
    expect(html).toContain(">—<");
    expect(html).not.toMatch(/noch nicht verfügbar|not yet available/iu);
  });
  it("uses confirmed to-dos before persistent goals without inventing completion", () => {
    const data = overview([supervisor, specialist], { meeting });
    expect(data.confirmed).toBe(true);
    expect(data.goals.map((goal) => goal.title)).toEqual(
      meeting.todos.items.map((item) => item.title),
    );
    expect(data.goals.every((goal) => goal.state === data.text.unknown)).toBe(true);
    expect(data.kpis.find((kpi) => kpi.id === "tasks")?.value).toBe("—");
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
    expect(overview([supervisor], { meeting, pullRequests: [pr] }).kpis[1]?.value).toBe("—");
    expect(
      overview([supervisor], {
        meeting,
        pullRequests: [{ ...pr, mergedAt: "2026-10-08T00:00:00Z" }],
      }).kpis[1]?.value,
    ).toBe("1");
    expect(overview([supervisor], { meeting }).kpis[1]?.value).toBe("—");
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
  it("keeps technical configuration and prompts out of the overview (no diagnosis expander)", () => {
    const html = markup([supervisor, specialist]);
    expect(html).not.toContain('data-workjet-overview-section="diagnosis"');
    expect(html).not.toContain("<details");
    expect(html).not.toContain("gpt-6.1-sol");
    expect(html).not.toMatch(/noch nicht verfügbar|not yet available/iu);
    expect(html).not.toContain("Rohdaten");
  });
  it("keeps the native supervisor route unknown rather than substituting its local thread model", () => {
    expect(markup([supervisor])).not.toContain("gpt-6.1-sol");
  });
  it("follows the mock's section order and translates all overview navigation in both languages", () => {
    for (const language of ["de", "en"] as const) {
      const html = markup([supervisor], language);
      const positions = ["kpis", "goals", "results", "history"].map((section) =>
        html.indexOf('data-workjet-overview-section="' + section + '"'),
      );
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(html).not.toContain('data-workjet-overview-section="decisions"');
      expect(html).toContain('lang="' + language + '"');
      const pending = renderToStaticMarkup(
        <ProjectOverviewView
          data={overview([{ ...supervisor, hasPendingApprovals: true } as EnvironmentThreadShell], {
            language,
          })}
          onOpenChat={() => {}}
          decisions={<button type="button">{language === "de" ? "Freigeben" : "Approve"}</button>}
        />,
      );
      expect(pending).toContain(language === "de" ? "Braucht dich" : "Needs you");
      expect(pending).not.toContain(language === "de" ? "Open decisions" : "Braucht dich");
    }
  });
  it("offers the real regular-meeting action even if its schedule is not available", () => {
    expect(markup([supervisor])).toContain("Regeltermin beitreten");
    expect(markup([supervisor])).not.toContain("noch nicht verfügbar");
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
    expect(html).toContain(
      projectOverviewLanguage("system", readSystemLanguages()) === "de"
        ? "Regeltermin beitreten"
        : "Join regular meeting",
    );
  });
  it("resolves the saved UI setting before the browser language", () => {
    expect(projectOverviewLanguage("de", "en-US")).toBe("de");
    expect(projectOverviewLanguage("en", "de-DE")).toBe("en");
    expect(projectOverviewLanguage("system", "de-DE")).toBe("de");
    expect(projectOverviewLanguage("system", "en-US")).toBe("en");
  });
  it("follows the OS preference list for the system setting", () => {
    expect(projectOverviewLanguage("system", ["de-AT", "en-US"])).toBe("de");
    expect(projectOverviewLanguage("system", ["de_CH"])).toBe("de");
    expect(projectOverviewLanguage("system", ["fr-FR", "de-DE"])).toBe("de");
    expect(projectOverviewLanguage("system", ["fr-FR", "es-ES"])).toBe("en");
    expect(projectOverviewLanguage("system", [])).toBe("en");
    expect(projectOverviewLanguage("system", ["EN-gb"])).toBe("en");
  });
});
