import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_WORKJET_THREAD_CONFIG,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkjetConnectionId,
  normalizeWorkjetThreadConfig,
  rotateWorkjetCtoxWorkerSource,
  type OrchestrationReadModel,
  type OrchestrationEvent,
  type WorkjetConnectionSummary,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Stream from "effect/Stream";
import { decideOrchestrationCommand } from "./decider.ts";
import { startCtoxWorkerSourceRotation } from "../workjet/ctox/CtoxWorkerSourceRotation.ts";

const NOW = "2026-10-10T18:29:00.000Z";
const projectId = ProjectId.make("molecularity");
const parentId = ThreadId.make("supervisor");
const childId = ThreadId.make("persistent-worker");
const tenant = "322084e5-8239-48d7-b3c5-c5178fbe5822";
const old: WorkjetConnectionSummary = {
  connectionId: WorkjetConnectionId.make(
    `ctox-dev-worker-source:${tenant}:c1728006-7dcd-4c64-a0b7-e800251eb9a1`,
  ),
  instanceId: "welsch.ctox.dev",
  source: "ctox_dev",
  displayName: "Worker source",
  status: "needs_auth",
  reason: "authentication-required",
};
const ready: WorkjetConnectionSummary = {
  ...old,
  connectionId: WorkjetConnectionId.make(
    `ctox-dev-worker-source:${tenant}:41e130aa-2b02-46fe-953d-37e74a97f05a`,
  ),
  status: "ready",
  reason: null,
};
const journal = {
  intent: {
    instanceId: `managed:${tenant}`,
    projectId,
    threadId: parentId,
    commandId: CommandId.make("parent-native-command"),
    goal: "Coordinate Molecularity",
    createdAt: NOW,
  },
  submission: "confirmed" as const,
  turn: null,
};
const parentConfig = {
  ...normalizeWorkjetThreadConfig(DEFAULT_WORKJET_THREAD_CONFIG),
  role: "standard" as const,
  parent: null,
  team: {
    role: "supervisor" as const,
    threadId: parentId,
    projectId,
    parentThreadId: null,
    goal: "Coordinate Molecularity",
    createdAt: NOW,
  },
  enabledCapabilityIds: ["ctox-business-os"] as const,
  capabilityBindings: [
    {
      capabilityId: "ctox-business-os" as const,
      target: {
        kind: "ctox-connection" as const,
        connectionId: old.connectionId,
        instanceId: old.instanceId,
      },
    },
  ],
  ctoxSupervisorTurn: journal,
  ctoxSupervisorPreviousTurns: [
    { ...journal, intent: { ...journal.intent, commandId: CommandId.make("parent-previous") } },
  ],
};
const childConfig = {
  ...parentConfig,
  role: "orchestrator" as const,
  team: {
    role: "specialist" as const,
    threadId: childId,
    projectId,
    parentThreadId: parentId,
    domain: "Reference solver",
    goal: "Validate the reference solver",
    createdAt: NOW,
  },
};
const thread: OrchestrationReadModel["threads"][number] = {
  id: parentId,
  projectId,
  title: "Supervisor",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
  runtimeMode: "full-access",
  interactionMode: "default",
  workjetConfig: parentConfig,
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
};
function readModel(includeChild = true): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: projectId,
        title: "Molecularity",
        workspaceRoot: "/acceptance/molecularity",
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
      { ...thread },
      ...(includeChild
        ? [{ ...thread, id: childId, title: "Reference solver", workjetConfig: childConfig }]
        : []),
    ],
    updatedAt: NOW,
  };
}
const update = (config: typeof childConfig) => ({
  type: "thread.workjet-config.set" as const,
  commandId: CommandId.make("update-child"),
  threadId: childId,
  workjetConfig: config,
  createdAt: NOW,
});

it.layer(NodeServices.layer)("inherited supervisor journal ownership", (it) => {
  it.effect("rotates installed legacy children through the real serialized decider", () =>
    Effect.gen(function* () {
      let model = readModel();
      const crypto = yield* Crypto.Crypto;
      yield* startCtoxWorkerSourceRotation({
        connections: {
          list: Effect.succeed([old, ready]),
          subscribeChanges: Effect.succeed(Stream.empty),
        },
        threads: Effect.sync(() => model.threads),
        dispatch: (command) =>
          Effect.gen(function* () {
            const result = yield* decideOrchestrationCommand({ command, readModel: model }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.orDie,
            );
            const event = result as Extract<
              OrchestrationEvent,
              { type: "thread.workjet-config-set" }
            >;
            model = {
              ...model,
              snapshotSequence: model.snapshotSequence + 1,
              threads: model.threads.map((entry) =>
                entry.id === event.payload.threadId
                  ? { ...entry, workjetConfig: event.payload.workjetConfig }
                  : entry,
              ),
            };
            return { sequence: model.snapshotSequence };
          }),
      });
      const parent = normalizeWorkjetThreadConfig(model.threads[0]!.workjetConfig);
      const child = normalizeWorkjetThreadConfig(model.threads[1]!.workjetConfig);
      expect(child.capabilityBindings[0]?.target.connectionId).toBe(ready.connectionId);
      expect(child.ctoxSupervisorTurn).toBeUndefined();
      expect(child.ctoxSupervisorPreviousTurns).toBeUndefined();
      expect(child.team).toEqual(childConfig.team);
      expect(parent.ctoxSupervisorTurn).toEqual(journal);
      expect(parent.ctoxSupervisorPreviousTurns).toEqual(parentConfig.ctoxSupervisorPreviousTurns);
    }).pipe(Effect.scoped),
  );

  it.effect("repairs an unrelated settings update retaining the exact copied parent receipt", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: update({ ...childConfig, managedInstructions: "Keep working on the solver" }),
      });
      const event = result as Extract<OrchestrationEvent, { type: "thread.workjet-config-set" }>;
      const config = normalizeWorkjetThreadConfig(event.payload.workjetConfig);
      expect(config.ctoxSupervisorTurn).toBeUndefined();
      expect(config.ctoxSupervisorPreviousTurns).toBeUndefined();
      expect(config.managedInstructions).toBe("Keep working on the solver");
      expect(config.capabilityBindings).toEqual(childConfig.capabilityBindings);
    }),
  );

  it.effect("keeps the child's own receipts across credential rotation", () =>
    Effect.gen(function* () {
      const own = {
        ...childConfig,
        ctoxSupervisorTurn: { ...journal, intent: { ...journal.intent, threadId: childId } },
        ctoxSupervisorPreviousTurns: [],
      };
      const base = readModel();
      const model = {
        ...base,
        threads: base.threads.map((entry) =>
          entry.id === childId ? { ...entry, workjetConfig: own } : entry,
        ),
      };
      const rotated = rotateWorkjetCtoxWorkerSource(own, [old, ready]);
      const result = yield* decideOrchestrationCommand({
        readModel: model,
        command: { ...update(childConfig), workjetConfig: rotated.config },
      });
      const event = result as Extract<OrchestrationEvent, { type: "thread.workjet-config-set" }>;
      expect(normalizeWorkjetThreadConfig(event.payload.workjetConfig).ctoxSupervisorTurn).toEqual(
        own.ctoxSupervisorTurn,
      );
    }),
  );

  it.effect("still rejects a new foreign receipt on an existing child", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        readModel: readModel(),
        command: update({
          ...childConfig,
          ctoxSupervisorTurn: {
            ...journal,
            intent: { ...journal.intent, commandId: CommandId.make("invented-parent-command") },
          },
        }),
      }).pipe(Effect.flip);
      expect(error.message).toContain("this Code thread");
    }),
  );

  it.effect("does not treat a different project's receipt as inherited", () =>
    Effect.gen(function* () {
      const invalid = {
        ...childConfig,
        ctoxSupervisorTurn: {
          ...journal,
          intent: { ...journal.intent, projectId: ProjectId.make("foreign-project") },
        },
      };
      const base = readModel();
      const model = {
        ...base,
        threads: base.threads.map((entry) =>
          entry.id === childId ? { ...entry, workjetConfig: invalid } : entry,
        ),
      };
      const rotated = rotateWorkjetCtoxWorkerSource(invalid, [old, ready]);
      const error = yield* decideOrchestrationCommand({
        readModel: model,
        command: { ...update(childConfig), workjetConfig: rotated.config },
      }).pipe(Effect.flip);
      expect(error.message).toContain("this Code thread");
    }),
  );
});
