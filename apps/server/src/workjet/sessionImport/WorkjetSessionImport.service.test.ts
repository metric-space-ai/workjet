// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as Sqlite from "../../persistence/NodeSqliteClient.ts";
import importMigration from "../../persistence/Migrations/056_WorkjetSessionImports.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { make } from "./WorkjetSessionImport.ts";

const sourceRace = vi.hoisted(() => ({
  path: null as string | null,
  beforeOpen: null as (() => Promise<void>) | null,
  afterArchivedMessage: null as (() => Promise<void>) | null,
  afterSourceClose: null as (() => Promise<void>) | null,
  sourceSignal: null as AbortSignal | null,
  archivePath: null as string | null,
  previewReads: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] === "r" && typeof args[0] === "string" && args[0].endsWith(".jsonl"))
        sourceRace.previewReads.push(args[0]);
      if (args[0] === sourceRace.path && sourceRace.afterSourceClose) {
        const createStream = handle.createReadStream.bind(handle);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "createReadStream").mockImplementation((options) => {
          sourceRace.sourceSignal = options?.signal ?? null;
          return createStream(options);
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          const callback = sourceRace.afterSourceClose;
          sourceRace.afterSourceClose = null;
          if (callback) await callback();
        });
      }
      if (
        args[1] === "wx" &&
        typeof args[0] === "string" &&
        args[0].endsWith("/messages.jsonl") &&
        sourceRace.afterArchivedMessage
      ) {
        sourceRace.archivePath = args[0];
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs) => {
          await write(...writeArgs);
          const change = sourceRace.afterArchivedMessage;
          sourceRace.afterArchivedMessage = null;
          if (change) await change();
        });
      }
      return handle;
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const resolved = await actual.realpath(...args);
      const swap = sourceRace.beforeOpen;
      if (args[0] === sourceRace.path && swap) {
        sourceRace.path = null;
        sourceRace.beforeOpen = null;
        await swap();
      }
      return resolved;
    },
  };
});

const NOW = "2026-10-02T12:00:00.000Z";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const transcript = (title: string, replies: string[] = [], model?: string) =>
  [
    encodeJson({
      type: "session_meta",
      payload: {
        id: "source-session",
        cwd: "/source/folder-no-longer-present",
        ...(model ? { model } : {}),
      },
      timestamp: NOW,
    }),
    encodeJson({
      type: "response_item",
      timestamp: NOW,
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: title }] },
    }),
    ...replies.map((text) =>
      encodeJson({
        type: "response_item",
        timestamp: NOW,
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      }),
    ),
  ].join("\n") + "\n";

const withFixture = <A, E>(
  run: (fixture: {
    readonly root: string;
    readonly service: Effect.Success<typeof make>;
    readonly projects: Map<string, OrchestrationProjectShell>;
    readonly threads: Map<string, OrchestrationThread>;
    readonly commands: OrchestrationCommand[];
    readonly projectLookups: string[];
    readonly setCodexHome: (homePath: string) => void;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-import-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const codex = NodePath.join(root, "codex");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(codex, "sessions"), { recursive: true }),
      );
      const projects = new Map<string, OrchestrationProjectShell>([
        [
          "project-a",
          {
            id: ProjectId.make("project-a"),
            title: "Project A",
            workspaceRoot: "/destination/a",
          } as OrchestrationProjectShell,
        ],
        [
          "project-b",
          {
            id: ProjectId.make("project-b"),
            title: "Project B",
            workspaceRoot: "/destination/b",
          } as OrchestrationProjectShell,
        ],
      ]);
      const threads = new Map<string, OrchestrationThread>();
      const commands: OrchestrationCommand[] = [];
      const projectLookups: string[] = [];
      const engine = {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            if (command.type === "thread.create")
              threads.set(command.threadId, {
                id: command.threadId,
                projectId: command.projectId,
                title: command.title,
                modelSelection: command.modelSelection,
                messages: [],
              } as unknown as OrchestrationThread);
            if (command.type === "thread.meta.update" && command.title) {
              const thread = threads.get(command.threadId)!;
              threads.set(thread.id, { ...thread, title: command.title });
            }
            if (command.type === "thread.history.import") {
              if (command.bootstrap) {
                const created = command.bootstrap.createThread;
                threads.set(command.threadId, {
                  id: command.threadId,
                  projectId: created.projectId,
                  title: created.title,
                  modelSelection: created.modelSelection,
                  messages: [],
                } as unknown as OrchestrationThread);
              }
              const thread = threads.get(command.threadId)!;
              threads.set(thread.id, {
                ...thread,
                messages: [
                  ...thread.messages,
                  ...command.messages.map(({ messageId, ...message }) => ({
                    id: messageId,
                    ...message,
                  })),
                ],
              } as OrchestrationThread);
            }
            return { sequence: commands.length };
          }),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
      } as unknown as OrchestrationEngineService["Service"];
      const query = {
        getShellSnapshot: () =>
          Effect.succeed({
            projects: [...projects.values()],
            threads: [],
            snapshotSequence: 0,
            updatedAt: NOW,
          }),
        getProjectShellById: (id: string) =>
          Effect.sync(() => {
            projectLookups.push(id);
            return Option.fromNullishOr(projects.get(id));
          }),
        getActiveProjectByWorkspaceRoot: (path: string) =>
          Effect.succeed(
            Option.fromNullishOr(
              [...projects.values()].find((project) => project.workspaceRoot === path),
            ),
          ),
        getThreadShellById: (id: string) => Effect.succeed(Option.fromNullishOr(threads.get(id))),
        getThreadDetailById: (id: string) => Effect.succeed(Option.fromNullishOr(threads.get(id))),
      } as unknown as ProjectionSnapshotQuery["Service"];
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {},
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: codex },
          claudeAgent: {
            ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
            homePath: NodePath.join(root, "claude"),
          },
        },
      };
      return yield* Effect.gen(function* () {
        yield* importMigration;
        const service = yield* make;
        return yield* run({
          root: codex,
          service,
          projects,
          threads,
          commands,
          projectLookups,
          setCodexHome: (homePath) => {
            settings.providers.codex.homePath = homePath;
          },
        });
      }).pipe(
        Effect.provideService(OrchestrationEngineService, engine),
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(ServerSettingsService, {
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(settings),
          updateSettings: () => Effect.die("fixture settings are read-only"),
          streamChanges: Stream.empty,

          subscribeChanges: Effect.succeed(Stream.empty),
        }),
        Effect.provide(Layer.merge(Sqlite.layerMemory(), NodeServices.layer)),
      );
    }),
  );
describe("session import search inventory", () => {
  it.effect(
    "answers cold and repeated searches beyond the preview limit without rescanning transcript content",
    () =>
      withFixture(({ root, service }) =>
        Effect.gen(function* () {
          const seed = NodePath.join(root, "sessions", "seed.jsonl");
          const content =
            transcript("Archive conversation") +
            encodeJson({ type: "tool_result", payload: "x".repeat(64 * 1024) }) +
            "\n";
          yield* Effect.promise(() => NodeFSP.writeFile(seed, content));
          yield* Effect.forEach(
            Array.from({ length: 600 }, (_, index) => index),
            (index) =>
              Effect.promise(() =>
                NodeFSP.link(seed, NodePath.join(root, "sessions", `copy-${index}.jsonl`)),
              ),
            { concurrency: 2, discard: true },
          );
          const invalid = NodePath.join(root, "sessions", "non-conversation.jsonl");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(invalid, encodeJson({ type: "tool_result" }) + "\n"),
          );
          const started = performance.now();
          expect((yield* service.inspect({ query: "absent title" })).candidates).toEqual([]);
          const coldMs = performance.now() - started;
          const reads = sourceRace.previewReads.filter((path) => path.startsWith(root)).length;
          expect(reads).toBe(602);
          const warmStarted = performance.now();
          expect((yield* service.inspect({ query: "another absent title" })).candidates).toEqual(
            [],
          );
          const warmMs = performance.now() - warmStarted;
          expect(sourceRace.previewReads.filter((path) => path.startsWith(root))).toHaveLength(
            reads,
          );
          console.info(
            `UX-013 602-session search: cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms`,
          );
          expect(coldMs).toBeLessThan(2_000);
          expect(warmMs).toBeLessThan(2_000);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(invalid, transcript("Newly recorded conversation")),
          );
          const updated = yield* service.inspect({ query: "newly recorded" });
          expect(updated.candidates.map(({ title }) => title)).toEqual([
            "Newly recorded conversation",
          ]);
          expect(updated.candidates[0]?.previewMessages?.[0]?.text).toBe(
            "Newly recorded conversation",
          );
          expect(sourceRace.previewReads.filter((path) => path.startsWith(root))).toHaveLength(
            reads + 1,
          );
        }),
      ),
  );

  it.effect(
    "shares preview reads between overlapping searches and preserves their independent results",
    () =>
      withFixture(({ root, service }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "sessions", "one.jsonl"),
              transcript("Shared archive"),
            ),
          );
          const before = sourceRace.previewReads.filter((path) => path.startsWith(root)).length;
          const results = yield* Effect.all(
            [service.inspect({ query: "Shared" }), service.inspect({ query: "missing" })],
            { concurrency: 2 },
          );
          expect(results[0]?.candidates.map(({ title }) => title)).toEqual(["Shared archive"]);
          expect(results[1]?.candidates).toEqual([]);
          expect(sourceRace.previewReads.filter((path) => path.startsWith(root))).toHaveLength(
            before + 1,
          );
        }),
      ),
  );
});

describe("existing imported thread names", () => {
  it.effect(
    "repairs an automatic title, respects a local rename, and leaves history receipts intact",
    () =>
      withFixture(({ root, service, threads }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "sessions", "session.jsonl"),
              transcript("Nur BEREIT antworten", [
                "BEREIT",
                "Synchronization work is now recorded",
              ]),
            ),
          );
          const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
          const copied = yield* service.importSessions({
            projectId: ProjectId.make("project-a"),
            candidateIds: [candidateId],
          });
          const id = copied.items[0]!.threadId!;
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "session_index.jsonl"),
              encodeJson({ id: "source-session", thread_name: "CTOX Crew" }) + "\n",
            ),
          );
          const thread = threads.get(id)!;
          threads.set(id, { ...thread, title: "Nur BEREIT antworten" });
          yield* service.refreshTitles;
          expect(threads.get(id)?.title).toBe("CTOX Crew");
          expect(threads.get(id)?.messages).toEqual(thread.messages);
          const again = yield* service.importSessions({
            projectId: ProjectId.make("project-a"),
            candidateIds: [candidateId],
          });
          expect(again.items[0]?.status).toBe("unchanged");
          threads.set(id, { ...threads.get(id)!, title: "My local name" });
          yield* service.refreshTitles;
          expect(threads.get(id)?.title).toBe("My local name");
          expect((yield* service.inspect()).candidates[0]?.title).toBe("CTOX Crew");
        }),
      ),
  );
});

describe("legacy provider session titles", () => {
  it.effect("uses only the recorded provider resume identity and retains a local rename", () =>
    withFixture(({ root, service, threads }) =>
      Effect.gen(function* () {
        const sourceId = "11111111-1111-1111-1111-111111111111";
        const source = transcript("hi", [
          "READY",
          "A real synchronization discussion follows",
        ]).replace('"id":"source-session"', '"id":"' + sourceId + '"');
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "sessions", sourceId + ".jsonl"), source),
        );
        const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
        const result = yield* service.importSessions({
          projectId: ProjectId.make("project-a"),
          candidateIds: [candidateId],
        });
        const id = result.items[0]!.threadId!;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM workjet_session_imports`;
        yield* sql`CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, provider_instance_id TEXT, resume_cursor_json TEXT)`;
        const cursor = encodeJson({ threadId: id, resume: sourceId });
        yield* sql`INSERT INTO provider_session_runtime VALUES (${id}, 'codex', NULL, ${cursor})`;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "session_index.jsonl"),
            encodeJson({ id: sourceId, thread_name: "CTOX Crew" }) + "\n",
          ),
        );
        const thread = threads.get(id)!;
        threads.set(id, { ...thread, title: "Hi" });
        yield* service.refreshTitles;
        expect(threads.get(id)?.title).toBe("CTOX Crew");
        expect(threads.get(id)?.messages).toEqual(thread.messages);
        threads.set(id, { ...threads.get(id)!, title: "My name" });
        yield* service.refreshTitles;
        expect(threads.get(id)?.title).toBe("My name");
      }),
    ),
  );
});

describe("project-directed static session imports", () => {
  it.effect("assigns a source cwd below an existing project without creating a project", () =>
    withFixture(({ root, service, projects, commands }) =>
      Effect.gen(function* () {
        projects.set("project-a", { ...projects.get("project-a")!, workspaceRoot: "/source" });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "sessions", "mapped.jsonl"),
            transcript("Mapped parent"),
          ),
        );
        const candidates = (yield* service.inspect()).candidates;
        expect(candidates[0]?.sourceThreadId).toBe("source-session");
        expect(
          (yield* service.importSessions({ candidateIds: [candidates[0]!.candidateId] })).items[0]
            ?.status,
        ).toBe("imported");
        expect(commands.some((command) => command.type === "project.create")).toBe(false);
        expect(
          commands.find((command) => command.type === "thread.history.import")?.bootstrap
            ?.createThread.projectId,
        ).toBe("project-a");
      }),
    ),
  );
  it.effect("leaves unmatched and ambiguous histories unassigned", () =>
    withFixture(({ root, service, projects, commands, threads }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "sessions", "unmatched.jsonl"),
            transcript("Unknown parent"),
          ),
        );
        const input = { candidateIds: [(yield* service.inspect()).candidates[0]!.candidateId] };
        expect((yield* service.importSessions(input)).items[0]?.status).toBe("failed");
        projects.set("project-a", { ...projects.get("project-a")!, workspaceRoot: "/source" });
        projects.set("project-b", { ...projects.get("project-b")!, workspaceRoot: "/source" });
        expect((yield* service.importSessions(input)).items[0]?.status).toBe("failed");
        expect(commands).toHaveLength(0);
        expect(threads.size).toBe(0);
      }),
    ),
  );

  it.effect(
    "copies more than 5000 visible messages in bounded batches and reimports unchanged",
    () =>
      withFixture(({ root, service, threads, commands }) =>
        Effect.gen(function* () {
          const file = NodePath.join(root, "sessions", "long-parent.jsonl");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              file,
              transcript(
                "Parent history",
                Array.from({ length: 5101 }, (_, index) => `Reply ${index}`),
              ),
            ),
          );
          const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
          const input = { candidateIds: [candidateId], projectId: ProjectId.make("project-a") };
          const result = yield* service.importSessions(input);
          expect(result.items[0]?.totalMessages).toBe(5102);
          expect(result.items[0]?.status).toBe("imported");
          expect([...threads.values()][0]?.messages).toHaveLength(5102);
          const imports = commands.filter((command) => command.type === "thread.history.import");
          expect(imports).toHaveLength(26);
          expect(imports.every((command) => command.messages.length <= 200)).toBe(true);
          expect((yield* service.importSessions(input)).items[0]?.status).toBe("unchanged");
          expect(
            commands.filter((command) => command.type === "thread.history.import"),
          ).toHaveLength(26);
        }),
      ),
  );
  it.effect("imports and repeats a named history with only injected user context", () =>
    withFixture(({ root, service, threads, commands }) =>
      Effect.gen(function* () {
        const file = NodePath.join(root, "sessions", "context-only.jsonl");
        const body =
          [
            encodeJson({
              type: "session_meta",
              payload: { id: "named-context", cwd: "/source", title: "SMS verification" },
            }),
            encodeJson({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "<environment_context>Fixture</environment_context>",
                  },
                ],
              },
            }),
            encodeJson({
              type: "response_item",
              timestamp: NOW,
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "SMS verification is complete." }],
              },
            }),
          ].join("\n") + "\n";
        yield* Effect.promise(() => NodeFSP.writeFile(file, body));
        const candidates = (yield* service.inspect()).candidates;
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.title).toBe("SMS verification");
        const input = {
          candidateIds: [candidates[0]!.candidateId],
          projectId: ProjectId.make("project-a"),
        };
        const copied = (yield* service.importSessions(input)).items[0]!;
        expect(copied.status).toBe("imported");
        expect(copied.totalMessages).toBe(1);
        expect(
          threads.get(copied.threadId!)?.messages.map(({ role, text }) => ({ role, text })),
        ).toEqual([{ role: "assistant", text: "SMS verification is complete." }]);
        expect((yield* service.importSessions(input)).items[0]?.status).toBe("unchanged");
        expect(commands.filter((command) => command.type === "thread.history.import")).toHaveLength(
          1,
        );
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(body);
      }),
    ),
  );

  it.effect("does not create a chat for an initialization-only exchange", () =>
    withFixture(({ root, service, threads }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "sessions", "init.jsonl"),
            transcript("Nur BEREIT antworten", ["BEREIT"]),
          ),
        );
        expect((yield* service.inspect()).candidates).toHaveLength(0);
        expect(threads.size).toBe(0);
      }),
    ),
  );

  it.effect("discovers a conversation whose first visible message contains a large image", () =>
    withFixture(({ root, service, threads }) =>
      Effect.gen(function* () {
        const file = NodePath.join(root, "sessions", "image-first.jsonl");
        const body =
          transcript("# AGENTS.md instructions\n<INSTRUCTIONS>Fixture context</INSTRUCTIONS>") +
          encodeJson({
            type: "response_item",
            timestamp: NOW,
            payload: {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "Investigate the attached project diagram" },
                {
                  type: "input_image",
                  image_url: "data:image/png;base64," + "A".repeat(2 * 1024 * 1024),
                },
              ],
            },
          }) +
          "\n";
        yield* Effect.promise(() => NodeFSP.writeFile(file, body));
        const found = yield* service.inspect();
        expect(found.candidates).toHaveLength(1);
        expect(found.candidates[0]?.title).toBe("Investigate the attached project diagram");
        const result = yield* service.importSessions({
          candidateIds: [found.candidates[0]!.candidateId],
          projectId: ProjectId.make("project-a"),
        });
        expect(result.items[0]?.status).toBe("imported");
        expect(result.items[0]?.totalMessages).toBe(1);
        expect([...threads.values()][0]?.messages.map((message) => message.text)).toEqual([
          "Investigate the attached project diagram",
        ]);
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(body);
      }),
    ),
  );

  it.effect("extended previews still reject initialization-only and child sessions", () =>
    withFixture(({ root, service, threads }) =>
      Effect.gen(function* () {
        for (const child of [false, true]) {
          const body =
            [
              encodeJson({
                type: "session_meta",
                payload: {
                  id: "excluded-source",
                  ...(child ? { parent_thread_id: "parent" } : {}),
                },
                timestamp: NOW,
              }),
              encodeJson({
                type: "response_item",
                timestamp: NOW,
                payload: {
                  type: "message",
                  role: "user",
                  content: [
                    { type: "input_text", text: child ? "A real child task" : "hi" },
                    {
                      type: "input_image",
                      image_url: "data:image/png;base64," + "A".repeat(2 * 1024 * 1024),
                    },
                  ],
                },
              }),
            ].join("\n") + "\n";
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "sessions", child ? "child.jsonl" : "init-image.jsonl"),
              body,
            ),
          );
        }
        expect((yield* service.inspect()).candidates).toHaveLength(0);
        expect(threads.size).toBe(0);
      }),
    ),
  );

  it.effect("imports visible messages across a tool result larger than the former file limit", () =>
    withFixture(({ root, service, threads, commands }) =>
      Effect.gen(function* () {
        const file = NodePath.join(root, "sessions", "grown.jsonl");
        yield* Effect.promise(() => NodeFSP.writeFile(file, transcript("Small preview")));
        const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
        yield* Effect.promise(() =>
          NodeFSP.appendFile(
            file,
            encodeJson({
              type: "response_item",
              payload: { type: "function_call_output", output: "x".repeat(21 * 1024 * 1024) },
            }) +
              "\n" +
              encodeJson({
                type: "response_item",
                timestamp: NOW,
                payload: {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Visible answer after a large tool" }],
                },
              }) +
              "\n",
          ),
        );
        const result = yield* service.importSessions({
          candidateIds: [candidateId],
          projectId: ProjectId.make("project-a"),
        });
        expect(result.items[0]?.status).toBe("imported");
        expect(result.items[0]?.totalMessages).toBe(2);
        expect(commands.filter((command) => command.type === "thread.history.import")).toHaveLength(
          1,
        );
        expect([...threads.values()][0]?.messages.map((message) => message.text)).toEqual([
          "Small preview",
          "Visible answer after a large tool",
        ]);
      }),
    ),
  );

  it.effect(
    "copies a fixed live prefix and imports the newly completed record on the next run",
    () =>
      withFixture(({ root, service, threads }) =>
        Effect.gen(function* () {
          const file = NodePath.join(root, "sessions", "live.jsonl");
          const late = Buffer.from(
            encodeJson({
              type: "response_item",
              timestamp: NOW,
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Completed after snapshot ä 👾" }],
              },
            }) + "\n",
          );
          const split = late.length - 7;
          const original = Buffer.concat([
            Buffer.from(transcript("Snapshot original", ["Already complete ä 👾"])),
            late.subarray(0, split),
          ]);
          yield* Effect.promise(() => NodeFSP.writeFile(file, original));
          const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
          yield* Effect.sync(() => {
            sourceRace.afterArchivedMessage = () => NodeFSP.appendFile(file, late.subarray(split));
          });
          const input = { candidateIds: [candidateId], projectId: ProjectId.make("project-a") };
          const first = yield* service.importSessions(input).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                sourceRace.afterArchivedMessage = null;
              }),
            ),
          );
          expect(first.items[0]?.status).toBe("imported");
          expect(first.items[0]?.totalMessages).toBe(2);
          expect(threads.get(first.items[0]!.threadId!)?.messages.map(({ text }) => text)).toEqual([
            "Snapshot original",
            "Already complete ä 👾",
          ]);
          const second = yield* service.importSessions(input);
          expect(second.items[0]?.threadId).toBe(first.items[0]?.threadId);
          expect(second.items[0]?.importedMessages).toBe(1);
          expect(second.items[0]?.totalMessages).toBe(3);
          expect(threads.get(second.items[0]!.threadId!)?.messages.at(-1)?.text).toBe(
            "Completed after snapshot ä 👾",
          );
          expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(
            Buffer.concat([original, late.subarray(split)]).toString("utf8"),
          );
        }),
      ),
  );

  it.effect("rejects a rewritten prefix even when the source also grows", () =>
    withFixture(({ root, service, threads, commands }) =>
      Effect.gen(function* () {
        const file = NodePath.join(root, "sessions", "rewrite-live.jsonl");
        const original = transcript("Snapshot original", ["Already complete"]);
        const changed =
          original.replace("Snapshot original", "Snapshot tampered") +
          transcript("Appended content");
        yield* Effect.promise(() => NodeFSP.writeFile(file, original));
        const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
        yield* Effect.sync(() => {
          sourceRace.afterArchivedMessage = () => NodeFSP.writeFile(file, changed);
        });
        const result = yield* service
          .importSessions({ candidateIds: [candidateId], projectId: ProjectId.make("project-a") })
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                sourceRace.afterArchivedMessage = null;
              }),
            ),
          );
        expect(result.items[0]?.status).toBe("failed");
        expect(commands).toHaveLength(0);
        expect(threads.size).toBe(0);
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(changed);
      }),
    ),
  );

  it.effect("rejects a source truncated while its snapshot is read", () =>
    withFixture(({ root, service, threads, commands }) =>
      Effect.gen(function* () {
        const file = NodePath.join(root, "sessions", "truncate-live.jsonl");
        const original = transcript("Snapshot original", ["Already complete"]);
        yield* Effect.promise(() => NodeFSP.writeFile(file, original));
        const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
        yield* Effect.sync(() => {
          sourceRace.afterArchivedMessage = () => NodeFSP.truncate(file, 10);
        });
        const result = yield* service
          .importSessions({ candidateIds: [candidateId], projectId: ProjectId.make("project-a") })
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                sourceRace.afterArchivedMessage = null;
              }),
            ),
          );
        expect(result.items[0]?.status).toBe("failed");
        expect(commands).toHaveLength(0);
        expect(threads.size).toBe(0);
        expect((yield* Effect.promise(() => NodeFSP.stat(file))).size).toBe(10);
      }),
    ),
  );

  it.effect(
    "cancels a snapshot read and removes its private archive before any history is imported",
    () =>
      withFixture(({ root, service, threads, commands }) =>
        Effect.gen(function* () {
          const file = NodePath.join(root, "sessions", "cancel-live.jsonl");
          const original = transcript("Snapshot original", ["Already complete"]);
          yield* Effect.promise(() => NodeFSP.writeFile(file, original));
          const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
          const reading = Promise.withResolvers<void>();
          const continueReading = Promise.withResolvers<void>();
          const cleaned = Promise.withResolvers<void>();
          yield* Effect.sync(() => {
            sourceRace.path = file;
            sourceRace.afterSourceClose = async () => {
              cleaned.resolve();
            };
            sourceRace.afterArchivedMessage = async () => {
              reading.resolve();
              await continueReading.promise;
            };
          });
          yield* Effect.gen(function* () {
            const importing = yield* service
              .importSessions({
                candidateIds: [candidateId],
                projectId: ProjectId.make("project-a"),
              })
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => reading.promise);
            expect(sourceRace.sourceSignal?.aborted).toBe(false);
            yield* Fiber.interrupt(importing);
            expect(sourceRace.sourceSignal?.aborted).toBe(true);
            continueReading.resolve();
            yield* Effect.promise(() => cleaned.promise);
            expect(commands).toHaveLength(0);
            expect(threads.size).toBe(0);
            expect(
              yield* Effect.promise(() =>
                NodeFSP.access(sourceRace.archivePath!).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false);
            expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(original);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                continueReading.resolve();
                sourceRace.path = null;
                sourceRace.afterArchivedMessage = null;
                sourceRace.afterSourceClose = null;
                sourceRace.sourceSignal = null;
                sourceRace.archivePath = null;
              }),
            ),
          );
        }),
      ),
  );

  it.effect(
    "rejects a symlink swap between path validation and opening the selected transcript",
    () =>
      withFixture(({ root, service, threads, commands }) =>
        Effect.gen(function* () {
          const file = NodePath.join(root, "sessions", "race.jsonl");
          const outside = NodePath.join(root, "outside-race.jsonl");
          const outsideContent = transcript("Unselected target", ["Must not be copied"]);
          yield* Effect.promise(() => NodeFSP.writeFile(file, transcript("Selected source")));
          yield* Effect.promise(() => NodeFSP.writeFile(outside, outsideContent));
          const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
          let swapped = false;
          yield* Effect.sync(() => {
            sourceRace.path = file;
            sourceRace.beforeOpen = async () => {
              await NodeFSP.unlink(file);
              await NodeFSP.symlink(outside, file);
              swapped = true;
            };
          });
          const result = yield* service
            .importSessions({ candidateIds: [candidateId], projectId: ProjectId.make("project-a") })
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  sourceRace.path = null;
                  sourceRace.beforeOpen = null;
                }),
              ),
            );
          expect(swapped).toBe(true);
          expect(result.items[0]?.status).toBe("failed");
          expect(commands).toHaveLength(0);
          expect(threads.size).toBe(0);
          expect(yield* Effect.promise(() => NodeFSP.readFile(outside, "utf8"))).toBe(
            outsideContent,
          );
        }),
      ),
  );

  it.effect(
    "revalidates cached files after deletion and reads their current content after restoration",
    () =>
      withFixture(({ root, service, threads, commands }) =>
        Effect.gen(function* () {
          const file = NodePath.join(root, "sessions", "cached.jsonl");
          yield* Effect.promise(() => NodeFSP.writeFile(file, transcript("Before rotation")));
          const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
          const input = { candidateIds: [candidateId], projectId: ProjectId.make("project-a") };
          yield* Effect.promise(() => NodeFSP.unlink(file));
          expect((yield* service.importSessions(input)).items[0]?.status).toBe("failed");
          expect(commands).toHaveLength(0);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(file, transcript("After rotation", ["Current reply"])),
          );
          const imported = yield* service.importSessions(input);
          expect(imported.items[0]?.status).toBe("imported");
          expect(
            threads.get(imported.items[0]!.threadId!)?.messages.map(({ text }) => text),
          ).toEqual(["After rotation", "Current reply"]);
        }),
      ),
  );

  it.effect(
    "refuses a cached path replaced with a symlink without reading or importing its target",
    () =>
      withFixture(({ root, service, threads, commands }) =>
        Effect.gen(function* () {
          const file = NodePath.join(root, "sessions", "cached.jsonl");
          const privateFile = NodePath.join(root, "outside.jsonl");
          const privateContent = transcript("Outside the selected source", ["Private fixture"]);
          yield* Effect.promise(() => NodeFSP.writeFile(file, transcript("Original source")));
          const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
          yield* Effect.promise(() => NodeFSP.writeFile(privateFile, privateContent));
          yield* Effect.promise(() => NodeFSP.unlink(file));
          yield* Effect.promise(() => NodeFSP.symlink(privateFile, file));
          const result = yield* service.importSessions({
            candidateIds: [candidateId],
            projectId: ProjectId.make("project-a"),
          });
          expect(result.items[0]?.status).toBe("failed");
          expect(commands).toHaveLength(0);
          expect(threads.size).toBe(0);
          expect(yield* Effect.promise(() => NodeFSP.readFile(privateFile, "utf8"))).toBe(
            privateContent,
          );
        }),
      ),
  );

  it.effect("invalidates the cached source inventory when the configured home changes", () =>
    withFixture(({ root, service, threads, commands, setCodexHome }) =>
      Effect.gen(function* () {
        const firstFile = NodePath.join(root, "sessions", "first.jsonl");
        yield* Effect.promise(() => NodeFSP.writeFile(firstFile, transcript("Old home")));
        const firstId = (yield* service.inspect()).candidates[0]!.candidateId;
        const nextHome = NodePath.join(root, "next-home");
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.join(nextHome, "sessions"), { recursive: true }),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(nextHome, "sessions", "next.jsonl"),
            transcript("New home"),
          ),
        );
        setCodexHome(nextHome);
        const refused = yield* service.importSessions({
          candidateIds: [firstId],
          projectId: ProjectId.make("project-a"),
        });
        expect(refused.items[0]?.status).toBe("failed");
        expect(commands).toHaveLength(0);
        const next = (yield* service.inspect()).candidates;
        expect(next.map(({ title }) => title)).toEqual(["New home"]);
        const imported = yield* service.importSessions({
          candidateIds: [next[0]!.candidateId],
          projectId: ProjectId.make("project-a"),
        });
        expect(imported.items[0]?.status).toBe("imported");
        expect([...threads.values()].map(({ title }) => title)).toEqual(["New home"]);
      }),
    ),
  );

  it.effect("imports missing-folder history only into an explicit destination", () =>
    withFixture(({ root, service, threads, commands }) =>
      Effect.gen(function* () {
        const file = NodePath.join(root, "sessions", "without-folder.jsonl");
        const original = transcript("History without folder", ["Still readable"])
          .split("\n")
          .slice(1)
          .join("\n");
        yield* Effect.promise(() => NodeFSP.writeFile(file, original));
        const inspection = yield* service.inspect();
        expect(inspection.candidates).toHaveLength(1);
        const candidate = inspection.candidates[0]!;
        expect(candidate.workspaceRoot).toBeNull();
        expect(candidate.workspaceAvailable).toBe(false);
        const blocked = yield* service.importSessions({ candidateIds: [candidate.candidateId] });
        expect(blocked.items[0]?.status).toBe("failed");
        expect(commands).toHaveLength(0);
        expect(threads.size).toBe(0);
        const input = {
          candidateIds: [candidate.candidateId],
          projectId: ProjectId.make("project-a"),
        };
        const imported = yield* service.importSessions(input);
        expect(imported.items[0]?.status).toBe("imported");
        expect(threads.get(imported.items[0]!.threadId!)?.projectId).toBe("project-a");
        expect(threads.get(imported.items[0]!.threadId!)?.messages).toHaveLength(2);
        expect((yield* service.importSessions(input)).items[0]?.status).toBe("unchanged");
        expect(commands.some((command) => command.type === "project.create")).toBe(false);
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(original);
      }),
    ),
  );

  it.effect(
    "imports into the selected project, updates idempotently, and permits an independent copy in another project",
    () =>
      withFixture(({ root, service, threads, commands }) =>
        Effect.gen(function* () {
          const file = NodePath.join(root, "sessions", "conversation.jsonl");
          const original = transcript("Review importer", ["Reviewed"]);
          yield* Effect.promise(() => NodeFSP.writeFile(file, original));
          const inspection = yield* service.inspect();
          const candidateId = inspection.candidates[0]!.candidateId;
          expect(inspection.candidates[0]?.workspaceAvailable).toBe(false);
          const input = { candidateIds: [candidateId], projectId: ProjectId.make("project-a") };
          const first = yield* service.importSessions(input);
          expect(first.items[0]?.status).toBe("imported");
          expect(threads.get(first.items[0]!.threadId!)?.projectId).toBe("project-a");
          expect(commands.some((command) => command.type === "project.create")).toBe(false);
          expect((yield* service.importSessions(input)).items[0]?.status).toBe("unchanged");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(file, transcript("Review importer", ["Reviewed", "More detail"])),
          );
          const updated = yield* service.importSessions(input);
          expect(updated.items[0]?.status).toBe("updated");
          expect(updated.items[0]?.importedMessages).toBe(1);
          const second = yield* service.importSessions({
            ...input,
            projectId: ProjectId.make("project-b"),
          });
          expect(second.items[0]?.status).toBe("imported");
          expect(second.items[0]?.threadId).not.toBe(first.items[0]?.threadId);
          expect(threads.get(second.items[0]!.threadId!)?.messages).toHaveLength(3);
          expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(
            transcript("Review importer", ["Reviewed", "More detail"]),
          );
          const copies = (yield* service.inspect()).candidates[0]?.importedCopies;
          expect(copies?.map(({ projectId }) => projectId).sort()).toEqual([
            "project-a",
            "project-b",
          ]);
          expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(0);
          expect(
            commands.filter(
              (command) => command.type === "thread.history.import" && command.bootstrap,
            ),
          ).toHaveLength(2);
        }),
      ),
  );

  it.effect("appends archive messages after local continuation and rejects changed history", () =>
    withFixture(({ root, service, threads, commands }) =>
      Effect.gen(function* () {
        const file = NodePath.join(root, "sessions", "continued.jsonl");
        const original = transcript("Imported question", ["Imported answer"]);
        yield* Effect.promise(() => NodeFSP.writeFile(file, original));
        const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
        const input = { candidateIds: [candidateId], projectId: ProjectId.make("project-a") };
        const first = yield* service.importSessions(input);
        const threadId = first.items[0]!.threadId!;
        const imported = threads.get(threadId)!;
        const localMessages = [
          {
            ...imported.messages[0]!,
            id: MessageId.make("local-user"),
            role: "user" as const,
            text: "Continue in Workjet",
          },
          {
            ...imported.messages[1]!,
            id: MessageId.make("local-assistant"),
            role: "assistant" as const,
            text: "Workjet continuation answer",
          },
        ];
        threads.set(threadId, { ...imported, messages: [...imported.messages, ...localMessages] });
        const commandsBeforeRepeat = commands.length;
        expect((yield* service.importSessions(input)).items[0]?.status).toBe("unchanged");
        expect(commands).toHaveLength(commandsBeforeRepeat);
        const appended =
          original +
          [
            encodeJson({
              type: "response_item",
              timestamp: NOW,
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Later archive question" }],
              },
            }),
            encodeJson({
              type: "response_item",
              timestamp: NOW,
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Later archive answer" }],
              },
            }),
          ].join("\n") +
          "\n";
        yield* Effect.promise(() => NodeFSP.writeFile(file, appended));
        const updated = yield* service.importSessions(input);
        expect(updated.items[0]?.status).toBe("updated");
        expect(updated.items[0]?.importedMessages).toBe(2);
        const continued = threads.get(threadId)!;
        expect(continued.messages.map(({ role, text }) => ({ role, text }))).toEqual([
          { role: "user", text: "Imported question" },
          { role: "assistant", text: "Imported answer" },
          { role: "user", text: "Continue in Workjet" },
          { role: "assistant", text: "Workjet continuation answer" },
          { role: "user", text: "Later archive question" },
          { role: "assistant", text: "Later archive answer" },
        ]);
        expect(continued.messages.slice(2, 4)).toEqual(localMessages);
        expect((yield* service.importSessions(input)).items[0]?.status).toBe("unchanged");
        const commandsBeforeFailure = commands.length;
        threads.set(threadId, {
          ...continued,
          messages: continued.messages.filter(({ id }) => id !== imported.messages[0]!.id),
        });
        expect((yield* service.importSessions(input)).items[0]?.status).toBe("failed");
        threads.set(threadId, {
          ...continued,
          messages: continued.messages.map((message, index) =>
            index === 0 ? { ...message, text: "Changed imported question" } : message,
          ),
        });
        expect((yield* service.importSessions(input)).items[0]?.status).toBe("failed");
        threads.set(threadId, continued);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(file, appended.replace("Imported question", "Changed source question")),
        );
        expect((yield* service.importSessions(input)).items[0]?.status).toBe("failed");
        expect(commands).toHaveLength(commandsBeforeFailure);
      }),
    ),
  );

  it.effect(
    "resolves a selected destination once per bounded request and refreshes it for the next request",

    () =>
      withFixture(({ root, service, projects, projectLookups }) =>
        Effect.gen(function* () {
          for (let index = 0; index < 3; index += 1) {
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(root, "sessions", `batch-${index}.jsonl`),
                transcript(`Batch ${index}`),
              ),
            );
          }
          const candidateIds = (yield* service.inspect()).candidates.map(
            ({ candidateId }) => candidateId,
          );
          const result = yield* service.importSessions({
            projectId: ProjectId.make("project-a"),
            candidateIds,
          });
          expect(result.items).toHaveLength(3);
          expect(result.items.every(({ status }) => status === "imported")).toBe(true);
          expect(projectLookups).toEqual(["project-a"]);
          projects.delete("project-a");
          const next = yield* service.importSessions({
            projectId: ProjectId.make("project-a"),
            candidateIds,
          });
          expect(next.items.every(({ status }) => status === "failed")).toBe(true);
          expect(projectLookups).toEqual(["project-a", "project-a"]);
        }),
      ),
  );
  it.effect("discovers and imports another harness beyond a large first-source archive", () =>
    withFixture(({ root, service, threads }) =>
      Effect.gen(function* () {
        const seed = NodePath.join(root, "sessions", "seed.jsonl");
        yield* Effect.promise(() => NodeFSP.writeFile(seed, transcript("Large Codex archive")));
        yield* Effect.forEach(
          Array.from({ length: 5_001 }, (_, index) => index),
          (index) =>
            Effect.promise(() =>
              NodeFSP.link(seed, NodePath.join(root, "sessions", `copy-${index}.jsonl`)),
            ),
          { concurrency: 2, discard: true },
        );
        const claudeRoot = NodePath.join(NodePath.dirname(root), "claude", "projects", "fixture");
        yield* Effect.promise(() => NodeFSP.mkdir(claudeRoot, { recursive: true }));
        const file = NodePath.join(claudeRoot, "later-source.jsonl");
        const original =
          encodeJson({
            type: "user",
            message: { role: "user", content: "Work beyond the first 5,000 files" },
            timestamp: NOW,
          }) + "\n";
        yield* Effect.promise(() => NodeFSP.writeFile(file, original));
        const found = yield* service.inspect({ source: "claude-code", query: "beyond the first" });
        expect(found.candidates.map(({ title }) => title)).toEqual([
          "Work beyond the first 5,000 files",
        ]);
        expect(found.sources.find(({ source }) => source === "codex")?.discoveredCount).toBe(5_002);
        expect(found.discoveryLimitReached).toBe(false);
        expect(found.truncated).toBe(false);
        const result = yield* service.importSessions({
          candidateIds: [found.candidates[0]!.candidateId],
          projectId: ProjectId.make("project-a"),
        });
        expect(result.items[0]?.status).toBe("imported");
        expect(threads.get(result.items[0]!.threadId!)?.projectId).toBe("project-a");
        expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(original);
      }),
    ),
  );

  it.effect("finds older matches beyond the first page and keeps page boundaries stable", () =>
    withFixture(({ root, service }) =>
      Effect.gen(function* () {
        for (let index = 0; index < 5; index++) {
          const file = NodePath.join(root, "sessions", `${index}.jsonl`);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              file,
              transcript(index === 0 ? "Older selected work" : `Conversation ${index}`),
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.utimes(file, 1_700_000_000 + index, 1_700_000_000 + index),
          );
        }
        const first = yield* service.inspect({ limit: 2 });
        const second = yield* service.inspect({ limit: 2, offset: first.nextOffset! });
        const last = yield* service.inspect({ limit: 2, offset: second.nextOffset! });
        expect(first.nextOffset).toBe(2);
        expect(second.nextOffset).toBe(4);
        expect(last.nextOffset).toBeNull();
        expect(first.discoveryVersion).toMatch(/^[a-f0-9]{64}$/u);
        expect(second.discoveryVersion).toBe(first.discoveryVersion);
        expect(last.discoveryVersion).toBe(first.discoveryVersion);
        expect(
          new Set(
            [...first.candidates, ...second.candidates, ...last.candidates].map(
              ({ candidateId }) => candidateId,
            ),
          ).size,
        ).toBe(5);
        const found = yield* service.inspect({ query: "older selected", source: "codex" });
        expect(found.candidates.map(({ title }) => title)).toEqual(["Older selected work"]);
        yield* Effect.promise(() =>
          NodeFSP.utimes(NodePath.join(root, "sessions", "0.jsonl"), 1_800_000_000, 1_800_000_000),
        );
        const reordered = yield* service.inspect({ limit: 2, offset: first.nextOffset! });
        expect(reordered.discoveryVersion).not.toBe(first.discoveryVersion);
        expect(found.candidates[0]?.previewMessages?.[0]?.text).toBe("Older selected work");
        expect((yield* service.inspect({ source: "claude-code" })).candidates).toEqual([]);
      }),
    ),
  );

  it.effect(
    "refuses missing destinations and changed history, while retaining successful items",
    () =>
      withFixture(({ root, service, threads }) =>
        Effect.gen(function* () {
          const file = NodePath.join(root, "sessions", "conversation.jsonl");
          yield* Effect.promise(() => NodeFSP.writeFile(file, transcript("Original")));
          const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
          const invalid = yield* service.importSessions({
            candidateIds: [candidateId],
            projectId: ProjectId.make("deleted"),
          });
          expect(invalid.items[0]?.status).toBe("failed");
          expect(threads.size).toBe(0);
          const input = { candidateIds: [candidateId], projectId: ProjectId.make("project-a") };
          yield* service.importSessions(input);
          yield* Effect.promise(() => NodeFSP.writeFile(file, transcript("Changed prefix")));
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "sessions", "second.jsonl"),
              transcript("Another conversation"),
            ),
          );
          const secondId = (yield* service.inspect()).candidates.find(
            ({ title }) => title === "Another conversation",
          )!.candidateId;
          const refused = yield* service.importSessions({
            ...input,
            candidateIds: [candidateId, secondId],
          });
          expect(refused.items[0]?.status).toBe("failed");
          expect(refused.items[1]?.status).toBe("imported");
          expect([...threads.values()][0]?.messages[0]?.text).toBe("Original");
        }),
      ),
  );
  it.effect("keeps recorded Codex and Claude models and marks missing metadata as unknown", () =>
    withFixture(({ root, service, commands }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "sessions", "known.jsonl"),
            transcript("Recorded Codex", ["Historical reply"], "gpt-5.4"),
          ),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "sessions", "unknown.jsonl"),
            transcript("Unrecorded model"),
          ),
        );
        const claude = NodePath.join(root, "..", "claude", "projects", "fixture");
        yield* Effect.promise(() => NodeFSP.mkdir(claude, { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(claude, "known.jsonl"),
            [
              encodeJson({
                type: "user",
                cwd: "/claude/source",
                timestamp: NOW,
                message: { role: "user", content: "Recorded Claude" },
              }),
              encodeJson({
                type: "assistant",
                timestamp: NOW,
                message: {
                  role: "assistant",
                  model: "claude-sonnet-4-20250514",
                  content: [{ type: "text", text: "Historical reply" }],
                },
              }),
            ].join("\n") + "\n",
          ),
        );
        const candidates = (yield* service.inspect()).candidates;
        const result = yield* service.importSessions({
          candidateIds: candidates.map(({ candidateId }) => candidateId),
          projectId: ProjectId.make("project-a"),
        });
        expect(result.items.map(({ status }) => status)).toEqual([
          "imported",
          "imported",
          "imported",
        ]);
        const models = Object.fromEntries(
          commands.flatMap((command) =>
            command.type === "thread.history.import" && command.bootstrap
              ? [
                  [
                    command.bootstrap.createThread.title,
                    command.bootstrap.createThread.modelSelection.model,
                  ],
                ]
              : [],
          ),
        );
        expect(models).toEqual({
          "Recorded Codex": "gpt-5.4",
          "Recorded Claude": "claude-sonnet-4-20250514",
          "Unrecorded model": "unknown",
        });
      }),
    ),
  );
  it.effect(
    "discovers and imports an archived Codex conversation without changing its source",
    () =>
      withFixture(({ root, service, threads }) =>
        Effect.gen(function* () {
          const archive = NodePath.join(root, "archived_sessions");
          const file = NodePath.join(archive, "conversation.jsonl");
          const original = transcript("Archived planning", ["Saved reply"]);
          yield* Effect.promise(() => NodeFSP.mkdir(archive, { recursive: true }));
          yield* Effect.promise(() => NodeFSP.writeFile(file, original));
          const inspected = yield* service.inspect({ query: "Archived planning" });
          expect(inspected.candidates).toHaveLength(1);
          const imported = yield* service.importSessions({
            candidateIds: [inspected.candidates[0]!.candidateId],
            projectId: ProjectId.make("project-b"),
          });
          expect(imported.items[0]?.status).toBe("imported");
          expect(threads.get(imported.items[0]!.threadId!)?.projectId).toBe("project-b");
          expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe(original);
        }),
      ),
  );
  it.effect("creates a fresh copy when an imported thread was deleted", () =>
    withFixture(({ root, service, threads }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "sessions", "conversation.jsonl"),
            transcript("Copy me", ["Reply"]),
          ),
        );
        const candidateId = (yield* service.inspect()).candidates[0]!.candidateId;
        const input = { candidateIds: [candidateId], projectId: ProjectId.make("project-a") };
        const first = yield* service.importSessions(input);
        threads.delete(first.items[0]!.threadId!);
        expect((yield* service.inspect()).candidates[0]?.importedCopies).toEqual([]);
        const restored = yield* service.importSessions(input);
        expect(restored.items[0]?.status).toBe("imported");
        expect(restored.items[0]?.threadId).not.toBe(first.items[0]?.threadId);
        expect(threads.get(restored.items[0]!.threadId!)?.messages).toHaveLength(2);
        expect((yield* service.importSessions(input)).items[0]?.status).toBe("unchanged");
      }),
    ),
  );
});
