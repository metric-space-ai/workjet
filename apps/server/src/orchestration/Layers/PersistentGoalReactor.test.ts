import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_WORKJET_THREAD_CONFIG,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { makePersistentGoalReactor } from "./PersistentGoalReactor.ts";
import { initialWorkerGoal } from "../../workjet/workerGoal.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { projectEvent } from "../projector.ts";

const now = "2026-10-09T21:00:00.000Z";
const id = ThreadId.make("parent");
const projectId = ProjectId.make("molecularity");
const makeThread = (): OrchestrationThreadShell => ({
  id,
  projectId,
  title: "Harness",
  modelSelection: { instanceId: ProviderInstanceId.make("greppy"), model: DEFAULT_MODEL },
  runtimeMode: "full-access",
  interactionMode: "default",
  workjetConfig: {
    ...DEFAULT_WORKJET_THREAD_CONFIG,
    schemaVersion: 2,
    team: {
      projectId,
      threadId: id,
      role: "specialist",
      parentThreadId: ThreadId.make("supervisor"),
      domain: "harness",
      goal: "Verify the approved outcome.",
      createdAt: now,
    },
    goal: initialWorkerGoal("Verify the approved outcome.", now),
  },
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
  session: {
    threadId: id,
    status: "ready",
    providerName: "greppy",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
  },
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const harness = Effect.fn("test.goalHarness")(function* (
  nativeGoal?: ProviderService["Service"]["nativeGoal"],
) {
  let current = makeThread();
  let sequence = 0;
  const starts: OrchestrationCommand[] = [];
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const crypto = yield* Crypto.Crypto;
  const receipts = new Map<string, number>();
  const signals = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
  const readModel = (): OrchestrationReadModel => ({
    snapshotSequence: sequence,
    updatedAt: now,
    projects: [],
    threads: [
      {
        ...current,
        deletedAt: current.deletedAt ?? null,
        messages: [],
        activities: [],
        checkpoints: [],
        proposedPlans: [],
      },
    ],
  });
  const engine = {
    streamDomainEvents: Stream.fromPubSub(events),
    readEvents: () => Stream.empty,
    latestSequence: Effect.sync(() => sequence),
    runTurnStartIfActive: <A, E, R>(
      threadId: ThreadId,
      action: Effect.Effect<A, E, R>,
      revision?:
        | number
        | {
            readonly revision: number;
            readonly status: "active" | "paused" | "blocked" | "complete";
          },
    ) =>
      Effect.gen(function* () {
        const config = current.workjetConfig;
        if (
          threadId !== current.id ||
          config.schemaVersion !== 2 ||
          config.goal?.status !== (typeof revision === "object" ? revision.status : "active") ||
          (revision !== undefined &&
            config.goal.revision !== (typeof revision === "object" ? revision.revision : revision))
        )
          return false;
        yield* action;
        return true;
      }),
    dispatch: Effect.fn("test.dispatch")(function* (command: OrchestrationCommand) {
      if (receipts.has(command.commandId)) return { sequence: receipts.get(command.commandId)! };
      const decided = yield* decideOrchestrationCommand({ command, readModel: readModel() });
      const planned = Array.isArray(decided) ? decided : [decided];
      for (const event of planned) {
        const committed = { ...event, sequence: ++sequence };
        const result = yield* projectEvent(readModel(), committed);
        current = { ...current, ...result.threads[0]! };
        yield* PubSub.publish(events, committed);
      }
      receipts.set(command.commandId, sequence);
      if (command.type === "thread.turn.start") {
        starts.push(command);
        current = { ...current, session: { ...current.session!, status: "starting" } };
        if (signals[starts.length - 1])
          yield* Deferred.succeed(signals[starts.length - 1]!, undefined);
      }
      return { sequence };
    }, Effect.provideService(Crypto.Crypto, crypto), Effect.orDie),
  } as OrchestrationEngineService["Service"];
  const query = {
    getThreadShellById: () => Effect.sync(() => Option.some(current)),
    getCommandReadModel: () => Effect.sync(readModel),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const providers = {
    nativeGoal,
    listSessions: () => Effect.succeed([]),
  } as unknown as ProviderService["Service"];
  const reactor = yield* makePersistentGoalReactor.pipe(
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provideService(ProjectionSnapshotQuery, query),
    Effect.provideService(ProviderService, providers),
  );
  const completeTurn = Effect.fn("test.completeTurn")(function* (value: string) {
    const turnId = TurnId.make(value);
    current = {
      ...current,
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: MessageId.make(value),
      },
      session: { ...current.session!, status: "ready", activeTurnId: null },
    };
    yield* PubSub.publish(events, {
      sequence: ++sequence,
      eventId: EventId.make(value),
      type: "thread.session-set",
      aggregateKind: "thread",
      aggregateId: id,
      occurredAt: now,
      commandId: CommandId.make(value),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: { threadId: id, session: current.session! },
    });
  });
  return {
    reactor,
    starts,
    signals,
    completeTurn,
    engine,
    read: () => current,
    replace: (thread: OrchestrationThreadShell) => {
      current = thread;
    },
  };
});

describe("persistent goal reactor", () => {
  it("automatically starts successive turns from persisted completions and stops at a recorded result", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          yield* h.reactor.start();
          yield* h.completeTurn("first");
          yield* Deferred.await(h.signals[0]!);
          yield* h.completeTurn("second");
          yield* Deferred.await(h.signals[1]!);
          yield* h.engine.dispatch({
            type: "thread.goal.set",
            commandId: CommandId.make("verified-complete"),
            threadId: id,
            status: "complete",
            reason: "Outcome verified with the required evidence.",
            createdAt: now,
          });
          yield* h.completeTurn("third");
          yield* h.reactor.drain;
          expect(h.starts).toHaveLength(2);
          const cfg = h.read().workjetConfig;
          expect(cfg.schemaVersion === 2 && cfg.goal?.status).toBe("complete");
          expect(cfg.schemaVersion === 2 && cfg.goal?.continuationCount).toBe(2);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it("recovers a pending continuation and admits its stable command only once", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const thread = h.read();
          if (thread.workjetConfig.schemaVersion !== 2 || !thread.workjetConfig.goal)
            throw new Error("missing goal");
          h.replace({
            ...thread,
            workjetConfig: {
              ...thread.workjetConfig,
              goal: {
                ...thread.workjetConfig.goal,
                pendingContinuation: {
                  commandId: CommandId.make("saved-continuation"),
                  messageId: MessageId.make("saved-continuation"),
                  createdAt: now,
                },
              },
            },
          });
          yield* h.reactor.start();
          yield* Deferred.await(h.signals[0]!);
          expect(h.starts).toHaveLength(1);
          expect(h.starts[0]?.commandId).toBe("saved-continuation");
          // The actual engine receipt boundary is exercised separately by the engine suite.
          yield* h.engine.dispatch(h.starts[0]!);
          expect(h.starts).toHaveLength(1);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it.each(["paused", "blocked", "complete"] as const)(
    "never revives a saved %s goal on startup",
    async (status) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness();
            const thread = h.read();
            if (thread.workjetConfig.schemaVersion !== 2 || !thread.workjetConfig.goal)
              throw new Error("missing goal");
            h.replace({
              ...thread,
              workjetConfig: {
                ...thread.workjetConfig,
                goal: { ...thread.workjetConfig.goal, status },
              },
            });
            yield* h.reactor.start();
            yield* h.completeTurn("old-completion");
            yield* h.reactor.drain;
            expect(h.starts).toHaveLength(0);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
  );

  it.each(["complete", "usageLimited", "blocked"] as const)(
    "persists native Codex %s without another automatic turn",
    async (status) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            let reads = 0;
            const h = yield* harness({
              get: () =>
                Effect.sync(() => {
                  reads++;
                  return { objective: "Verify the approved outcome.", status };
                }),
              set: () => Effect.die("terminal native goal must not be resumed"),
            });
            yield* h.reactor.start();
            yield* h.completeTurn("native-finished");
            yield* h.reactor.drain;
            const config = h.read().workjetConfig;
            expect(reads).toBeGreaterThan(0);
            expect(config.schemaVersion === 2 && config.goal?.status).toBe(
              status === "complete" ? "complete" : "blocked",
            );
            expect(h.starts).toHaveLength(0);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
  );

  it("records an unsupported native control as a blocker instead of emulating success", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({
            get: () =>
              Effect.fail({
                _tag: "UnsupportedNativeGoal",
                message: "unsupported native goal protocol",
              } as const),
            set: () => Effect.void,
          } as unknown as ProviderService["Service"]["nativeGoal"]);
          yield* h.reactor.start();
          yield* h.completeTurn("unsupported-native");
          yield* h.reactor.drain;
          const config = h.read().workjetConfig;
          expect(config.schemaVersion === 2 && config.goal?.status).toBe("blocked");
          expect(h.starts).toHaveLength(0);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
    "retains %s instead of silently continuing",
    async (field) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness();
            h.replace({ ...h.read(), [field]: true });
            yield* h.reactor.start();
            yield* h.completeTurn("awaiting-owner");
            yield* h.reactor.drain;
            expect(h.starts).toHaveLength(0);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
  );
});
