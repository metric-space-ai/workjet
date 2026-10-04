// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  MessageId,
  ProviderInstanceId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  type OrchestrationCommand,
  WORKJET_SESSION_IMPORT_MAX_SELECTION,
  type WorkjetSessionImportCandidate,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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

const runtimeLayer = (dbPath: string, workspace: string, root: string) =>
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
  );

it.live("rolls back a fresh thread when its first message fails, then safely retries", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-atomic-import-")),
      ),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const workspace = NodePath.join(root, "workspace");
    yield* Effect.promise(() => NodeFSP.mkdir(workspace));
    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("atomic-project");
      const threadId = ThreadId.make("atomic-copy");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("atomic-project-create"),
        projectId,
        title: "Destination",
        workspaceRoot: workspace,
        createWorkspaceRootIfMissing: false,
        createdAt: NOW,
      });
      const command: Extract<OrchestrationCommand, { type: "thread.history.import" }> = {
        type: "thread.history.import",
        commandId: CommandId.make("atomic-first"),
        threadId,
        bootstrap: {
          createThread: {
            projectId,
            title: "Atomic copy",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "fixture-model",
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
            branch: null,
            worktreePath: null,
            createdAt: NOW,
          },
        },
        messages: [
          {
            messageId: MessageId.make("atomic-message"),
            role: "user",
            text: "Preserved",
            createdAt: NOW,
          },
        ],
        createdAt: NOW,
      };
      yield* sql`CREATE TRIGGER reject_import_message BEFORE INSERT ON orchestration_events
        WHEN NEW.event_type = 'thread.message-sent'
        BEGIN SELECT RAISE(ABORT, 'fixture import failure'); END`;
      yield* engine.dispatch(command).pipe(Effect.flip);
      expect((yield* query.getSnapshot()).threads).toHaveLength(0);
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${threadId}`;
      expect(rows[0]?.count).toBe(0);
      yield* sql`DROP TRIGGER reject_import_message`;
      yield* engine.dispatch({ ...command, commandId: CommandId.make("atomic-retry") });
      const snapshot = yield* query.getSnapshot();
      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0]?.messages).toMatchObject([
        { role: "user", text: "Preserved", turnId: null },
      ]);
      expect(snapshot.threads[0]?.session).toBeNull();
      expect(snapshot.threads[0]?.latestTurn).toBeNull();
      const chunkThreadId = ThreadId.make("chunked-copy");
      yield* engine.dispatch({
        ...command,
        commandId: CommandId.make("chunked-first"),
        threadId: chunkThreadId,
        messages: Array.from({ length: 200 }, (_, index) => ({
          messageId: MessageId.make(`chunk-${index}`),
          role: "user" as const,
          text: `Preserved ${index}`,
          createdAt: NOW,
        })),
      });
      yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("delete-between-chunks"),
        projectId,
        force: true,
      });
      const beforeAppend = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${chunkThreadId}`;
      const appendError = yield* engine
        .dispatch({
          type: "thread.history.import",
          commandId: CommandId.make("chunked-second"),
          threadId: chunkThreadId,
          messages: [
            {
              messageId: MessageId.make("chunk-200"),
              role: "assistant",
              text: "Must not append",
              createdAt: NOW,
            },
          ],
          createdAt: NOW,
        })
        .pipe(Effect.flip);
      expect(appendError._tag).toBe("OrchestrationCommandInvariantError");
      const afterAppend = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${chunkThreadId}`;
      expect(afterAppend[0]?.count).toBe(beforeAppend[0]?.count);
      const retainedMessages = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = ${chunkThreadId}`;
      expect(retainedMessages[0]?.count).toBe(200);
    }).pipe(
      Effect.provide(runtimeLayer(NodePath.join(root, "persisted.sqlite"), workspace, root)),
      Effect.scoped,
    );
  }),
);

it.live(
  "imports every conversation from a >5000 mixed archive into real projects and survives reopening SQLite",
  () =>
    Effect.gen(function* () {
      const startedAt = NodePerfHooks.performance.now();
      const measurements = {
        dispatch: { calls: 0, elapsedMs: 0 },
        projectQuery: { calls: 0, elapsedMs: 0 },
        threadQuery: { calls: 0, elapsedMs: 0 },
      };
      const measured = <A, E, R>(kind: keyof typeof measurements, effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          const started = NodePerfHooks.performance.now();
          return effect.pipe(
            Effect.onExit(() =>
              Effect.sync(() => {
                measurements[kind].calls += 1;
                measurements[kind].elapsedMs += NodePerfHooks.performance.now() - started;
              }),
            ),
          );
        });
      const report = (phase: string, count = 0) =>
        Effect.logInfo(
          "FULL_IMPORT_PROGRESS",
          phase,
          count,
          Math.round(NodePerfHooks.performance.now() - startedAt),
          Object.fromEntries(
            Object.entries(measurements).map(([kind, value]) => [
              kind,
              { calls: value.calls, elapsedMs: Math.round(value.elapsedMs) },
            ]),
          ),
        );
      const root = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-full-import-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
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
      const live = runtimeLayer(dbPath, workspace, root);
      for (const directory of [sessionRoot, claudeProjects, workspace]) {
        yield* Effect.promise(() => NodeFSP.mkdir(directory, { recursive: true }));
      }
      yield* Effect.forEach(
        Array.from({ length: 5001 }, (_, index) => index),
        (index) =>
          Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(sessionRoot, `${index}.jsonl`), codexTranscript(index)),
          ),
        { concurrency: 2, discard: true },
      );
      const claudeFile = NodePath.join(claudeProjects, "5001.jsonl");
      yield* Effect.promise(() => NodeFSP.writeFile(claudeFile, claudeTranscript(5001)));
      yield* report("fixtures-ready", 5002);
      const existingProjectId = ProjectId.make("existing-import-project");
      const newProjectId = ProjectId.make("new-import-project");
      const { before, first } = yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery;
        const importer = yield* make.pipe(
          Effect.provideService(ServerSettingsService, settingsService),
          Effect.provideService(OrchestrationEngineService, {
            ...engine,
            dispatch: (command) => measured("dispatch", engine.dispatch(command)),
          }),
          Effect.provideService(ProjectionSnapshotQuery, {
            ...query,
            getProjectShellById: (id) => measured("projectQuery", query.getProjectShellById(id)),
            getActiveProjectByWorkspaceRoot: (path) =>
              measured("projectQuery", query.getActiveProjectByWorkspaceRoot(path)),
            getThreadShellById: (id) => measured("threadQuery", query.getThreadShellById(id)),
            getThreadDetailById: (id) => measured("threadQuery", query.getThreadDetailById(id)),
          }),
        );
        for (const [projectId, name] of [
          [existingProjectId, "Existing project"],
          [newProjectId, "New archive project"],
        ] as const) {
          const projectWorkspace = NodePath.join(workspace, projectId);
          yield* Effect.promise(() => NodeFSP.mkdir(projectWorkspace));
          yield* engine.dispatch({
            type: "project.create",
            commandId: CommandId.make(`create-${projectId}`),
            projectId,
            title: name,
            workspaceRoot: projectWorkspace,
            createWorkspaceRootIfMissing: false,
            createdAt: NOW,
          });
        }
        yield* report("projects-ready", 2);
        const candidates: WorkjetSessionImportCandidate[] = [];
        let offset = 0;
        let version: string | undefined;
        let hasNextPage = true;
        do {
          const page = yield* importer.inspect({ limit: 100, offset });
          expect(page.discoveryVersion).toMatch(/^[a-f0-9]{64}$/u);
          version ??= page.discoveryVersion;
          expect(page.discoveryVersion).toBe(version);
          candidates.push(...page.candidates);
          hasNextPage = page.nextOffset != null;
          if (page.nextOffset != null) {
            expect(page.nextOffset).toBeGreaterThan(offset);
            offset = page.nextOffset;
          }
        } while (hasNextPage);
        yield* report("selection-ready", candidates.length);
        expect(candidates).toHaveLength(5002);
        expect(new Set(candidates.map((item) => item.candidateId)).size).toBe(5002);
        expect(candidates.filter((item) => item.source === "claude-code")).toHaveLength(1);
        for (
          let index = 0;
          index < candidates.length;
          index += WORKJET_SESSION_IMPORT_MAX_SELECTION
        ) {
          const result = yield* importer.importSessions({
            projectId: newProjectId,
            candidateIds: candidates
              .slice(index, index + WORKJET_SESSION_IMPORT_MAX_SELECTION)
              .map((item) => item.candidateId),
          });
          expect(
            result.items.every((item) => item.status === "imported" && item.importedMessages === 2),
          ).toBe(true);
          const completed = Math.min(
            index + WORKJET_SESSION_IMPORT_MAX_SELECTION,
            candidates.length,
          );
          if (completed % 1000 === 0 || completed === candidates.length)
            yield* report("imported", completed);
        }
        const first = candidates[0]!;
        const copy = yield* importer.importSessions({
          projectId: existingProjectId,
          candidateIds: [first.candidateId],
        });
        expect(copy.items[0]?.status).toBe("imported");
        const unchanged = yield* importer.importSessions({
          projectId: newProjectId,
          candidateIds: candidates.slice(0, 20).map((item) => item.candidateId),
        });
        expect(unchanged.items.every((item) => item.status === "unchanged")).toBe(true);
        const before = yield* query.getSnapshot();
        expect(before.threads).toHaveLength(5003);
        return { before, first };
      }).pipe(Effect.provide(live), Effect.scoped);
      // Close the first SQL connection and engine before building a fresh runtime.
      yield* Effect.gen(function* () {
        const reopenedQuery = yield* ProjectionSnapshotQuery;
        const reopened = yield* reopenedQuery.getSnapshot();
        yield* report("reopened", reopened.threads.length);
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
        const reopenedImporter = yield* make.pipe(
          Effect.provideService(ServerSettingsService, settingsService),
        );
        const persistedReceipt = yield* reopenedImporter.importSessions({
          projectId: newProjectId,
          candidateIds: [first.candidateId],
        });
        expect(persistedReceipt.items[0]?.status).toBe("unchanged");
      }).pipe(Effect.provide(live), Effect.scoped);
      yield* Effect.forEach(
        Array.from({ length: 5001 }, (_, index) => index),
        (index) =>
          Effect.promise(async () =>
            expect(
              await NodeFSP.readFile(NodePath.join(sessionRoot, `${index}.jsonl`), "utf8"),
            ).toBe(codexTranscript(index)),
          ),
        { concurrency: 2, discard: true },
      );
      expect(yield* Effect.promise(() => NodeFSP.readFile(claudeFile, "utf8"))).toBe(
        claudeTranscript(5001),
      );
    }),
  300_000,
);
