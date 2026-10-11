import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  DEFAULT_MODEL,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  EnvironmentId,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationThread,
} from "@workjet/contracts";
import {
  supervisorTickSituation,
  supervisorPullRequestState,
  minutesUntilRegularMeeting,
  type SupervisorPullRequest,
} from "./supervisorTickSituation.ts";
import { supervisorTickPrompt } from "./supervisorTickPrompt.ts";

const now = Date.parse("2026-10-11T10:00:00Z");
const projectId = ProjectId.make("project");
const base: OrchestrationThread = {
  id: ThreadId.make("persistent"),
  projectId,
  title: "Worker",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  workjetConfig: {
    ...DEFAULT_WORKJET_THREAD_CONFIG,
    team: {
      role: "specialist",
      projectId,
      threadId: ThreadId.make("persistent"),
      parentThreadId: ThreadId.make("supervisor"),
      domain: "repairs",
      goal: "Repair startup",
      createdAt: "2026-10-11T08:00:00Z",
    },
    goal: {
      objective: "Repair startup",
      status: "blocked",
      revision: 1,
      continuationCount: 1,
      lastCompletedTurnId: null,
      pendingContinuation: null,
      reason: "Need repository access",
      updatedAt: "2026-10-11T09:15:00Z",
      kanban: {
        goalRevision: 1,
        iteration: 1,
        updatedAt: "2026-10-11T09:15:00Z",
        cards: [{ id: "repair", title: "Repair startup", status: "blocked" }],
      },
    },
  },
  branch: "workjet/repair",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-10-11T08:00:00Z",
  updatedAt: "2026-10-11T09:15:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
const pr: SupervisorPullRequest = {
  number: 12,
  title: "Repair startup",
  url: "https://github.com/owner/repo/pull/12",
  headRefName: "workjet/repair",
  createdAt: "2026-10-10T10:00:00Z",
  updatedAt: "2026-10-11T08:00:00Z",
  isDraft: false,
  author: { login: "worker" },
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
};
describe("supervisor situation", () => {
  it("contains scoped persistent and one-shot workers, PR owner/age/CI, escalations and errors since control", () => {
    const snapshot = JSON.parse(
      supervisorTickSituation({
        project: {
          id: projectId,
          title: "Control",
          workspaceRoot: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: base.createdAt,
          updatedAt: base.updatedAt,
          deletedAt: null,
        },
        threads: [
          base,
          {
            ...base,
            id: ThreadId.make("one-shot"),
            workjetConfig: {
              ...DEFAULT_WORKJET_THREAD_CONFIG,
              role: "worker",
              parent: {
                environmentId: EnvironmentId.make("local"),
                threadId: ThreadId.make("supervisor"),
              },
            },
            session: null,
          },
        ],
        since: "2026-10-11T09:00:00Z",
        now,
        pullRequests: [pr, { ...pr, number: 13, statusCheckRollup: [{ conclusion: "FAILURE" }] }],
        sourceErrors: [],
        meetingMinutes: 60,
        errors: [
          {
            threadId: base.id,
            kind: "provider.timeout",
            summary: "Provider timed out",
            createdAt: base.updatedAt,
          },
        ],
        escalations: [{ threadId: base.id, decisionKey: "repo-access", createdAtMs: now }],
        changes: [{ threadId: base.id, occurredAt: base.updatedAt }],
      }),
    );
    expect(snapshot.persistentWorkers[0]).toMatchObject({
      status: "blocked",
      goal: "Repair startup",
      kanbanChangedSinceControl: true,
    });
    expect(snapshot.oneShotWorkers).toHaveLength(1);
    expect(snapshot.pullRequests[0]).toMatchObject({
      workerThread: "persistent",
      ageMinutes: 1440,
      readyUnmerged: true,
    });
    expect(snapshot.pullRequests[1]).toMatchObject({ ci: "red", redWithoutMovement: true });
    expect(snapshot.errorsAndTimeouts[0].kind).toBe("provider.timeout");
    expect(snapshot.escalations[0].decisionKey).toBe("repo-access");
    expect(snapshot.tokenBudget).toBeNull();
    expect(snapshot.minutesUntilNextRegularMeeting).toBe(60);
  });
  it("keeps large rounds compact with valid JSON and every source category", () => {
    const text = supervisorTickSituation({
      project: {
        id: projectId,
        title: "Control",
        workspaceRoot: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        deletedAt: null,
      },
      threads: Array.from({ length: 500 }, (_, index) => ({
        ...base,
        id: ThreadId.make("worker-" + index),
      })),
      since: base.createdAt,
      now,
      pullRequests: Array.from({ length: 100 }, () => pr),
      sourceErrors: [],
      meetingMinutes: 60,
      changes: [],
      escalations: [],
      errors: [
        {
          threadId: base.id,
          kind: "provider.timeout",
          summary: "Timed out",
          createdAt: base.updatedAt,
        },
      ],
    });
    expect(text.length).toBeLessThanOrEqual(62000);
    const snapshot = JSON.parse(text);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.persistentWorkers.length).toBeGreaterThan(0);
    expect(snapshot.pullRequests.length).toBeGreaterThan(0);
    expect(snapshot.errorsAndTimeouts[0].kind).toBe("provider.timeout");
    expect(snapshot.collectedCounts.workers).toBe(500);
  });
  it("does not treat unknown or pending checks as green", () => {
    expect(supervisorPullRequestState({ ...pr, statusCheckRollup: null }).ready).toBe(false);
    expect(
      supervisorPullRequestState({
        ...pr,
        statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
      }).ready,
    ).toBe(false);
    expect(supervisorPullRequestState({ ...pr, isDraft: true }).ready).toBe(false);
  });
  it("uses configured meeting timezone, including the daylight-saving transition", () => {
    expect(
      minutesUntilRegularMeeting(
        { weekday: 1, time: "13:00", timezone: "Europe/Berlin" },
        Date.parse("2026-10-11T10:00:00Z"),
      ),
    ).toBe(1500);
    expect(
      minutesUntilRegularMeeting(
        { weekday: 7, time: "13:00", timezone: "Europe/Berlin" },
        Date.parse("2026-10-25T11:00:00Z"),
      ),
    ).toBe(60);
    expect(minutesUntilRegularMeeting(null, now)).toBeNull();
  });
  it("instructs the supervisor to handle repairs, merges under project rules, meetings and a short log", () => {
    const text = supervisorTickPrompt("measured state");
    for (const word of [
      "Kontrollrunde",
      "Blocker",
      "Persistent Worker",
      "Projektregeln",
      "Regeltermin",
      "Owner-Entscheidungen",
      "Protokoll",
      "measured state",
    ])
      expect(text).toContain(word);
  });
});
