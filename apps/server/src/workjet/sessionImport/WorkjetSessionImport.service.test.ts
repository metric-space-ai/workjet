// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as Sqlite from "../../persistence/NodeSqliteClient.ts";
import importMigration from "../../persistence/Migrations/056_WorkjetSessionImports.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { make } from "./WorkjetSessionImport.ts";

const NOW = "2026-10-02T12:00:00.000Z";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const transcript = (title: string, replies: string[] = [], model?: string) =>
  [
    encodeJson({
      type: "session_meta",
      payload: { cwd: "/source/folder-no-longer-present", ...(model ? { model } : {}) },
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
  }) => Effect.Effect<A, E>,
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
            if (command.type === "thread.history.import") {
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
        getProjectShellById: (id: string) => Effect.succeed(Option.fromNullishOr(projects.get(id))),
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
        return yield* run({ root: codex, service, projects, threads, commands });
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

describe("project-directed static session imports", () => {
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
          expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(2);
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
            command.type === "thread.create" ? [[command.title, command.modelSelection.model]] : [],
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
