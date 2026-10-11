import { describe, expect, it } from "vite-plus/test";
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
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { OrchestrationLayerLive } from "../runtimeLayer.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { GitHubCli } from "../../sourceControl/GitHubCli.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { makeSupervisorTickReactor } from "./SupervisorTickReactor.ts";

function runtime(db: string) {
  return ManagedRuntime.make(
    OrchestrationLayerLive.pipe(
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(makeSqlitePersistenceLive(db)),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "supervisor-control-round-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
}
describe("persisted supervisor tick reactor", () => {
  it("collects real SQL history, dispatches one tick despite concurrent recovery, and retains state after restart", async () => {
    const { fs, path } = await Effect.runPromise(Effect.gen(function* () {
      return { fs: yield* FileSystem.FileSystem, path: yield* Path.Path };
    }).pipe(Effect.provide(NodeServices.layer)));
    const dir = await Effect.runPromise(fs.makeTempDirectory({ prefix: "workjet-supervisor-tick-" }));
    const db = path.join(dir, "state.sqlite");
    let system = runtime(db);
    try {
      const engine = await system.runPromise(Effect.service(OrchestrationEngineService));
      const query = await system.runPromise(Effect.service(ProjectionSnapshotQuery));
      const now = await Effect.runPromise(DateTime.now);
      const createdAt = DateTime.formatIso(DateTime.add(now, { hours: -3 }));
      const errorAt = DateTime.formatIso(DateTime.add(now, { minutes: -1 }));
      const projectId = ProjectId.make("reactor-project");
      await system.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("reactor-create"),
          projectId,
          title: "Control rounds",
          workspaceRoot: null,
          createdAt,
        }),
      );
      await system.runPromise(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("reactor-repo"),
          projectId,
          overview: {
            websiteUrl: null,
            slots: [null, null, null],
            repositoryUrl: "https://github.com/metric-space-ai/workjet",
          },
        }),
      );
      const model = await system.runPromise(query.getCommandReadModel());
      const supervisor = model.threads[0]!;
      await system.runPromise(
        engine.dispatch({
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
        }),
      );
      const worker = ThreadId.make("reactor-worker");
      await system.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("reactor-worker-create"),
          threadId: worker,
          projectId,
          title: "Repair",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
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
        }),
      );
      let reads = 0;
      const reactor = await system.runPromise(
        makeSupervisorTickReactor.pipe(
          Effect.provide(Layer.mock(GitHubCli)({
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
                exitCode: 0,
              });
            },
          })),
          Effect.provide(Layer.mock(SourceControlProviderRegistry)({})),
        ),
      );
      await system.runPromise(
        Effect.all([reactor.reconcile(), reactor.reconcile()], { concurrency: 2 }),
      );
      const events = await system.runPromise(Stream.runCollect(engine.readEvents(0, 100)));
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
      const before = await system.runPromise(query.getCommandReadModel());
      const config = before.threads.find((t) => t.id === supervisor.id)!.workjetConfig;
      expect(config.schemaVersion === 2 && config.supervisorTick?.outcome).toBe("started");
      await system.dispose();
      system = runtime(db);
      const restoredQuery = await system.runPromise(Effect.service(ProjectionSnapshotQuery));
      const restored = await system.runPromise(restoredQuery.getCommandReadModel());
      const restoredThread = restored.threads.find((t) => t.id === supervisor.id)!;
      const state =
        restoredThread.workjetConfig.schemaVersion === 2
          ? restoredThread.workjetConfig.supervisorTick
          : undefined;
      expect(state).toEqual(config.schemaVersion === 2 ? config.supervisorTick : undefined);
      expect(supervisorTickDueAt(createdAt, undefined, state)).toBeGreaterThan(DateTime.toEpochMillis(await Effect.runPromise(DateTime.now)));
      const restoredEngine = await system.runPromise(Effect.service(OrchestrationEngineService));
      const dueAt = supervisorTickDueAt(createdAt, undefined, state)!;
      await system.runPromise(
        restoredEngine.dispatch({
          type: "thread.supervisor.tick",
          commandId: CommandId.make("server:supervisor-tick:recovery"),
          threadId: supervisor.id,
          scheduledAt: DateTime.formatIso(DateTime.makeUnsafe(dueAt)),
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(dueAt + 3600000)),
          text: "Recovery control",
        }),
      );
      const after = await system.runPromise(Stream.runCollect(restoredEngine.readEvents(0, 100)));
      expect(after.filter((e) => e.type === "thread.turn-start-requested")).toHaveLength(1);
      expect(
        after.filter((e) => e.type === "thread.activity-appended").at(-1)?.payload,
      ).toMatchObject({
        activity: { summary: "Kontrollrunde übersprungen: Supervisor beschäftigt" },
      });
    } finally {
      await system.dispose();
      await Effect.runPromise(fs.remove(dir, { recursive: true, force: true }));
    }
  });
});

