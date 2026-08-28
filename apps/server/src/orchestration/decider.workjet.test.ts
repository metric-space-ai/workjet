import {
  CommandId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type WorkjetThreadConfig,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

const readModel: OrchestrationReadModel = {
  snapshotSequence: 1,
  projects: [
    {
      id: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      faviconPath: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
};

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
    threadId: THREAD_ID,
  },
  managedInstructions: "Implement the assigned slice.",
  enabledCapabilityIds: ["greppy"],
} as const satisfies WorkjetThreadConfig;

it.layer(NodeServices.layer)("Workjet thread configuration decider", (it) => {
  it.effect("copies an explicit orchestrator configuration into thread.created", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create-orchestrator"),
          threadId: ThreadId.make("thread-orchestrator"),
          projectId: PROJECT_ID,
          title: "Orchestrator",
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "plan",
          workjetConfig: orchestratorConfig,
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        },
        readModel,
      });

      expect(Array.isArray(result)).toBe(false);
      const event = result as Omit<
        Extract<OrchestrationEvent, { type: "thread.created" }>,
        "sequence"
      >;
      expect(event.type).toBe("thread.created");
      if (event.type === "thread.created") {
        expect(event.payload.workjetConfig).toEqual(orchestratorConfig);
      }
    }),
  );

  it.effect("emits exactly one replace-all event for an explicit worker configuration", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.workjet-config.set",
          commandId: CommandId.make("cmd-set-worker"),
          threadId: THREAD_ID,
          workjetConfig: workerConfig,
          createdAt: NOW,
        },
        readModel,
      });

      expect(Array.isArray(result)).toBe(false);
      const event = result as Omit<
        Extract<OrchestrationEvent, { type: "thread.workjet-config-set" }>,
        "sequence"
      >;
      expect(event.type).toBe("thread.workjet-config-set");
      if (event.type === "thread.workjet-config-set") {
        expect(event.payload).toEqual({
          threadId: THREAD_ID,
          workjetConfig: workerConfig,
          updatedAt: event.occurredAt,
        });
      }
    }),
  );

  it.effect("rejects configuration changes for a missing thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.workjet-config.set",
          commandId: CommandId.make("cmd-set-missing"),
          threadId: ThreadId.make("thread-missing"),
          workjetConfig: orchestratorConfig,
          createdAt: NOW,
        },
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
