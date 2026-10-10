import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkjetConnectionId,
  normalizeWorkjetThreadConfig,
  rotateWorkjetCtoxWorkerSource,
  type WorkjetConnectionSummary,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { startCtoxWorkerSourceRotation } from "./CtoxWorkerSourceRotation.ts";

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
const config: WorkjetThreadConfig = {
  ...normalizeWorkjetThreadConfig(DEFAULT_WORKJET_THREAD_CONFIG),
  enabledCapabilityIds: ["ctox-business-os"],
  capabilityBindings: [
    {
      capabilityId: "ctox-business-os",
      target: {
        kind: "ctox-connection",
        connectionId: old.connectionId,
        instanceId: old.instanceId,
      },
    },
  ],
  ctoxCrewChat: {
    connectionId: old.connectionId,
    instanceId: old.instanceId,
    chatId: "private-chat",
  },
  ctoxSupervisorTurn: {
    intent: {
      instanceId: old.instanceId,
      projectId: ProjectId.make("molecularity"),
      threadId: ThreadId.make("supervisor"),
      commandId: CommandId.make("saved-command"),
      goal: "Existing task",
      createdAt: "2026-10-10T00:00:00.000Z",
    },
    submission: "confirmed",
    turn: null,
  },
  ctoxSupervisorPreviousTurns: [
    {
      intent: {
        instanceId: old.instanceId,
        projectId: ProjectId.make("molecularity"),
        threadId: ThreadId.make("supervisor"),
        commandId: CommandId.make("previous-receipt"),
        goal: "Completed task",
        createdAt: "2026-10-09T00:00:00.000Z",
      },
      submission: "confirmed",
      turn: null,
    },
  ],
};

function threads() {
  return ["supervisor", "persistent-worker", "one-shot-worker"].map((id) => ({
    id: ThreadId.make(id),
    deletedAt: null,
    workjetConfig:
      id === "supervisor"
        ? config
        : {
            ...config,
            role: "worker" as const,
            parent: {
              environmentId: EnvironmentId.make("this-computer"),
              threadId: ThreadId.make("supervisor"),
            },
          },
  }));
}

describe("automatic worker-source rotation", () => {
  it.effect(
    "rebinds every existing project thread when a ready successor appears, without a client",
    () =>
      Effect.gen(function* () {
        const changes = yield* PubSub.unbounded<void>();
        const completed = yield* Deferred.make<void>();
        let connections = [old];
        const existing = threads();
        let writes = 0;
        yield* startCtoxWorkerSourceRotation({
          connections: {
            list: Effect.sync(() => connections),
            subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
          },
          threads: Effect.sync(() => existing),
          dispatch: (command, options) =>
            Effect.gen(function* () {
              if (command.type !== "thread.workjet-config.set")
                throw new Error("Unexpected command");
              const thread = existing.find((entry) => entry.id === command.threadId)!;
              expect(options?.expectedWorkjetConfig).toBe(thread.workjetConfig);
              thread.workjetConfig = command.workjetConfig;
              writes++;
              if (writes === 3) yield* Deferred.succeed(completed, undefined);
              return { sequence: writes };
            }),
        });
        expect(writes).toBe(0);
        connections = [old, ready];
        yield* PubSub.publish(changes, undefined);
        yield* Deferred.await(completed);
        for (const thread of existing) {
          const next = normalizeWorkjetThreadConfig(thread.workjetConfig);
          expect(next.capabilityBindings[0]?.target.connectionId).toBe(ready.connectionId);
          expect(next.ctoxCrewChat).toEqual({
            ...normalizeWorkjetThreadConfig(config).ctoxCrewChat,
            connectionId: ready.connectionId,
          });
          expect(next.ctoxSupervisorTurn).toBe(
            normalizeWorkjetThreadConfig(config).ctoxSupervisorTurn,
          );
          expect(next.ctoxSupervisorPreviousTurns).toEqual(
            normalizeWorkjetThreadConfig(config).ctoxSupervisorPreviousTurns,
          );
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not guess between two ready grants and exposes an actionable reason", () =>
    Effect.gen(function* () {
      const connections = [
        old,
        ready,
        {
          ...ready,
          connectionId: WorkjetConnectionId.make(
            `ctox-dev-worker-source:${tenant}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
          ),
        },
      ];
      const result = rotateWorkjetCtoxWorkerSource(config, connections);
      expect(result.config).toBe(config);
      expect(result.changed).toBe(false);
      expect(result.error).toContain("Multiple authorized worker connections");
      let writes = 0;
      yield* startCtoxWorkerSourceRotation({
        connections: {
          list: Effect.succeed(connections),
          subscribeChanges: Effect.succeed(Stream.empty),
        },
        threads: Effect.succeed(threads()),
        dispatch: () => Effect.sync(() => ({ sequence: ++writes })),
      });
      expect(writes).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("retains disabled tools and refuses source/tenant/instance changes", () => {
    for (const successor of [
      { ...ready, source: "local_ctox" as const },
      { ...ready, instanceId: "foreign.ctox.dev" },
      {
        ...ready,
        connectionId: WorkjetConnectionId.make(
          ready.connectionId.replace(tenant, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        ),
      },
    ])
      expect(rotateWorkjetCtoxWorkerSource(config, [old, successor]).changed).toBe(false);
    const disabled = { ...config, enabledCapabilityIds: [] };
    expect(
      normalizeWorkjetThreadConfig(rotateWorkjetCtoxWorkerSource(disabled, [old, ready]).config)
        .enabledCapabilityIds,
    ).toEqual([]);
    expect(
      rotateWorkjetCtoxWorkerSource(config, [{ ...old, status: "ready" }, ready]).changed,
    ).toBe(false);
  });
});
