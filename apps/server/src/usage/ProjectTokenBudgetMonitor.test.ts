// @effect-diagnostics nodeBuiltinImport:off -- Explicit disposable SQLite restart fixture.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { CommandId, DEFAULT_MODEL, ProjectId, UsageDay, type UsageSummary } from "@workjet/contracts";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { UsageService } from "./UsageService.ts";
import { make } from "./ProjectTokenBudgetMonitor.ts";

describe("durable token budget notices", () => {
  it("posts each threshold once after monitor restart, resets per cycle and never starts or stops a turn", async () => {
    const directory = await NodeFS.mkdtemp(NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "token-budget-restart-"));
    const persistence = makeSqlitePersistenceLive(NodePath.join(directory, "userdata/state.sqlite"));
    const layer = Layer.mergeAll(
      OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionSnapshotQueryLive), Layer.provide(OrchestrationProjectionPipelineLive)),
      OrchestrationProjectionSnapshotQueryLive,
    ).pipe(
      Layer.provide(ThreadBackgroundLiveness.layer), Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationEventStoreLive), Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer), Layer.provideMerge(persistence),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), directory)),
      Layer.provideMerge(NodeServices.layer),
    );
    let runtime = ManagedRuntime.make(layer);
    let now = Date.parse("2026-10-12T08:00:00Z");
    let tokens = 0;
    const summary = (): UsageSummary => ({
      contractVersion: 4, readAt: new Date(now).toISOString(), timeZone: "Europe/Berlin",
      sinceDay: UsageDay.make("2026-10-12"), untilDay: UsageDay.make("2026-10-19"),
      buckets: [{
        projectId: "budget-project", threadId: "worker", role: "worker", day: UsageDay.make("2026-10-12"),
        provider: "codex", model: DEFAULT_MODEL,
        totals: { uncachedInputTokens: tokens, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        costUsd: 0, cacheSavingsUsd: 0, costSource: "unpriced", records: 1, unpricedRecords: 1, sessions: 1,
      }],
      projectThreads: [], sources: [], pricing: { status: "unavailable", source: "fixture", fetchedAt: null, knownModels: 0 }, scanDurationMs: 0,
    });
    const createMonitor = () => runtime.runPromise(make(Effect.sync(() => now)).pipe(Effect.provideService(UsageService, { readSummary: () => Effect.succeed(summary()) })));
    try {
      let engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      let query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      await runtime.runPromise(engine.dispatch({ type: "project.create", commandId: CommandId.make("create-budget"), projectId: ProjectId.make("budget-project"), title: "Budget fixture", workspaceRoot: null, createdAt: new Date(now).toISOString() }));
      await runtime.runPromise(engine.dispatch({ type: "project.meta.update", commandId: CommandId.make("set-budget"), projectId: ProjectId.make("budget-project"), expectedTokenBudgetRevision: 0, overview: { websiteUrl: null, slots: [null,null,null], tokenBudget: { limitBillions: 1, revision: 0, jourFixe: null } } }));
      let monitor = await createMonitor();
      for (const threshold of [50,80,90,95,98]) {
        tokens = threshold * 10_000_000;
        await runtime.runPromise(monitor.runCycle);
        await runtime.runPromise(monitor.runCycle);
      }
      tokens = 1_000_000_001;
      await runtime.runPromise(monitor.runCycle);
      await runtime.dispose();
      runtime = ManagedRuntime.make(layer);
      engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      monitor = await createMonitor();
      await runtime.runPromise(monitor.runCycle);
      let model = await runtime.runPromise(query.getSnapshot());
      const supervisor = model.threads[0]!;
      expect(supervisor.messages.filter(m => m.role === "system")).toHaveLength(6);
      expect(supervisor.messages.some(m => m.text.includes("Budget überschritten"))).toBe(true);
      expect(supervisor.latestTurn).toBeNull();
      expect(supervisor.archivedAt).toBeNull();
      expect(model.projects[0]!.overview?.tokenBudget?.revision).toBe(1);
      now = Date.parse("2026-10-19T00:00:00Z");
      await runtime.runPromise(monitor.runCycle);
      model = await runtime.runPromise(query.getSnapshot());
      expect(model.threads[0]!.messages.filter(m => m.role === "system")).toHaveLength(12);
      await runtime.runPromise(engine.dispatch({ type: "project.meta.update", commandId: CommandId.make("clear-limit"), projectId: ProjectId.make("budget-project"), expectedTokenBudgetRevision: 1, overview: { websiteUrl: null, slots: [null,null,null], tokenBudget: { limitBillions: null, revision: 1, jourFixe: null } } }));
      now = Date.parse("2026-10-26T00:00:00Z");
      await runtime.runPromise(monitor.runCycle);
      expect((await runtime.runPromise(query.getSnapshot())).threads[0]!.messages).toHaveLength(12);
      await expect(runtime.runPromise(engine.dispatch({ type: "project.meta.update", commandId: CommandId.make("stale-budget"), projectId: ProjectId.make("budget-project"), expectedTokenBudgetRevision: 1, overview: { websiteUrl: null, slots: [null,null,null], tokenBudget: { limitBillions: 2.3, revision: 1, jourFixe: null } } }))).rejects.toThrow("Token budget changed");
    } finally { await runtime.dispose(); await NodeFS.rm(directory, { recursive: true, force: true }); }
  });
});
