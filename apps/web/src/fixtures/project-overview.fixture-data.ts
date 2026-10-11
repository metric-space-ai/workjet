import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkjetJourFixeMeeting,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import meetingFixture from "../../../../packages/contracts/src/workjetJourFixeMeeting.fixture.json" with { type: "json" };
import type { GalleryProject } from "../projectOverview";
import { exitModelFixture } from "../test/exitModelFixture";
import type { buildProjectOwnerOverview } from "../projectOverviewModel";

export type OverviewFixtureVariant = "empty" | "molecularity" | "full";
const projectId = ProjectId.make("overview-fixture");
const environmentId = EnvironmentId.make("overview-fixture-local");
const now = Date.parse("2026-10-11T17:00:00Z");
const completedMeeting = Schema.decodeUnknownSync(WorkjetJourFixeMeeting)(
  meetingFixture.valid_cases.find((item) => item.type === "Meeting")!.value,
);
function thread(
  id: string,
  name: string,
  role: "supervisor" | "specialist" | "worker",
  state: "waiting" | "running" | "disrupted" | "asks" | "completed" | "escalation",
): EnvironmentThreadShell {
  const createdAt = id === "pinball" ? "2026-09-02T05:44:00Z" : "2026-10-10T14:05:00Z";
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title: name,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    archivedAt: null,
    branch: null,
    worktreePath: null,
    modelSelection: { instanceId: "", model: "" },
    session:
      state === "disrupted"
        ? { status: "error", lastError: "Build failed" }
        : state === "running"
          ? { status: "running" }
          : null,
    latestTurn:
      state === "completed" ? { state: "completed", completedAt: "2026-10-11T16:00:00Z" } : null,
    hasPendingApprovals: false,
    hasPendingUserInput: state === "asks",
    waitingOnSupervisor: state === "escalation",
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      role: role === "worker" ? "worker" : "orchestrator",
      parent: role === "worker" ? { environmentId, threadId: ThreadId.make("supervisor") } : null,
      team: {
        role,
        projectId,
        threadId: ThreadId.make(id),
        parentThreadId: role === "supervisor" ? null : ThreadId.make("supervisor"),
        packageId: id,
        goal:
          id === "pinball"
            ? "Develop the Molecularity Pinball World engine."
            : id === "reference"
              ? "Molecularity auf gpu3 baubar und lauffähig machen."
              : "XPBD gegen explizite Zentral-Differenzen prüfen, dann Bruch.",
        createdAt,
      },
      goal: {
        objective:
          id === "pinball"
            ? "Develop the Molecularity Pinball World engine."
            : id === "reference"
              ? "Molecularity auf gpu3 baubar und lauffähig machen."
              : "XPBD gegen explizite Zentral-Differenzen prüfen, dann Bruch.",
        status: state === "completed" ? "complete" : state === "disrupted" ? "blocked" : "active",
        revision: 1,
        continuationCount: 0,
        lastCompletedTurnId: null,
        pendingContinuation: null,
        reason: null,
        updatedAt: createdAt,
      },
      ...(role === "supervisor"
        ? {
            supervisorTick: {
              lastTickAt: new Date(Date.now() - 6 * 60_000).toISOString(),
              lastControlAt: new Date(Date.now() - 6 * 60_000).toISOString(),
              outcome: "started",
            },
          }
        : {}),
    },
  } as unknown as EnvironmentThreadShell;
}
export function overviewFixture(
  variant: OverviewFixtureVariant,
): Parameters<typeof buildProjectOwnerOverview>[0] {
  const project: GalleryProject = {
    id: projectId,
    key: "fixture:" + projectId,
    title: "Molecularity",
    native: true,
    local: {
      id: projectId,
      environmentId,
      title: "Molecularity",
      updatedAt: "2026-10-11T17:00:00Z",
      ctoxRegistration: null,
      overview:
        variant === "full"
          ? {
              websiteUrl: null,
              slots: [
                { kind: "metric", label: "Messfälle grün", value: 4, unit: "von 5" },
                null,
                null,
              ],
            }
          : null,
    },
    configuration: {
      id: projectId,
      title: "Molecularity",
      jourFixe: { weekday: 3, time: "13:00", timezone: "Europe/Berlin" },
      repoUrl: "https://github.com/metric-space-ai/molecularity",
      ...(variant === "full"
        ? {
            info: { summary: "Referenzlöser validiert; Pinball-Build benötigt eine Korrektur." },
            exitModel: { ...exitModelFixture, project_id: projectId },
          }
        : {}),
    },
  };
  if (variant === "empty") return { project, threads: [], language: "de", now };
  const threads = [
    thread(
      "supervisor",
      "Project supervisor",
      "supervisor",
      variant === "full" ? "asks" : "waiting",
    ),
    thread("pinball", "Molecularity Pinball World Engine", "specialist", "disrupted"),
    thread(
      "reference",
      "Molecularity · Rechenweg & Referenzlöser (Codex)",
      "specialist",
      variant === "full" ? "completed" : "waiting",
    ),
    thread(
      "fracture",
      "Molecularity · Zeitintegration & Bruch (Grok)",
      "specialist",
      variant === "full" ? "running" : "waiting",
    ),
  ];
  if (variant === "full")
    threads.push(
      thread("review", "Molecularity · Review", "specialist", "asks"),
      thread("queue", "Molecularity · Queue", "specialist", "waiting"),
      thread("escalation", "Molecularity · PR worker", "worker", "escalation"),
    );
  return {
    project,
    threads,
    language: "de",
    now,
    ...(variant === "full"
      ? {
          openTaskCount: 4,
          meeting: {
            ...completedMeeting,
            project_id: projectId,
            scheduled_at_ms: Date.parse("2026-10-07T11:00:00Z"),
            state: "confirmed",
            todos: null,
          },
          projectTokenBudgetSource: { consumedTokens: 1_800_000_000, limitBillions: 2.3 },
          pullRequests: [
            {
              number: 42,
              title: "Referenzlöser validiert",
              url: "https://github.com/metric-space-ai/molecularity/pull/42",
              state: "merged",
              mergedAt: "2026-10-11T16:10:00Z",
            },
          ],
        }
      : {}),
  };
}
