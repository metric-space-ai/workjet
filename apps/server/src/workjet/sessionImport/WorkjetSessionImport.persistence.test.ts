// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerformance from "node:perf_hooks";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  WORKJET_SESSION_IMPORT_MAX_SELECTION,
  type WorkjetSessionImportCandidate,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { expect, it } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { make } from "./WorkjetSessionImport.ts";

const NOW = "2026-10-02T12:00:00.000Z";
const title = (index: number) => `Archived work ${index}`;
const reply = (index: number) => `Preserved answer ${index}`;
const codexTranscript = (index: number) =>
  [
    {
      type: "session_meta",
      payload: { cwd: "/source/unavailable", model: "fixture-model" },
      timestamp: NOW,
    },
    {
      type: "response_item",
      timestamp: NOW,
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: title(index) }],
      },
    },
    {
      type: "response_item",
      timestamp: NOW,
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: reply(index) }],
      },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n";
const claudeTranscript = (index: number) =>
  [
    { type: "user", timestamp: NOW, message: { role: "user", content: title(index) } },
    { type: "assistant", timestamp: NOW, message: { role: "assistant", content: reply(index) } },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n";

it("imports every conversation from a >5000 mixed archive into real projects and survives reopening SQLite", async () => {
  const startedAt = NodePerformance.performance.now();
  const report = (phase: string, count = 0) =>
    console.info(
      "FULL_IMPORT_PROGRESS",
      phase,
      count,
      Math.round(NodePerformance.performance.now() - startedAt),
    );
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-full-import-"));
  const codexRoot = NodePath.join(root, "codex");
  const sessionRoot = NodePath.join(codexRoot, "sessions");
  const claudeRoot = NodePath.join(root, "claude");
  const claudeProjects = NodePath.join(claudeRoot, "projects", "archive");
  const workspace = NodePath.join(root, "workspace");
  const dbPath = NodePath.join(root, "persisted.sqlite");
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {},
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: codexRoot },
      claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, homePath: claudeRoot },
    },
  };
  const settingsService = {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(settings),
    updateSettings: () => Effect.die("fixture settings are read-only"),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  };
  const open = () =>
    ManagedRuntime.make(
      Layer.mergeAll(
        OrchestrationEngineLive.pipe(
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
        Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
        Layer.provideMerge(ServerConfig.layerTest(workspace, NodePath.join(root, "server"))),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
  let runtime: ReturnType<typeof open> | undefined;
  try {
    for (const directory of [sessionRoot, claudeProjects, workspace])
      await NodeFSP.mkdir(directory, { recursive: true });
    await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: 5001 }, (_, index) => index),
        (index) =>
          Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(sessionRoot, `${index}.jsonl`), codexTranscript(index)),
          ),
        { concurrency: 2, discard: true },
      ),
    );
    const claudeFile = NodePath.join(claudeProjects, "5001.jsonl");
    await NodeFSP.writeFile(claudeFile, claudeTranscript(5001));
    report("fixtures-ready", 5002);
    runtime = open();
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const importer = await runtime.runPromise(
      make.pipe(Effect.provideService(ServerSettingsService, settingsService)),
    );
    const existingProjectId = ProjectId.make("existing-import-project");
    const newProjectId = ProjectId.make("new-import-project");
    for (const [projectId, name] of [
      [existingProjectId, "Existing project"],
      [newProjectId, "New archive project"],
    ] as const) {
      const projectWorkspace = NodePath.join(workspace, projectId);
      await NodeFSP.mkdir(projectWorkspace);
      await runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`create-${projectId}`),
          projectId,
          title: name,
          workspaceRoot: projectWorkspace,
          createWorkspaceRootIfMissing: false,
          createdAt: NOW,
        }),
      );
    }
    report("projects-ready", 2);
    const candidates: WorkjetSessionImportCandidate[] = [];
    let offset = 0;
    let version: string | undefined;
    do {
      const page = await runtime.runPromise(importer.inspect({ limit: 100, offset }));
      expect(page.discoveryVersion).toMatch(/^[a-f0-9]{64}$/u);
      version ??= page.discoveryVersion;
      expect(page.discoveryVersion).toBe(version);
      candidates.push(...page.candidates);
      if (page.nextOffset == null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    } while (true);
    report("selection-ready", candidates.length);
    expect(candidates).toHaveLength(5002);
    expect(new Set(candidates.map((item) => item.candidateId)).size).toBe(5002);
    expect(candidates.filter((item) => item.source === "claude-code")).toHaveLength(1);
    for (let index = 0; index < candidates.length; index += WORKJET_SESSION_IMPORT_MAX_SELECTION) {
      const result = await runtime.runPromise(
        importer.importSessions({
          projectId: newProjectId,
          candidateIds: candidates
            .slice(index, index + WORKJET_SESSION_IMPORT_MAX_SELECTION)
            .map((item) => item.candidateId),
        }),
      );
      expect(
        result.items.every((item) => item.status === "imported" && item.importedMessages === 2),
      ).toBe(true);
      const completed = Math.min(index + WORKJET_SESSION_IMPORT_MAX_SELECTION, candidates.length);
      if (completed % 1000 === 0 || completed === candidates.length) report("imported", completed);
    }
    const first = candidates[0]!;
    const copy = await runtime.runPromise(
      importer.importSessions({ projectId: existingProjectId, candidateIds: [first.candidateId] }),
    );
    expect(copy.items[0]?.status).toBe("imported");
    const unchanged = await runtime.runPromise(
      importer.importSessions({
        projectId: newProjectId,
        candidateIds: candidates.slice(0, 20).map((item) => item.candidateId),
      }),
    );
    expect(unchanged.items.every((item) => item.status === "unchanged")).toBe(true);
    const before = await runtime.runPromise(query.getSnapshot());
    expect(before.threads).toHaveLength(5003);
    await runtime.dispose();
    runtime = open();
    const reopenedQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reopened = await runtime.runPromise(reopenedQuery.getSnapshot());
    report("reopened", reopened.threads.length);
    expect(reopened.threads.filter((thread) => thread.projectId === newProjectId)).toHaveLength(
      5002,
    );
    expect(
      reopened.threads.filter((thread) => thread.projectId === existingProjectId),
    ).toHaveLength(1);
    expect(reopened.threads.map((thread) => thread.id).sort()).toEqual(
      before.threads.map((thread) => thread.id).sort(),
    );
    const importedTitles = new Set<string>();
    for (const thread of reopened.threads) {
      const index = Number(thread.title.slice("Archived work ".length));
      expect(Number.isInteger(index) && index >= 0 && index < 5002).toBe(true);
      expect(thread.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: title(index) },
        { role: "assistant", text: reply(index) },
      ]);
      if (thread.projectId === newProjectId) importedTitles.add(thread.title);
    }
    expect(importedTitles.size).toBe(5002);
    const reopenedImporter = await runtime.runPromise(
      make.pipe(Effect.provideService(ServerSettingsService, settingsService)),
    );
    const persistedReceipt = await runtime.runPromise(
      reopenedImporter.importSessions({
        projectId: newProjectId,
        candidateIds: [first.candidateId],
      }),
    );
    expect(persistedReceipt.items[0]?.status).toBe("unchanged");
    await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: 5001 }, (_, index) => index),
        (index) =>
          Effect.promise(async () =>
            expect(
              await NodeFSP.readFile(NodePath.join(sessionRoot, `${index}.jsonl`), "utf8"),
            ).toBe(codexTranscript(index)),
          ),
        { concurrency: 2, discard: true },
      ),
    );
    expect(await NodeFSP.readFile(claudeFile, "utf8")).toBe(claudeTranscript(5001));
  } finally {
    await runtime?.dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}, 300_000);
