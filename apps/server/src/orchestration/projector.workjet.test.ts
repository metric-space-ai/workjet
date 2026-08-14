import {
  CommandId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type WorkjetThreadConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:00:01.000Z";

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
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
  },
  managedInstructions: "Implement the assigned slice.",
  enabledCapabilityIds: ["greppy"],
} as const satisfies WorkjetThreadConfig;

function makeThreadEvent(
  sequence: number,
  type: OrchestrationEvent["type"],
  threadId: string,
  occurredAt: string,
  payload: unknown,
): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make(threadId),
    occurredAt,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: payload as never,
  } as OrchestrationEvent;
}

function createdPayload(threadId: string, title: string, workjetConfig?: WorkjetThreadConfig) {
  return {
    threadId,
    projectId: ProjectId.make("project-1"),
    title,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    ...(workjetConfig === undefined ? {} : { workjetConfig }),
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("Workjet thread configuration projector", () => {
  it("materializes an explicit orchestrator configuration on thread.created", async () => {
    const projected = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(NOW),
        makeThreadEvent(
          1,
          "thread.created",
          "thread-1",
          NOW,
          createdPayload("thread-1", "Orchestrator", orchestratorConfig),
        ),
      ),
    );

    expect(projected.threads[0]?.workjetConfig).toEqual(orchestratorConfig);
  });

  it("uses the canonical default for historical thread.created events", async () => {
    const projected = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(NOW),
        makeThreadEvent(
          1,
          "thread.created",
          "thread-1",
          NOW,
          createdPayload("thread-1", "Legacy thread"),
        ),
      ),
    );

    expect(projected.threads[0]?.workjetConfig).toEqual(DEFAULT_WORKJET_THREAD_CONFIG);
  });

  it("replaces the whole configuration and leaves unrelated threads and fields unchanged", async () => {
    const withFirst = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(NOW),
        makeThreadEvent(
          1,
          "thread.created",
          "thread-1",
          NOW,
          createdPayload("thread-1", "Target", orchestratorConfig),
        ),
      ),
    );
    const before = await Effect.runPromise(
      projectEvent(
        withFirst,
        makeThreadEvent(
          2,
          "thread.created",
          "thread-2",
          NOW,
          createdPayload("thread-2", "Unrelated", DEFAULT_WORKJET_THREAD_CONFIG),
        ),
      ),
    );
    const targetBefore = before.threads[0];
    const unrelatedBefore = before.threads[1];

    const projected = await Effect.runPromise(
      projectEvent(
        before,
        makeThreadEvent(3, "thread.workjet-config-set", "thread-1", LATER, {
          threadId: ThreadId.make("thread-1"),
          workjetConfig: workerConfig,
          updatedAt: LATER,
        }),
      ),
    );

    expect(projected.threads[0]).toEqual({
      ...targetBefore,
      workjetConfig: workerConfig,
      updatedAt: LATER,
    });
    expect(projected.threads[1]).toEqual(unrelatedBefore);
    expect(projected.threads[0]?.workjetConfig).not.toHaveProperty("role", "orchestrator");
  });
});
