import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
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
import { makeSupervisorTickReactor } from "./SupervisorTickReactor.ts";

function runtimeLayer(db: string, dir: string) {
  return OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(db)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), dir)),
    Layer.provideMerge(NodeServices.layer),
  );
}
it.layer(NodeServices.layer)("persisted supervisor tick reactor", (it) => {
  it.effect(
    "collects SQL history, admits one concurrent tick, and retains state after restart",
    () =>
      Effect.scoped(Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-supervisor-tick-" });
        const db = path.join(dir, "state.sqlite");
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
              },
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
            const reactor = yield* makeSupervisorTickReactor.pipe(
              Effect.provide(
                Layer.mergeAll(
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
            const events = yield* Stream.runCollect(engine.readEvents(0, 100));
            expect(events.filter((e) => e.type === "thread.turn-start-requested")).toHaveLength(1);
            const sent = events.find((e) => e.type === "thread.message-sent");
            expect(sent?.type === "thread.message-sent" && sent.payload.role).toBe("system");
            const text = sent?.type === "thread.message-sent" ? sent.payload.text : "";
            expect(text).toContain("provider.timeout");
            expect(text).toContain("Repair startup");
            expect(text).toContain('"readyUnmerged":true');
            expect(text).not.toContain("unavailable");
            expect(reads).toBeGreaterThanOrEqual(1);
            expect(reads).toBeLessThanOrEqual(2);
            const before = yield* query.getCommandReadModel();
            const config = before.threads.find((t) => t.id === supervisor.id)!.workjetConfig;
            expect(config.schemaVersion === 2 && config.supervisorTick?.outcome).toBe("started");
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
      })),
  );
});
