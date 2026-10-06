import { DEFAULT_WORKJET_THREAD_CONFIG } from "@workjet/contracts";
import {
  CheckpointRef,
  EnvironmentId,
  WorkjetEnvelopeId,
  WorkjetDelegationId,
  WorkjetMeshWorkspaceId,
  WorkjetSealedPayloadRef,
  WorkjetRepositoryPath,
  WorkjetContentDigest,
  type OrchestrationCommand,
  type WorkjetDelegation,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

async function createOrchestrationSystem(environmentId?: EnvironmentId) {
  const engineLayer = environmentId
    ? OrchestrationEngineLive.pipe(
        Layer.provide(
          Layer.succeed(ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.die("unused test descriptor"),
          }),
        ),
      )
    : OrchestrationEngineLive;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "workjet-orchestration-engine-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    engineLayer.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  return {
    engine,
    sql,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("OrchestrationEngine", () => {
  it("archives a deleted team worker only after exact completed cleanup evidence", async () => {
    const environmentId = EnvironmentId.make("worker-cleanup-environment");
    const system = await createOrchestrationSystem(environmentId);
    const projectId = ProjectId.make("worker-cleanup-project");
    const specialistId = ThreadId.make("worker-cleanup-specialist");
    const workerId = ThreadId.make("worker-cleanup-worker");
    const workerBranch = `workjet/worker/${workerId}`;
    const workerPath = "/Volumes/tmp/worktrees/workjet/worker-cleanup-worker";
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("worker-cleanup-project-create"),
          projectId,
          title: "Worker cleanup",
          workspaceRoot: "/fixture/worker-cleanup",
          createdAt: now(),
        }),
      );
      const supervisor = (await system.readModel()).threads[0]!;
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("worker-cleanup-specialist-create"),
          threadId: specialistId,
          projectId,
          title: "Backend specialist",
          modelSelection: supervisor.modelSelection,
          runtimeMode: supervisor.runtimeMode,
          interactionMode: supervisor.interactionMode,
          workjetConfig: {
            ...DEFAULT_WORKJET_THREAD_CONFIG,
            role: "orchestrator",
            team: {
              projectId,
              threadId: specialistId,
              role: "specialist",
              parentThreadId: supervisor.id,
              domain: "Backend",
              goal: "Own backend work",
              createdAt: now(),
            },
          },
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("worker-cleanup-worker-create"),
          threadId: workerId,
          projectId,
          title: "Worker",
          modelSelection: supervisor.modelSelection,
          runtimeMode: supervisor.runtimeMode,
          interactionMode: supervisor.interactionMode,
          workjetConfig: {
            ...DEFAULT_WORKJET_THREAD_CONFIG,
            role: "worker",
            parent: { environmentId, threadId: specialistId },
            team: {
              projectId,
              threadId: workerId,
              role: "worker",
              parentThreadId: specialistId,
              packageId: "worker-cleanup-package",
              goal: "Finish reviewed source",
              createdAt: now(),
            },
          },
          branch: workerBranch,
          worktreePath: workerPath,
          createdAt: now(),
        }),
      );

      const archive = (commandId: string) =>
        system.run(
          system.engine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(commandId),
            threadId: workerId,
          }),
        );
      await expect(archive("worker-cleanup-archive-active")).rejects.toThrow();
      await system.run(
        system.engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("worker-cleanup-worker-delete"),
          threadId: workerId,
        }),
      );
      await expect(archive("worker-cleanup-archive-no-receipt")).rejects.toThrow();

      await system.run(system.sql`
        INSERT INTO workjet_worker_cleanup_receipts (
          thread_id, worktree_path, branch_ref, merged_head_oid,
          merged_change_request_url, status, verified_at_ms, completed_at_ms
        ) VALUES (
          ${workerId}, ${workerPath}, ${workerBranch}, ${"a".repeat(40)},
          ${"https://example.test/pull/1"}, 'verified', 1, NULL
        )
      `);
      await expect(archive("worker-cleanup-archive-incomplete")).rejects.toThrow();
      await system.run(system.sql`
        UPDATE workjet_worker_cleanup_receipts
        SET status = 'complete', removed_at_ms = 2, completed_at_ms = 3,
          branch_ref = ${"workjet/worker/wrong"}
        WHERE thread_id = ${workerId}
      `);
      await expect(archive("worker-cleanup-archive-wrong-ref")).rejects.toThrow();
      await system.run(system.sql`
        UPDATE workjet_worker_cleanup_receipts
        SET branch_ref = ${workerBranch}
        WHERE thread_id = ${workerId}
      `);
      await archive("worker-cleanup-archive-complete");
      const worker = (await system.readModel()).threads.find((thread) => thread.id === workerId);
      expect(worker?.deletedAt).not.toBeNull();
      expect(worker?.archivedAt).not.toBeNull();
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("worker-cleanup-unarchive-deleted"),
            threadId: workerId,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await system.dispose();
    }
  });

  it("fences provider turn starts against thread and forced-project deletion", async () => {
    for (const deletion of ["thread", "project"] as const) {
      const system = await createOrchestrationSystem();
      const projectId = asProjectId(`turn-start-fence-${deletion}`);
      try {
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make(`turn-start-fence-${deletion}-create`),
            projectId,
            title: "Turn start fence",
            workspaceRoot: "/fixture/turn-start-fence",
            createdAt: now(),
          }),
        );
        const supervisor = (await system.readModel()).threads[0]!;
        const threadId =
          deletion === "project" ? supervisor.id : ThreadId.make("turn-start-fence-normal-thread");
        if (deletion === "thread") {
          await system.run(
            system.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("turn-start-fence-normal-thread-create"),
              threadId,
              projectId,
              title: "Normal thread",
              modelSelection: supervisor.modelSelection,
              interactionMode: supervisor.interactionMode,
              workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
              runtimeMode: supervisor.runtimeMode,
              branch: null,
              worktreePath: null,
              createdAt: now(),
            }),
          );
        }
        const sequenceBeforeDelete = await system.run(system.engine.latestSequence);

        await system.run(
          Effect.scoped(
            Effect.gen(function* () {
              const sendStarted = yield* Deferred.make<void>();
              const releaseSend = yield* Deferred.make<void>();
              const send = yield* Effect.forkScoped(
                system.engine.runTurnStartIfActive(
                  threadId,
                  Effect.gen(function* () {
                    yield* Deferred.succeed(sendStarted, undefined);
                    yield* Deferred.await(releaseSend);
                  }),
                ),
              );
              yield* Deferred.await(sendStarted);

              const deleteProject = yield* Effect.forkScoped(
                system.engine.dispatch(
                  deletion === "project"
                    ? {
                        type: "project.delete",
                        commandId: CommandId.make(`turn-start-fence-${deletion}-delete`),
                        projectId,
                        force: true,
                      }
                    : {
                        type: "thread.delete",
                        commandId: CommandId.make(`turn-start-fence-${deletion}-delete`),
                        threadId,
                      },
                ),
              );
              yield* Effect.yieldNow;
              expect(yield* system.engine.latestSequence).toBe(sequenceBeforeDelete);

              yield* Deferred.succeed(releaseSend, undefined);
              expect(yield* Fiber.join(send)).toBe(true);
              yield* Fiber.join(deleteProject);

              let lateSendStarted = false;
              expect(
                yield* system.engine.runTurnStartIfActive(
                  threadId,
                  Effect.sync(() => {
                    lateSendStarted = true;
                  }),
                ),
              ).toBe(false);
              expect(lateSendStarted).toBe(false);
            }),
          ),
        );
      } finally {
        await system.dispose();
      }
    }
  });

  it("releases the turn-start fence after failure, timeout and interruption", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("turn-start-fence-release-create"),
          projectId: asProjectId("turn-start-fence-release"),
          title: "Fence release",
          workspaceRoot: "/fixture/turn-start-fence-release",
          createdAt: now(),
        }),
      );
      const threadId = (await system.readModel()).threads[0]!.id;
      await system.run(
        Effect.scoped(
          Effect.gen(function* () {
            const failed = yield* system.engine
              .runTurnStartIfActive(
                threadId,
                Effect.fail(
                  new PersistenceSqlError({ operation: "test.sendTurn", detail: "send failed" }),
                ),
              )
              .pipe(Effect.catch(() => Effect.succeed(false)));
            expect(failed).toBe(false);

            const unacknowledged = yield* Deferred.make<void>();
            const timedOut = yield* system.engine
              .runTurnStartIfActive(threadId, Deferred.await(unacknowledged))
              .pipe(Effect.timeoutOption("10 millis"));
            expect(Option.isNone(timedOut)).toBe(true);

            const entered = yield* Deferred.make<void>();
            const interrupted = yield* Effect.forkScoped(
              system.engine.runTurnStartIfActive(
                threadId,
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(unacknowledged);
                }),
              ),
            );
            yield* Deferred.await(entered);
            yield* Fiber.interrupt(interrupted);

            expect(yield* system.engine.runTurnStartIfActive(threadId, Effect.void)).toBe(true);
          }),
        ),
      );
    } finally {
      await system.dispose();
    }
  });

  it("commits worker creation and delegation together and retries a failed transaction", async () => {
    const environmentId = EnvironmentId.make("atomic-worker-env");
    const system = await createOrchestrationSystem(environmentId);
    const projectId = asProjectId("atomic-worker-project");
    const specialistId = ThreadId.make("atomic-specialist");
    const workerId = ThreadId.make("atomic-worker");
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("atomic-project-create"),
          projectId,
          title: "Atomic worker",
          workspaceRoot: "/fixture/atomic-worker",
          createdAt: now(),
        }),
      );
      const supervisor = (await system.readModel()).threads[0]!;
      const common = {
        projectId,
        title: "Team member",
        modelSelection: supervisor.modelSelection,
        runtimeMode: supervisor.runtimeMode,
        interactionMode: supervisor.interactionMode,
        branch: "test",
        worktreePath: "/fixture/atomic-worker/member",
        createdAt: now(),
      };
      await system.run(
        system.engine.dispatch({
          ...common,
          type: "thread.create",
          commandId: CommandId.make("atomic-specialist-create"),
          threadId: specialistId,
          workjetConfig: {
            schemaVersion: 2,
            role: "orchestrator",
            parent: null,
            managedInstructions: "",
            enabledCapabilityIds: [],
            capabilityBindings: [],
            team: {
              role: "specialist",
              domain: "implementation",
              goal: "Implement the project",
              projectId,
              threadId: specialistId,
              parentThreadId: supervisor.id,
              createdAt: now(),
            },
          },
        }),
      );
      const command = {
        ...common,
        type: "thread.create",
        commandId: CommandId.make("atomic-worker-create"),
        threadId: workerId,
        workjetConfig: {
          schemaVersion: 2,
          role: "worker",
          parent: { environmentId, threadId: specialistId },
          managedInstructions: "",
          enabledCapabilityIds: [],
          capabilityBindings: [],
          team: {
            role: "worker",
            packageId: workerId,
            goal: "Implement the package",
            projectId,
            threadId: workerId,
            parentThreadId: specialistId,
            createdAt: now(),
          },
        },
      } as const satisfies OrchestrationCommand;
      const workspaceId = WorkjetMeshWorkspaceId.make("atomic-workspace");
      const envelopeId = WorkjetEnvelopeId.make("wjm-atomic-worker-envelope-000001");
      const source = {
        schemaVersion: 1 as const,
        workspaceId,
        environmentId,
        threadId: specialistId,
      };
      const expiresAt = "2026-01-08T00:00:00.000Z";
      const delegation = {
        schemaVersion: 1,
        delegationId: WorkjetDelegationId.make("wjd-atomic-worker-delegation-000001"),
        envelopeId,
        source,
        target: { ...source, threadId: workerId },
        createdAt: now(),
        expiresAt,
        prompt: {
          schemaVersion: 1,
          snapshotRef: WorkjetSealedPayloadRef.make("c25hcHNob3QtcmVmZXJlbmNlLTAwMQ"),
          digest: WorkjetContentDigest.make("a".repeat(64)),
          byteLength: 42,
        },
        scope: {
          schemaVersion: 1,
          files: [WorkjetRepositoryPath.make(".")],
          nonGoals: "No unrelated changes.",
        },
        completion: { schemaVersion: 1, acceptance: "Complete the implementation." },
        budget: { schemaVersion: 1, maxDepth: 1, maxReviewRounds: 2, expiresAt },
        state: "queued",
        stateChangedAt: now(),
        depth: 0,
      } as const satisfies WorkjetDelegation;
      const options = {
        workerDelegation: {
          delegation,
          envelope: {
            schemaVersion: 1 as const,
            envelopeId,
            kind: "delegation" as const,
            sourceWorkspaceId: workspaceId,
            targetWorkspaceId: workspaceId,
            sourceEnvironmentId: environmentId,
            targetEnvironmentId: environmentId,
            createdAt: now(),
            expiresAt,
            signature: "c2lnbmF0dXJlLXN0dWI",
          },
        },
      };
      const before = await system.run(system.engine.latestSequence);
      await expect(
        system.run(
          system.engine.dispatch(
            {
              ...command,
              commandId: CommandId.make("atomic-worker-escalation"),
              workjetConfig: { ...command.workjetConfig, enabledCapabilityIds: ["web-search"] },
            },
            options,
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: "Worker capabilities exceed the specialist's current grants.",
      });
      expect(await system.run(system.engine.latestSequence)).toBe(before);
      await system.run(system.sql`CREATE TRIGGER fail_worker_delegation
        BEFORE INSERT ON workjet_delegations
        BEGIN SELECT RAISE(ABORT, 'injected worker delegation failure'); END`);
      await expect(system.run(system.engine.dispatch(command, options))).rejects.toMatchObject({
        _tag: "PersistenceSqlError",
      });
      expect((await system.readModel()).threads.some((thread) => thread.id === workerId)).toBe(
        false,
      );
      expect(await system.run(system.engine.latestSequence)).toBe(before);
      expect(
        await system.run(system.sql`SELECT envelope_id FROM workjet_mailbox_outbox`),
      ).toHaveLength(0);
      await system.run(system.sql`DROP TRIGGER fail_worker_delegation`);
      const accepted = await system.run(system.engine.dispatch(command, options));
      expect(
        (await system.readModel()).threads.filter((thread) => thread.id === workerId),
      ).toHaveLength(1);
      expect(
        await system.run(system.sql`SELECT envelope_id FROM workjet_mailbox_outbox`),
      ).toHaveLength(1);
      expect(
        await system.run(system.sql`SELECT delegation_id FROM workjet_delegations`),
      ).toHaveLength(1);
      expect(await system.run(system.engine.dispatch(command, options))).toEqual(accepted);
      for (const collision of ["delegation", "envelope"] as const) {
        const otherWorkerId = ThreadId.make(`atomic-worker-collision-${collision}`);
        const otherCommand = {
          ...command,
          commandId: CommandId.make(`atomic-collision-${collision}`),
          threadId: otherWorkerId,
          workjetConfig: {
            ...command.workjetConfig,
            team: {
              ...command.workjetConfig.team,
              threadId: otherWorkerId,
              packageId: otherWorkerId,
            },
          },
        };
        const otherEnvelopeId =
          collision === "envelope"
            ? envelopeId
            : WorkjetEnvelopeId.make("wjm-distinct-envelope-for-collision");
        const otherDelegation = {
          ...delegation,
          envelopeId: otherEnvelopeId,
          delegationId:
            collision === "delegation"
              ? delegation.delegationId
              : WorkjetDelegationId.make("wjd-distinct-delegation-for-collision"),
          target: { ...delegation.target, threadId: otherWorkerId },
        };
        const sequence = await system.run(system.engine.latestSequence);
        await expect(
          system.run(
            system.engine.dispatch(otherCommand, {
              workerDelegation: {
                delegation: otherDelegation,
                envelope: { ...options.workerDelegation.envelope, envelopeId: otherEnvelopeId },
              },
            }),
          ),
        ).rejects.toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
        expect(await system.run(system.engine.latestSequence)).toBe(sequence);
        expect(
          (await system.readModel()).threads.some((thread) => thread.id === otherWorkerId),
        ).toBe(false);
        expect(
          await system.run(system.sql`SELECT envelope_id FROM workjet_mailbox_outbox`),
        ).toHaveLength(1);
        expect(
          await system.run(system.sql`SELECT delegation_id FROM workjet_delegations`),
        ).toHaveLength(1);
      }

      const events = await system.run(Stream.runCollect(system.engine.readEvents(before)));
      expect(
        Array.from(events).filter((event) => event.type === "thread.turn-start-requested"),
      ).toHaveLength(0);
    } finally {
      await system.dispose();
    }
  });

  it("admits only one of two concurrent background starts", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("concurrent-admission-project"),
          projectId: asProjectId("concurrent-admission-project"),
          title: "Concurrent admission",
          workspaceRoot: "/fixture/concurrent-admission",
          createdAt: now(),
        }),
      );
      const threadId = (await system.readModel()).threads[0]!.id;
      const commands = ["one", "two"].map((id) => ({
        type: "thread.turn.start" as const,
        commandId: CommandId.make(`concurrent-${id}`),
        threadId,
        message: {
          messageId: asMessageId(`concurrent-${id}`),
          role: "user" as const,
          text: id,
          attachments: [],
        },
        runtimeMode: "approval-required" as const,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now(),
      }));
      const results = await Promise.allSettled(
        commands.map((command) =>
          system.run(system.engine.dispatch(command, { deferWhileBusy: true })),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { _tag: "OrchestrationCommandDeferredError" },
      });
      const acceptedIndex = results.findIndex((result) => result.status === "fulfilled");
      const accepted = results[acceptedIndex];
      if (accepted?.status !== "fulfilled") throw new Error("Missing accepted command");
      expect(
        await system.run(
          system.engine.dispatch(commands[acceptedIndex]!, {
            deferWhileBusy: true,
          }),
        ),
      ).toEqual(accepted.value);
      const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
      expect(
        Array.from(events).filter((event) => event.type === "thread.turn-start-requested"),
      ).toHaveLength(1);
    } finally {
      await system.dispose();
    }
  });

  it("defers background turns without poisoning their retry receipt", async () => {
    const system = await createOrchestrationSystem();
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("idle-admission-project"),
          projectId: asProjectId("idle-admission-project"),
          title: "Admission",
          workspaceRoot: "/fixture/idle-admission",
          createdAt: now(),
        }),
      );
      const threadId = (await system.readModel()).threads[0]!.id;
      const first = {
        type: "thread.turn.start" as const,
        commandId: CommandId.make("idle-first"),
        threadId,
        message: {
          messageId: asMessageId("idle-first"),
          role: "user" as const,
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required" as const,
        createdAt: now(),
      };
      const second = {
        ...first,
        commandId: CommandId.make("idle-second"),
        message: { ...first.message, messageId: asMessageId("idle-second"), text: "second" },
      };
      const accepted = await system.run(system.engine.dispatch(first, { deferWhileBusy: true }));
      const sequence = await system.run(system.engine.latestSequence);
      // Even an old unadopted start stays protected from a background turn.
      await expect(
        system.run(system.engine.dispatch(second, { deferWhileBusy: true })),
      ).rejects.toMatchObject({ _tag: "OrchestrationCommandDeferredError" });
      expect(await system.run(system.engine.latestSequence)).toBe(sequence);
      expect(await system.run(system.engine.dispatch(first, { deferWhileBusy: true }))).toEqual(
        accepted,
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("idle-failed-start"),
          threadId,
          session: {
            threadId,
            status: "error",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: "start failed",
            updatedAt: now(),
          },
          createdAt: now(),
        }),
      );
      // Same ID succeeds after the previous start fails: no rejected receipt.
      const retried = await system.run(system.engine.dispatch(second, { deferWhileBusy: true }));
      expect(retried.sequence).toBeGreaterThan(sequence);
      const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
      expect(
        Array.from(events).filter(
          (event) => event.commandId === second.commandId && event.type === "thread.message-sent",
        ),
      ).toHaveLength(1);
    } finally {
      await system.dispose();
    }
  });

  it("persists one supervisor with project creation despite duplicate client delivery", async () => {
    const system = await createOrchestrationSystem();
    try {
      const command = {
        type: "project.create",
        commandId: CommandId.make("team-project-create"),
        projectId: asProjectId("team-project"),
        title: "Team project",
        workspaceRoot: "/fixture/team-project",
        createdAt: now(),
      } as const;
      const receipts = await Promise.all([
        system.run(system.engine.dispatch(command)),
        system.run(system.engine.dispatch(command)),
      ]);
      expect(receipts[0]).toEqual(receipts[1]);
      const snapshot = await system.readModel();
      const members = snapshot.threads.filter((thread) => thread.projectId === command.projectId);
      expect(members).toHaveLength(1);
      const member = members[0]!;
      expect(member.workjetConfig.schemaVersion === 2 && member.workjetConfig.team?.role).toBe(
        "supervisor",
      );
      const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
      expect(Array.from(events).map((event) => event.type)).toEqual([
        "project.created",
        "thread.created",
      ]);
    } finally {
      await system.dispose();
    }
  });

  it("bootstraps command handling from persisted projections without reading the full snapshot", async () => {
    let nextSequence = 8;
    const eventStore: OrchestrationEventStoreShape = {
      append: (event) =>
        Effect.sync(() => {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as OrchestrationEvent;
          nextSequence += 1;
          return savedEvent;
        }),
      readFromSequence: () => Stream.empty,
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };
    const commandReadModel = {
      ...projectionSnapshot,
      threads: projectionSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      })),
    };
    let fullSnapshotReadCount = 0;

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(commandReadModel),
          getSnapshot: () =>
            Effect.sync(() => {
              fullSnapshotReadCount += 1;
              return projectionSnapshot;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: projectionSnapshot.snapshotSequence }),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getThreadWorktreeCleanupContext: () => Effect.succeed(Option.none()),
          listDeletedWorkerWorktreeCleanupThreadIds: () => Effect.succeed([]),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          isThreadTurnTerminal: () => Effect.succeed(false),
          getArchivedTeamWorkerDetailSnapshot: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    expect(await runtime.runPromise(engine.latestSequence)).toBe(7);
    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-bootstrap-thread-update"),
        threadId: ThreadId.make("thread-bootstrap"),
        title: "Updated Bootstrap Thread",
      }),
    );

    expect(result.sequence).toBe(8);
    expect(await runtime.runPromise(engine.latestSequence)).toBe(8);
    expect(fullSnapshotReadCount).toBe(0);

    await runtime.dispose();
  });

  it("persists deterministic read models for repeated snapshot reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-1-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.readModel();
    const readModelB = await system.readModel();
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("archives and unarchives threads through orchestration commands", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-create"),
        projectId: asProjectId("project-archive"),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-create"),
        threadId: ThreadId.make("thread-archive"),
        projectId: asProjectId("project-archive"),
        title: "Archive me",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-archive-title-regeneration"),
        threadId: ThreadId.make("thread-archive"),
        regenerateTitle: true,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).not.toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();
    await system.run(
      engine.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("cmd-thread-archive-stale-title-completion"),
        threadId: ThreadId.make("thread-archive"),
        requestId: CommandId.make("cmd-thread-archive-title-regeneration"),
        title: "Stale generated title",
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")?.title,
    ).toBe("Archive me");

    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-replay-create"),
        threadId: ThreadId.make("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-replay-delete"),
        threadId: ThreadId.make("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-stream-thread-create"),
          threadId: ThreadId.make("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stream-thread-update"),
          threadId: ThreadId.make("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("does not regress a generated branch to a stale temporary worktree branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-branch-race-project-create"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Project",
        workspaceRoot: "/tmp/project-branch-race",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-branch-race-thread-create"),
        threadId: ThreadId.make("thread-branch-race"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "approval-required",
        branch: "workjet/generated-branch-name",
        worktreePath: "/tmp/project-branch-race-worktree",
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-stale-temporary-branch-sync"),
        threadId: ThreadId.make("thread-branch-race"),
        branch: "workjet/1234abcd",
        expectedBranch: "workjet/1234abcd",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads.find((thread) => thread.id === "thread-branch-race")?.branch).toBe(
      "workjet/generated-branch-name",
    );
    await system.dispose();
  });

  it("allows authoritative worktree bootstrap to assign a temporary branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-project-create"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Project",
        workspaceRoot: "/tmp/project-worktree-bootstrap",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-thread-create"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "approval-required",
        branch: "main",
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-authoritative-worktree-bootstrap"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        branch: "workjet/1234abcd",
        worktreePath: "/tmp/project-worktree-bootstrap-worktree",
      }),
    );

    const snapshot = await system.readModel();
    expect(
      snapshot.threads.find((thread) => thread.id === "thread-worktree-bootstrap")?.branch,
    ).toBe("workjet/1234abcd");
    expect(
      snapshot.threads.find((thread) => thread.id === "thread-worktree-bootstrap")?.worktreePath,
    ).toBe("/tmp/project-worktree-bootstrap-worktree");
    await system.dispose();
  });

  it("records command ack duration using the first committed event type", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ack-create"),
        projectId: asProjectId("project-ack"),
        title: "Ack Project",
        workspaceRoot: "/tmp/project-ack",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ack-create"),
        threadId: ThreadId.make("thread-ack"),
        projectId: asProjectId("project-ack"),
        title: "Ack Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "workjet_orchestration_command_ack_duration", {
        commandType: "thread.create",
        aggregateKind: "thread",
        ackEventType: "thread.created",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("records failed command dispatches as metric failures", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-missing-project"),
          threadId: ThreadId.make("thread-missing-project"),
          projectId: asProjectId("project-missing"),
          title: "Missing Project Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("does not exist");

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "workjet_orchestration_commands_total", {
        commandType: "thread.create",
        aggregateKind: "thread",
        outcome: "failure",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-turn-diff-create"),
        threadId: ThreadId.make("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-complete"),
        threadId: ThreadId.make("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/workjet/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.readModel()).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/workjet/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "workjet-orchestration-engine-test-",
    });

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-flaky-1"),
          threadId: ThreadId.make("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-flaky-2"),
        threadId: ThreadId.make("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(3);
    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created", // durable supervisor
      "thread.created",
    ]);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.make("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-atomic-create"),
        threadId: ThreadId.make("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-start-atomic"),
      threadId: ThreadId.make("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failed",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created", // durable supervisor
      "thread.created",
    ]);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(5);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created", // durable supervisor
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("reconciles command state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make("cmd-thread-archive-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-sync-create"),
        threadId: ThreadId.make("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-fail"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("projection failed");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-retry"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("already archived");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-invariant-missing-thread"),
          threadId: ThreadId.make("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-duplicate-1"),
        threadId: ThreadId.make("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-duplicate-2"),
          threadId: ThreadId.make("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });
});
