import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  DEFAULT_MODEL,
  ProviderInstanceId,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  supervisorTickDueAt,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { OrchestrationLayerLive } from "../runtimeLayer.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { GitHubCli } from "../../sourceControl/GitHubCli.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { makeSupervisorTickReactor, SupervisorTickReactor } from "./SupervisorTickReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { PersistentGoalReactor } from "./PersistentGoalReactor.ts";
import { WorkerSupervisorDecisionReactor } from "./WorkerSupervisorDecisionReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { UsageService } from "../../usage/UsageService.ts";
import { SupervisorMeetingPreparation } from "../../workjet/SupervisorMeetingPreparation.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";

/** Provider runtimes the mocked server currently drives, by thread id. */
function providerServiceWithLiveThreads(live: ReadonlySet<string>) {
  return Layer.mock(ProviderService)({
    listSessions: () =>
      Effect.succeed(
        [...live].map((threadId) => ({
          provider: "codex" as never,
          status: "running" as const,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          threadId: ThreadId.make(threadId),
          createdAt: "2026-10-15T00:00:00.000Z",
          updatedAt: "2026-10-15T00:00:00.000Z",
        })),
      ),
  });
}

function runtimeLayer(db: string, dir: string) {
  return OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(db)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), dir)),
    Layer.provideMerge(NodeServices.layer),
  );
}
it.layer(NodeServices.layer)("persisted supervisor tick reactor", (it) => {
  it.effect("restores an unconsumed first schedule from SQLite after server restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-supervisor-first-tick-" });
        const db = path.join(dir, "state.sqlite");
        const now = yield* DateTime.now;
        const createdAt = DateTime.formatIso(now);
        const firstTickAt = DateTime.formatIso(DateTime.add(now, { minutes: 15 }));
        const threadId = yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const query = yield* ProjectionSnapshotQuery;
            yield* engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("initial-restart-project"),
              projectId: ProjectId.make("initial-restart-project"),
              title: "Initial restart",
              workspaceRoot: null,
              createdAt,
            });
            const model = yield* query.getCommandReadModel();
            const id = model.threads[0]!.id;
            yield* engine.dispatch({
              type: "thread.supervisor.tick.schedule",
              commandId: CommandId.make("initial-restart-schedule"),
              threadId: id,
              firstTickAt,
              createdAt,
            });
            return id;
          }).pipe(Effect.provide(runtimeLayer(db, dir))),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const query = yield* ProjectionSnapshotQuery;
            const model = yield* query.getCommandReadModel();
            const config = model.threads.find((thread) => thread.id === threadId)!.workjetConfig;
            expect(config.schemaVersion === 2 && config.supervisorTick).toMatchObject({
              firstTickAt,
              lastTickAt: createdAt,
              lastControlAt: null,
              outcome: "scheduled",
            });
            expect(
              supervisorTickDueAt(
                createdAt,
                undefined,
                config.schemaVersion === 2 ? config.supervisorTick : undefined,
              ),
            ).toBe(Date.parse(firstTickAt));
          }).pipe(Effect.provide(runtimeLayer(db, dir))),
        );
      }),
    ),
  );

  it.effect(
    "collects SQL history, admits one concurrent tick, and retains state after restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-supervisor-tick-" });
          const db = path.join(dir, "state.sqlite");
          const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
          yield* Effect.addFinalizer(() => Effect.sync(() => random.mockRestore()));
          const now = yield* DateTime.now;
          const createdAt = DateTime.formatIso(DateTime.add(now, { hours: -3 }));
          const errorAt = DateTime.formatIso(DateTime.add(now, { minutes: -1 }));
          const projectId = ProjectId.make("reactor-project");

          const saved = yield* Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* OrchestrationEngineService;
              const query = yield* ProjectionSnapshotQuery;
              yield* engine.dispatch({
                type: "project.create",
                commandId: CommandId.make("reactor-create"),
                projectId,
                title: "Control rounds",
                workspaceRoot: null,
                createdAt,
              });
              yield* engine.dispatch({
                type: "project.meta.update",
                commandId: CommandId.make("reactor-repo"),
                projectId,
                overview: {
                  websiteUrl: null,
                  slots: [null, null, null],
                  repositoryUrl: "https://github.com/metric-space-ai/workjet",
                  tokenBudget: { limitBillions: 2.3, revision: 0, jourFixe: null },
                },
                expectedTokenBudgetRevision: 0,
              });
              const model = yield* query.getCommandReadModel();
              const supervisor = model.threads[0]!;
              yield* engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make("failure"),
                threadId: supervisor.id,
                activity: {
                  id: EventId.make("failure"),
                  tone: "error",
                  kind: "provider.timeout",
                  summary: "Turn timed out",
                  payload: {},
                  turnId: null,
                  createdAt: errorAt,
                },
                createdAt: errorAt,
              });
              const worker = ThreadId.make("reactor-worker");
              yield* engine.dispatch({
                type: "thread.create",
                commandId: CommandId.make("reactor-worker-create"),
                threadId: worker,
                projectId,
                title: "Repair",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: DEFAULT_MODEL,
                },
                runtimeMode: DEFAULT_RUNTIME_MODE,
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                workjetConfig: {
                  ...DEFAULT_WORKJET_THREAD_CONFIG,
                  team: {
                    role: "specialist",
                    projectId,
                    threadId: worker,
                    parentThreadId: supervisor.id,
                    domain: "startup",
                    goal: "Repair startup",
                    createdAt,
                  },
                },
                branch: null,
                worktreePath: null,
                createdAt,
              });
              let reads = 0;
              let preparations = 0;
              const live = new Set<string>();
              const reactor = yield* makeSupervisorTickReactor.pipe(
                Effect.provide(
                  Layer.mergeAll(
                    providerServiceWithLiveThreads(live),
                    Layer.mock(SupervisorMeetingPreparation)({
                      run: () =>
                        Effect.sync(() => {
                          preparations++;
                        }),
                    }),
                    Layer.succeed(
                      UsageService,
                      UsageService.of({
                        readSummary: (input) =>
                          Effect.succeed({
                            contractVersion: 4,
                            readAt: errorAt,
                            timeZone: input.timeZone,
                            sinceDay: input.sinceDay,
                            untilDay: input.untilDay,
                            buckets: [
                              {
                                day: input.sinceDay,
                                provider: "codex",
                                model: DEFAULT_MODEL,
                                totals: {
                                  uncachedInputTokens: 2e9,
                                  cachedInputTokens: 0.3e9,
                                  outputTokens: 0.46e9,
                                  cacheCreationTokens: 0,
                                  reasoningTokens: 0,
                                },
                                costUsd: 0,
                                cacheSavingsUsd: 0,
                                costSource: "unpriced",
                                records: 1,
                                unpricedRecords: 1,
                                sessions: 1,
                              },
                            ],
                            projectThreads: [],
                            sources: [],
                            pricing: {
                              status: "unavailable",
                              source: "fixture",
                              fetchedAt: null,
                              knownModels: 0,
                            },
                            scanDurationMs: 0,
                          }),
                      }),
                    ),
                    Layer.mock(GitHubCli)({
                      execute: () => {
                        reads++;
                        return Effect.succeed({
                          stdout: JSON.stringify([
                            {
                              number: 12,
                              title: "Repair",
                              url: "https://github.com/metric-space-ai/workjet/pull/12",
                              headRefName: "repair",
                              createdAt,
                              updatedAt: createdAt,
                              isDraft: false,
                              author: { login: "worker" },
                              statusCheckRollup: [{ conclusion: "SUCCESS" }],
                              mergeStateStatus: "CLEAN",
                            },
                          ]),
                          stderr: "",
                          exitCode: ChildProcessSpawner.ExitCode(0),
                          stdoutTruncated: false,
                          stderrTruncated: false,
                        });
                      },
                    }),
                    Layer.mock(SourceControlProviderRegistry)({}),
                  ),
                ),
              );
              yield* Effect.all([reactor.reconcile(), reactor.reconcile()], { concurrency: 2 });
              const planned = yield* query.getCommandReadModel();
              const plannedConfig = planned.threads.find(
                (t) => t.id === supervisor.id,
              )!.workjetConfig;
              const initialState =
                plannedConfig.schemaVersion === 2 ? plannedConfig.supervisorTick : undefined;
              expect(initialState?.outcome).toBe("scheduled");
              expect(Date.parse(initialState!.firstTickAt!)).toBeGreaterThanOrEqual(
                DateTime.toEpochMillis(now),
              );
              expect(Date.parse(initialState!.firstTickAt!)).toBeLessThan(
                DateTime.toEpochMillis(now) + 30 * 60_000,
              );
              expect(reads).toBe(0);
              expect(preparations).toBe(0);
              const initialEvents = yield* Stream.runCollect(engine.readEvents(0, 100));
              expect(
                initialEvents.filter((event) => event.type === "thread.turn-start-requested"),
              ).toHaveLength(0);
              expect(
                initialEvents.filter(
                  (event) =>
                    event.type === "thread.workjet-config-set" &&
                    event.payload.workjetConfig.schemaVersion === 2 &&
                    event.payload.workjetConfig.supervisorTick?.outcome === "scheduled",
                ),
              ).toHaveLength(1);
              yield* TestClock.adjust(Duration.minutes(31));
              yield* Effect.all([reactor.reconcile(), reactor.reconcile()], { concurrency: 2 });
              const events = yield* Stream.runCollect(engine.readEvents(0, 100));
              expect(events.filter((e) => e.type === "thread.turn-start-requested")).toHaveLength(
                1,
              );
              const sent = events.find((e) => e.type === "thread.message-sent");
              expect(sent?.type === "thread.message-sent" && sent.payload.role).toBe("system");
              const text = sent?.type === "thread.message-sent" ? sent.payload.text : "";
              expect(text).toContain("provider.timeout");
              expect(text).toContain("Repair startup");
              expect(text).toContain('"readyUnmerged":true');
              expect(text).toContain('"consumedTokens":2760000000');
              expect(text).toContain('"limitBillions":2.3');
              expect(text).toMatch(/"usedPercent":120(?:[.,}])/u);
              expect(text).not.toContain("unavailable");
              expect(reads).toBeGreaterThanOrEqual(1);
              expect(reads).toBeLessThanOrEqual(2);
              expect(preparations).toBeGreaterThanOrEqual(1);
              const admittedPreparations = preparations;
              // The provider adopts the admitted start; an unadopted start would be retried (#717).
              live.add(supervisor.id);
              const adoptedAt = DateTime.formatIso(yield* DateTime.now);
              yield* engine.dispatch({
                type: "thread.session.set",
                commandId: CommandId.make("test:supervisor-session-running"),
                threadId: supervisor.id,
                session: {
                  threadId: supervisor.id,
                  status: "running",
                  providerName: "codex",
                  runtimeMode: "approval-required",
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: adoptedAt,
                },
                createdAt: adoptedAt,
              });
              yield* TestClock.adjust(Duration.minutes(31));
              yield* reactor.reconcile();
              expect(preparations).toBe(admittedPreparations);
              const before = yield* query.getCommandReadModel();
              const config = before.threads.find((t) => t.id === supervisor.id)!.workjetConfig;
              expect(config.schemaVersion === 2 && config.supervisorTick?.outcome).toBe(
                "skipped-busy",
              );
              // A session backed by a live provider runtime is left untouched.
              expect(before.threads.find((t) => t.id === supervisor.id)!.session?.status).toBe(
                "running",
              );
              return {
                threadId: supervisor.id,
                state: config.schemaVersion === 2 ? config.supervisorTick : undefined,
              };
            }).pipe(Effect.provide(runtimeLayer(db, dir))),
          );

          // A fresh scope reconnects to the same file after all first-scope services closed.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const query = yield* ProjectionSnapshotQuery;
              const engine = yield* OrchestrationEngineService;
              const restored = yield* query.getCommandReadModel();
              const thread = restored.threads.find((t) => t.id === saved.threadId)!;
              const state =
                thread.workjetConfig.schemaVersion === 2
                  ? thread.workjetConfig.supervisorTick
                  : undefined;
              expect(state).toEqual(saved.state);
              const dueAt = supervisorTickDueAt(createdAt, undefined, state)!;
              expect(dueAt).toBeGreaterThan(DateTime.toEpochMillis(yield* DateTime.now));
              yield* engine.dispatch({
                type: "thread.supervisor.tick",
                commandId: CommandId.make("server:supervisor-tick:recovery"),
                threadId: saved.threadId,
                scheduledAt: DateTime.formatIso(DateTime.makeUnsafe(dueAt)),
                createdAt: DateTime.formatIso(DateTime.makeUnsafe(dueAt + 3600000)),
                text: "Recovery control",
              });
              const after = yield* Stream.runCollect(engine.readEvents(0, 100));
              expect(after.filter((e) => e.type === "thread.turn-start-requested")).toHaveLength(1);
              expect(
                after.findLast((e) => e.type === "thread.activity-appended")?.payload,
              ).toMatchObject({
                activity: { summary: "Kontrollrunde übersprungen: Supervisor beschäftigt" },
              });
            }).pipe(Effect.provide(runtimeLayer(db, dir))),
          );
        }),
      ),
  );
});

/** Sibling reactors are inert here: only the startup recovery is under test. */
const inertSiblingReactors = Layer.mergeAll(
  Layer.mock(SupervisorTickReactor)({ start: () => Effect.void }),
  Layer.mock(WorkerSupervisorDecisionReactor)({ start: () => Effect.void }),
  Layer.mock(PersistentGoalReactor)({ start: () => Effect.void }),
  Layer.mock(ProviderRuntimeIngestionService)({ start: () => Effect.void }),
  Layer.mock(ProviderCommandReactor)({ start: () => Effect.void }),
  Layer.mock(CheckpointReactor)({ start: () => Effect.void }),
  Layer.mock(ThreadDeletionReactor)({ start: () => Effect.void }),
  Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ start: () => Effect.void }),
);

const tickSources = Layer.mergeAll(
  Layer.mock(GitHubCli)({}),
  Layer.mock(SourceControlProviderRegistry)({}),
);

/**
 * Previous server process: a project supervisor whose turn was running when
 * the process died. Nothing in the new process will ever end that turn.
 */
const seedOrphanedSupervisor = (
  db: string,
  dir: string,
  status: "running" | "starting",
  projectId: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(DateTime.add(now, { hours: -3 }));
      const sessionAt = DateTime.formatIso(DateTime.add(now, { hours: -2 }));
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(projectId + ":create"),
        projectId: ProjectId.make(projectId),
        title: "Orphaned supervisor",
        workspaceRoot: null,
        createdAt,
      });
      const supervisor = (yield* query.getCommandReadModel()).threads[0]!;
      yield* engine.dispatch({
        type: "thread.supervisor.tick.schedule",
        commandId: CommandId.make(projectId + ":schedule"),
        threadId: supervisor.id,
        firstTickAt: DateTime.formatIso(DateTime.add(now, { minutes: 15 })),
        createdAt: DateTime.formatIso(now),
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(projectId + ":session"),
        threadId: supervisor.id,
        session: {
          threadId: supervisor.id,
          status,
          providerName: "codex",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          activeTurnId: status === "running" ? TurnId.make(projectId + ":turn") : null,
          lastError: null,
          updatedAt: sessionAt,
        },
        createdAt: sessionAt,
      });
      const seeded = (yield* query.getCommandReadModel()).threads.find(
        (t) => t.id === supervisor.id,
      )!;
      expect(seeded.session?.status).toBe(status);
      return supervisor.id;
    }).pipe(Effect.provide(runtimeLayer(db, dir))),
  );

const orphanSettlements = (events: ReadonlyArray<{ type: string; commandId: string | null }>) =>
  events.filter(
    (event) =>
      event.type === "thread.session-set" &&
      (event.commandId ?? "").startsWith("server:orphaned-session:"),
  );

it.layer(NodeServices.layer)("orphaned supervisor sessions after a server restart", (it) => {
  it.effect("startup settles the orphaned running turn and the next control round runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-orphaned-startup-" });
        const db = path.join(dir, "state.sqlite");
        const threadId = yield* seedOrphanedSupervisor(db, dir, "running", "orphan-startup");

        yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const query = yield* ProjectionSnapshotQuery;
            const providers = providerServiceWithLiveThreads(new Set());
            const reactor = yield* makeOrchestrationReactor.pipe(
              Effect.provide(Layer.mergeAll(inertSiblingReactors, providers)),
            );
            yield* reactor.start();

            const recovered = (yield* query.getCommandReadModel()).threads.find(
              (t) => t.id === threadId,
            )!;
            expect(recovered.session).toMatchObject({ status: "stopped", activeTurnId: null });
            expect(recovered.latestTurn).toMatchObject({
              turnId: "orphan-startup:turn",
              state: "interrupted",
            });
            expect(recovered.latestTurn?.completedAt).not.toBeNull();

            // A second start in the same process finds nothing left to settle.
            yield* reactor.start();
            const ticks = yield* makeSupervisorTickReactor.pipe(
              Effect.provide(Layer.mergeAll(providers, tickSources)),
            );
            yield* TestClock.adjust(Duration.minutes(31));
            yield* Effect.all([ticks.reconcile(), ticks.reconcile()], { concurrency: 2 });

            const events = yield* Stream.runCollect(engine.readEvents(0, 200));
            expect(orphanSettlements(events)).toHaveLength(1);
            expect(events.filter((e) => e.type === "thread.turn-start-requested")).toHaveLength(1);
            const rounds = events.filter(
              (e) =>
                e.type === "thread.activity-appended" &&
                e.payload.activity.kind === "supervisor.control-round",
            );
            expect(
              rounds.map(
                (e) => e.type === "thread.activity-appended" && e.payload.activity.summary,
              ),
            ).toEqual(["Kontrollrunde gestartet"]);
            const after = (yield* query.getCommandReadModel()).threads.find(
              (t) => t.id === threadId,
            )!;
            expect(
              after.workjetConfig.schemaVersion === 2 &&
                after.workjetConfig.supervisorTick?.outcome,
            ).toBe("started");
          }).pipe(Effect.provide(runtimeLayer(db, dir))),
        );
      }),
    ),
  );

  it.effect("a control round settles an orphaned starting session instead of skipping", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-orphaned-tick-" });
        const db = path.join(dir, "state.sqlite");
        const threadId = yield* seedOrphanedSupervisor(db, dir, "starting", "orphan-tick");

        yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const query = yield* ProjectionSnapshotQuery;
            // No startup recovery here: the control round alone must notice.
            const ticks = yield* makeSupervisorTickReactor.pipe(
              Effect.provide(
                Layer.mergeAll(providerServiceWithLiveThreads(new Set()), tickSources),
              ),
            );
            yield* TestClock.adjust(Duration.minutes(31));
            yield* Effect.all([ticks.reconcile(), ticks.reconcile()], { concurrency: 2 });

            const events = yield* Stream.runCollect(engine.readEvents(0, 200));
            expect(orphanSettlements(events)).toHaveLength(1);
            expect(events.filter((e) => e.type === "thread.turn-start-requested")).toHaveLength(1);
            expect(
              events.some(
                (e) =>
                  e.type === "thread.activity-appended" &&
                  e.payload.activity.summary ===
                    "Kontrollrunde übersprungen: Supervisor beschäftigt",
              ),
            ).toBe(false);
            const after = (yield* query.getCommandReadModel()).threads.find(
              (t) => t.id === threadId,
            )!;
            expect(
              after.workjetConfig.schemaVersion === 2 &&
                after.workjetConfig.supervisorTick?.outcome,
            ).toBe("started");
          }).pipe(Effect.provide(runtimeLayer(db, dir))),
        );
      }),
    ),
  );

  it.effect("a session with a live provider runtime is neither settled nor interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-live-session-" });
        const db = path.join(dir, "state.sqlite");
        const threadId = yield* seedOrphanedSupervisor(db, dir, "running", "live-session");

        yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const query = yield* ProjectionSnapshotQuery;
            const providers = providerServiceWithLiveThreads(new Set([threadId]));
            const reactor = yield* makeOrchestrationReactor.pipe(
              Effect.provide(Layer.mergeAll(inertSiblingReactors, providers)),
            );
            yield* reactor.start();
            const ticks = yield* makeSupervisorTickReactor.pipe(
              Effect.provide(Layer.mergeAll(providers, tickSources)),
            );
            yield* TestClock.adjust(Duration.minutes(31));
            yield* ticks.reconcile();

            const events = yield* Stream.runCollect(engine.readEvents(0, 200));
            expect(orphanSettlements(events)).toHaveLength(0);
            expect(events.filter((e) => e.type === "thread.turn-start-requested")).toHaveLength(0);
            const after = (yield* query.getCommandReadModel()).threads.find(
              (t) => t.id === threadId,
            )!;
            expect(after.session).toMatchObject({
              status: "running",
              activeTurnId: "live-session:turn",
            });
            expect(after.latestTurn?.state).toBe("running");
            expect(
              after.workjetConfig.schemaVersion === 2 &&
                after.workjetConfig.supervisorTick?.outcome,
            ).toBe("skipped-busy");
          }).pipe(Effect.provide(runtimeLayer(db, dir))),
        );
      }),
    ),
  );
});
