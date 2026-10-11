/** Isolated loopback UI proof. Every transcript and database belongs to the explicit fixture home. */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandId, DEFAULT_WORKJET_THREAD_CONFIG, ProjectId, ProjectOverview, ThreadId, UsageDay } from "@workjet/contracts";
import { projectTokenCycle } from "@workjet/shared/projectTokenBudget";
import { ServerConfig } from "../src/config.ts";
import { layerConfig } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import * as Usage from "../src/usage/UsageService.ts";
import * as Settings from "../src/serverSettings.ts";
import catalog from "../src/usage/catalog/model-rates.json" with { type: "json" };

const homeArgument = process.env.WORKJET_BUDGET_FIXTURE_HOME;
if (!homeArgument || !resolve(homeArgument).startsWith(resolve(process.env.TMPDIR ?? "/tmp") + "/")) {
  throw new Error("Select an explicit fixture home below the task TMPDIR.");
}
const home = resolve(homeArgument);
const persistence = layerConfig;
const runtime = ManagedRuntime.make(Layer.mergeAll(
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionSnapshotQueryLive), Layer.provide(OrchestrationProjectionPipelineLive)),
  OrchestrationProjectionSnapshotQueryLive,
  Usage.layer.pipe(Layer.provide(Settings.layer)),
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer), Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive), Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer), Layer.provideMerge(persistence),
  Layer.provideMerge(Settings.layer), Layer.provideMerge(ServerConfig.layerTest(process.cwd(), home)),
  Layer.provideMerge(NodeServices.layer),
));
const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
const usage = await runtime.runPromise(Effect.service(Usage.UsageService));
const settings = await runtime.runPromise(Effect.service(Settings.ServerSettingsService));
const projectId = ProjectId.make("token-budget-ui-fixture");
const now = new Date().toISOString();
await runtime.runPromise(settings.updateSettings({ providers: { claudeAgent: { homePath: join(home, "claude") }, codex: { homePath: join(home, "codex") } } }));
const initial = await runtime.runPromise(query.getSnapshot());
if (!initial.projects.some(project => project.id === projectId)) {
  await runtime.runPromise(engine.dispatch({ type: "project.create", commandId: CommandId.make("fixture-project"), projectId, title: "Token budget fixture", workspaceRoot: null, createdAt: now }));
  await runtime.runPromise(engine.dispatch({ type: "project.meta.update", commandId: CommandId.make("fixture-budget"), projectId, expectedTokenBudgetRevision: 0, overview: { websiteUrl: null, slots: [null,null,null], tokenBudget: { limitBillions: 2.3, revision: 0, jourFixe: null } } }));
  const supervisor = (await runtime.runPromise(query.getSnapshot())).threads[0]!;
  const workerId = ThreadId.make("budget-fixture-worker");
  await runtime.runPromise(engine.dispatch({ type: "thread.create", commandId: CommandId.make("fixture-worker"), threadId: workerId, projectId,
    title: "Fixture worker", modelSelection: supervisor.modelSelection, runtimeMode: supervisor.runtimeMode, interactionMode: supervisor.interactionMode,
    workjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, role: "worker", team: { projectId, threadId: workerId, role: "worker", parentThreadId: supervisor.id, packageId: "fixture-package", goal: "Sanitized usage proof", createdAt: now } },
    branch: null, worktreePath: null, createdAt: now }));
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, provider_name, provider_session_id, updated_at)
      VALUES ('budget-fixture-worker', 'ready', 'claudeAgent', 'budget-fixture-session', ${now})`;
  }));
}
await mkdir(join(home, "claude/projects/fixture"), { recursive: true });
await writeFile(join(home, "claude/projects/fixture/session.jsonl"), JSON.stringify({
  type: "assistant", timestamp: now, sessionId: "budget-fixture-session",
  message: { id: "budget-fixture-usage", model: Object.keys(catalog.document)[0], role: "assistant", content: [{ type: "text" }],
    usage: { input_tokens: 1_000_000_000, cache_read_input_tokens: 600_000_000, output_tokens: 200_000_000 } },
}) + "\n");
const server = createServer(async (request, response) => {
  try {
    if (request.url !== "/fixture-budget") { response.writeHead(404).end(); return; }
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const overview = Schema.decodeUnknownSync(ProjectOverview)(JSON.parse(Buffer.concat(chunks).toString()));
      await runtime.runPromise(engine.dispatch({ type: "project.meta.update", commandId: CommandId.make("fixture-save-" + crypto.randomUUID()), projectId, expectedTokenBudgetRevision: overview.tokenBudget?.revision ?? 0, overview }));
    }
    const snapshot = await runtime.runPromise(query.getSnapshot());
    const project = snapshot.projects.find(project => project.id === projectId)!;
    const cycle = projectTokenCycle(Date.now(), project.overview?.tokenBudget?.jourFixe);
    const summary = await runtime.runPromise(usage.readSummary({ projectId, timeZone: cycle.timeZone, sinceDay: UsageDay.make(cycle.start.slice(0,10)), untilDay: UsageDay.make(cycle.end.slice(0,10)), sinceTime: cycle.start, untilTime: cycle.end }));
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ overview: project.overview, summary, cycle }));
  } catch (error) { response.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(error) })); }
});
server.listen(Number(process.env.WORKJET_BUDGET_FIXTURE_PORT ?? "18781"), "127.0.0.1", () => console.log("fixture backend ready"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.close(); void runtime.dispose().then(() => process.exit(0)); });
