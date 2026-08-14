import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type WorkjetThreadConfig,
} from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const CREATED_AT = "2026-08-14T12:00:00.000Z";
const UPDATED_AT = "2026-08-14T13:00:00.000Z";

const orchestratorConfig = {
  schemaVersion: 1,
  role: "orchestrator",
  parent: null,
  managedInstructions: "Coordinate the implementation.",
  enabledCapabilityIds: ["greppy", "web-search"],
} as const satisfies WorkjetThreadConfig;

const workerConfig = {
  schemaVersion: 1,
  role: "worker",
  parent: {
    environmentId: EnvironmentId.make("environment-parent"),
    threadId: ThreadId.make("thread-parent"),
  },
  managedInstructions: "Implement the assigned reducer slice.",
  enabledCapabilityIds: ["web-search"],
} as const satisfies WorkjetThreadConfig;

const baseThread: OrchestrationThread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Workjet thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  workjetConfig: orchestratorConfig,
  branch: "feature/workjet",
  worktreePath: "/repo/worktrees/workjet",
  latestTurn: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  archivedAt: null,
  settledOverride: "active",
  settledAt: null,
  snoozedUntil: "2026-08-15T12:00:00.000Z",
  snoozedAt: "2026-08-14T12:30:00.000Z",
  pinnedAt: "2026-08-14T12:45:00.000Z",
  pinOrderKey: "a0",
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const eventBase = {
  eventId: EventId.make("event-workjet"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  aggregateKind: "thread",
} as const;

describe("applyThreadDetailEvent Workjet configuration", () => {
  it("preserves an explicit orchestrator configuration from thread.created", () => {
    const event = {
      ...eventBase,
      sequence: 1,
      aggregateId: ThreadId.make("thread-created"),
      occurredAt: CREATED_AT,
      type: "thread.created",
      payload: {
        threadId: ThreadId.make("thread-created"),
        projectId: PROJECT_ID,
        title: "Orchestrator thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workjetConfig: orchestratorConfig,
        branch: null,
        worktreePath: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    } as const satisfies OrchestrationEvent;

    const result = applyThreadDetailEvent(baseThread, event);

    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.thread.workjetConfig).toEqual(orchestratorConfig);
    }
  });

  it("fully replaces configuration while preserving unrelated fields and replay value", () => {
    const event = {
      ...eventBase,
      sequence: 2,
      aggregateId: THREAD_ID,
      occurredAt: UPDATED_AT,
      type: "thread.workjet-config-set",
      payload: {
        threadId: THREAD_ID,
        workjetConfig: workerConfig,
        updatedAt: UPDATED_AT,
      },
    } as const satisfies OrchestrationEvent;

    const first = applyThreadDetailEvent(baseThread, event);

    expect(first.kind).toBe("updated");
    if (first.kind !== "updated") {
      return;
    }

    expect(first.thread).toEqual({
      ...baseThread,
      workjetConfig: workerConfig,
      updatedAt: UPDATED_AT,
    });
    expect(first.thread.workjetConfig).toEqual(workerConfig);

    const replay = applyThreadDetailEvent(first.thread, event);
    expect(replay).toEqual(first);
  });
});
