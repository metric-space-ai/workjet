import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@workjet/contracts";
import { OrchestrationCommand, RemoteWorkerRequest } from "@workjet/contracts";
import { make as makeRemoteWorkerStore } from "../../workjet/RemoteWorkerStore.ts";
import { RemoteWorkerAdmission } from "../../workjet/RemoteWorkerAdmission.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  receiptMatchesThread,
  type WorkerPullRequestReceipt,
} from "../../workjet/WorkerPullRequestStore.ts";
import {
  WorkjetMailboxStore,
  WorkjetMailboxStoreLive,
} from "../../workjet/mailbox/WorkjetMailboxStore.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandDeferredError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand, threadHasQueuedTurnStart } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
  type OrchestrationDispatchOptions,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
  deferWhileBusy?: boolean | undefined;
  workerDelegation?: OrchestrationDispatchOptions["workerDelegation"] | undefined;
  remoteWorkerRequest?: RemoteWorkerRequest | undefined;
  remoteProjectMirror?: true | undefined;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const remoteWorkerStore = yield* makeRemoteWorkerStore;
  const remoteAdmission = yield* Effect.serviceOption(RemoteWorkerAdmission);
  const mailbox = yield* WorkjetMailboxStore.pipe(Effect.provide(WorkjetMailboxStoreLive));
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* Effect.serviceOption(ServerEnvironment);
  const environmentId = Option.isSome(environment)
    ? yield* environment.value.getEnvironmentId
    : undefined;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  const turnStartFence = yield* Semaphore.make(1);

  const runTurnStartIfActive: OrchestrationEngineShape["runTurnStartIfActive"] = (
    threadId,
    start,
    goalRevision,
  ) =>
    turnStartFence.withPermits(1)(
      Effect.gen(function* () {
        const thread = commandReadModel.threads.find((item) => item.id === threadId);
        if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) return false;
        if (goalRevision !== undefined) {
          const goal =
            thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.goal : undefined;
          const revision = typeof goalRevision === "number" ? goalRevision : goalRevision.revision;
          const status = typeof goalRevision === "number" ? "active" : goalRevision.status;
          if (
            thread.archivedAt !== null ||
            thread.workjetConfig.schemaVersion !== 2 ||
            thread.workjetConfig.team?.role !== "specialist" ||
            goal?.status !== status ||
            goal.revision !== revision
          )
            return false;
        }
        if (thread.workjetConfig.role === "worker") {
          const submitted = yield* sql<{ readonly threadId: string }>`
            SELECT thread_id AS "threadId" FROM workjet_worker_pull_requests
            WHERE thread_id = ${thread.id} AND worktree_path = ${thread.worktreePath}
              AND branch_ref = ${thread.branch} LIMIT 1
          `.pipe(Effect.orDie);
          if (submitted.length > 0) return false;
        }
        yield* start;
        return true;
      }),
    );

  const runWorkerRetirementIfSubmitted: OrchestrationEngineShape["runWorkerRetirementIfSubmitted"] =
    (threadId, stop) =>
      turnStartFence.withPermits(1)(
        Effect.gen(function* () {
          const thread = commandReadModel.threads.find((item) => item.id === threadId);
          if (!thread || thread.deletedAt !== null || thread.workjetConfig.role !== "worker")
            return false;
          const receipts = yield* sql<WorkerPullRequestReceipt>`
          SELECT thread_id AS "threadId", worktree_path AS "worktreePath",
            branch_ref AS "branchRef", provider, pr_number AS "prNumber", pr_url AS "prUrl",
            head_oid AS "headOid", state, execution_stopped AS "executionStopped"
          FROM workjet_worker_pull_requests WHERE thread_id = ${thread.id} LIMIT 1
        `.pipe(Effect.orDie);
          if (!receipts.some((receipt) => receiptMatchesThread(receipt, thread))) return false;
          return yield* stop;
        }),
      );

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        // Check after receipt lookup: retrying an accepted command must return
        // its receipt even when that command itself made the thread busy.
        if (envelope.deferWhileBusy && envelope.command.type === "thread.turn.start") {
          const threadId = envelope.command.threadId;
          const thread = commandReadModel.threads.find((item) => item.id === threadId);
          if (
            thread &&
            thread.deletedAt === null &&
            thread.archivedAt === null &&
            (thread.latestTurn?.state === "running" ||
              (thread.session?.activeTurnId ?? null) !== null ||
              thread.session?.status === "starting" ||
              thread.session?.status === "running" ||
              threadHasQueuedTurnStart(thread, yield* nowIso, Number.POSITIVE_INFINITY))
          ) {
            return yield* new OrchestrationCommandDeferredError({
              commandId: envelope.command.commandId,
              threadId: thread.id,
            });
          }
        }

        if (envelope.workerDelegation) {
          const command = envelope.command;
          const { delegation, envelope: routing } = envelope.workerDelegation;
          const config = command.type === "thread.create" ? command.workjetConfig : undefined;
          const parent = commandReadModel.threads.find(
            (thread) => thread.id === delegation.source.threadId,
          );
          if (
            command.type !== "thread.create" ||
            config?.schemaVersion !== 2 ||
            config.team?.role !== "worker" ||
            config.role !== "worker" ||
            !config.parent ||
            !environmentId ||
            config.parent.environmentId !== environmentId ||
            delegation.source.environmentId !== environmentId ||
            delegation.target.environmentId !== environmentId ||
            delegation.source.threadId !== config.parent.threadId ||
            delegation.target.threadId !== command.threadId ||
            delegation.state !== "queued" ||
            routing.kind !== "delegation" ||
            routing.envelopeId !== delegation.envelopeId ||
            routing.sourceEnvironmentId !== environmentId ||
            routing.targetEnvironmentId !== environmentId ||
            routing.sourceWorkspaceId !== delegation.source.workspaceId ||
            routing.targetWorkspaceId !== delegation.target.workspaceId ||
            delegation.source.workspaceId !== delegation.target.workspaceId ||
            !parent ||
            parent.deletedAt !== null ||
            parent.archivedAt !== null ||
            parent.projectId !== command.projectId ||
            parent.workjetConfig.schemaVersion !== 2 ||
            (parent.workjetConfig.team?.role !== "specialist" &&
              parent.workjetConfig.team?.role !== "supervisor")
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail:
                "Worker creation and delegation must share an active local supervisor or specialist parent.",
            });
          }
          if (
            config.enabledCapabilityIds.some(
              (capability) =>
                !parent.workjetConfig.enabledCapabilityIds.some((grant) => grant === capability),
            )
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Worker capabilities exceed the parent's current grants.",
            });
          }
        }

        // A worker may be archived only after deletion has fenced new turns
        // and the exact checkout/branch has a completed merge-cleanup receipt.
        // A completed receipt is immutable and never inferred from missing Git files.
        let workerCleanupComplete = false;
        if (envelope.command.type === "thread.archive") {
          const { threadId } = envelope.command;
          const thread = commandReadModel.threads.find((item) => item.id === threadId);
          if (
            thread?.workjetConfig.schemaVersion === 2 &&
            thread.workjetConfig.team?.role === "worker" &&
            thread.deletedAt !== null &&
            thread.worktreePath !== null &&
            thread.branch !== null
          ) {
            const receipts = yield* sql<{
              readonly worktreePath: string;
              readonly branchRef: string;
            }>`
              SELECT worktree_path AS "worktreePath", branch_ref AS "branchRef"
              FROM workjet_worker_cleanup_receipts
              WHERE thread_id = ${thread.id} AND status = 'complete'
              LIMIT 1
            `;
            workerCleanupComplete = receipts.some(
              (receipt) =>
                receipt.worktreePath === thread.worktreePath && receipt.branchRef === thread.branch,
            );
          }
        }

        // Native-only receipt fences another turn as soon as the PR becomes terminal.
        // Renderers cannot supply this evidence through OrchestrationCommand.
        let workerPullRequestTerminal = false;
        let workerExecutionStopped = false;
        if (
          envelope.command.type === "thread.archive" ||
          envelope.command.type === "thread.unarchive" ||
          envelope.command.type === "thread.turn.start"
        ) {
          const { threadId } = envelope.command;
          const thread = commandReadModel.threads.find((item) => item.id === threadId);
          if (thread?.workjetConfig.role === "worker") {
            const receipts = yield* sql<WorkerPullRequestReceipt>`
              SELECT thread_id AS "threadId", worktree_path AS "worktreePath",
                branch_ref AS "branchRef", provider, pr_number AS "prNumber", pr_url AS "prUrl",
                head_oid AS "headOid", state, execution_stopped AS "executionStopped"
              FROM workjet_worker_pull_requests WHERE thread_id = ${thread.id}
                LIMIT 1
            `;
            workerPullRequestTerminal = receipts.length === 1;
            workerExecutionStopped = receipts.some(
              (receipt) => receipt.executionStopped === 1 && receiptMatchesThread(receipt, thread),
            );
          }
        }

        let remoteWorkerRequest: RemoteWorkerRequest | undefined;
        const command = envelope.command;
        const existingThread =
          "threadId" in command
            ? commandReadModel.threads.find((thread) => thread.id === command.threadId)
            : undefined;
        const isRemoteWorker =
          environmentId !== undefined &&
          existingThread?.workjetConfig.role === "worker" &&
          existingThread.workjetConfig.parent.environmentId !== environmentId;
        if (envelope.remoteWorkerRequest || isRemoteWorker) {
          const requestId = envelope.remoteWorkerRequest?.requestId ?? existingThread!.id;
          const bound = yield* remoteWorkerStore.get("inbound", requestId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Remote worker receipt is unavailable.",
                  cause,
                }),
            ),
          );
          if (Option.isNone(bound) || bound.value.response?.outcome.status === "failed") {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Remote worker has no accepted native request.",
            });
          }
          const request = bound.value.request;
          if (envelope.remoteWorkerRequest) {
            const encode = (input: RemoteWorkerRequest) =>
              Schema.encodeEffect(Schema.fromJsonString(RemoteWorkerRequest))(input).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: "Remote request encoding failed.",
                      cause,
                    }),
                ),
              );
            if (
              command.type !== "thread.create" ||
              (yield* encode(request)) !== (yield* encode(envelope.remoteWorkerRequest)) ||
              command.threadId !== request.requestId ||
              command.projectId !== request.project.id ||
              command.branch !== `workjet/worker/${request.requestId}` ||
              command.worktreePath !== bound.value.worktreePath ||
              command.worktreePath === null ||
              request.targetEnvironmentId !== environmentId ||
              request.parent.environmentId === environmentId
            )
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Remote worker creation does not match its native receipt.",
              });
          }
          if (command.type === "thread.create" || command.type === "thread.turn.start") {
            if (Option.isNone(remoteAdmission)) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Current source-native remote worker admission is unavailable.",
              });
            }
            // Recheck after clone and at every subsequent start. Rejected
            // command receipts let Receiver apply its owned rollback safely.
            yield* remoteAdmission.value.admit(request).pipe(
              Effect.mapError(
                () =>
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "Current source-native remote worker admission denied.",
                  }),
              ),
            );
          }
          remoteWorkerRequest = request;
        }
        if (envelope.remoteProjectMirror && command.type !== "project.create") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Only a target project creation can be a remote mirror.",
          });
        }
        // Startup keeps the command model small. Computer continuation needs
        // the complete persisted prefix under this command queue's fence.
        let decisionReadModel = commandReadModel;
        if (command.type === "thread.continuation.import" && existingThread) {
          const detail = yield* projectionSnapshotQuery.getThreadDetailById(command.threadId);
          if (Option.isNone(detail))
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "The destination history could not be read. No history was copied.",
            });
          decisionReadModel = {
            ...commandReadModel,
            threads: commandReadModel.threads.map((thread) =>
              thread.id === command.threadId ? detail.value : thread,
            ),
          };
        }
        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: decisionReadModel,
          environmentId,
          workerCleanupComplete,
          workerPullRequestTerminal,
          workerExecutionStopped,
          remoteWorkerRequest,
          remoteProjectMirror: envelope.remoteProjectMirror,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandInvariantError(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                if (!projectionPipeline.projectEvents) {
                  yield* projectionPipeline.projectEvent(savedEvent);
                }
                committedEvents.push(savedEvent);
              }

              const postCommit = projectionPipeline.projectEvents
                ? yield* projectionPipeline.projectEvents(committedEvents)
                : Effect.void;

              if (envelope.workerDelegation) {
                const prepared = envelope.workerDelegation;
                const existing = yield* mailbox
                  .getDelegation(prepared.delegation.delegationId)
                  .pipe(
                    Effect.mapError(
                      toPersistenceSqlError("OrchestrationEngine.workerDelegation.lookup"),
                    ),
                  );
                if (Option.isSome(existing)) {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Worker delegation identity is already in use.",
                  });
                }
                const enqueued = yield* mailbox
                  .enqueueOutbound(prepared.envelope, {
                    _tag: "delegation",
                    delegation: prepared.delegation,
                  })
                  .pipe(
                    Effect.mapError(toPersistenceSqlError("OrchestrationEngine.workerDelegation")),
                  );
                if (enqueued._tag !== "enqueued") {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Worker delegation envelope identity is already in use.",
                  });
                }
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;

              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
                postCommit,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        yield* committedCommand.postCommit;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`), (effect) =>
        envelope.command.type === "thread.delete" ||
        envelope.command.type === "project.delete" ||
        envelope.command.type === "thread.goal.set" ||
        envelope.command.type === "thread.turn.interrupt" ||
        envelope.command.type === "thread.session.stop" ||
        envelope.command.type === "thread.archive"
          ? turnStartFence.withPermits(1)(effect)
          : effect,
      ),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandInvariantError(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
        deferWhileBusy: options?.deferWhileBusy,
        workerDelegation: options?.workerDelegation,
        remoteWorkerRequest: options?.remoteWorkerRequest,
        remoteProjectMirror: options?.remoteProjectMirror,
      });
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    dispatch,
    runTurnStartIfActive,
    runWorkerRetirementIfSubmitted,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
