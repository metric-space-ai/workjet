// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_WORKJET_THREAD_CONFIG,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WORKJET_SESSION_IMPORT_MAX_CANDIDATES,
  WorkjetSessionImportError,
  type OrchestrationCommand,
  type ServerSettings,
  type WorkjetSessionImportCandidate,
  type WorkjetSessionImportInput,
  type WorkjetSessionImportInspection,
  type WorkjetSessionImportResult,
  type WorkjetSessionImportSource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const MAX_DISCOVERED_FILES = 5_000;
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_MESSAGE_COUNT = 5_000;
const MAX_MESSAGE_CHARS = 200_000;
const IMPORT_CHUNK_SIZE = 200;

interface SourceLocation {
  readonly source: WorkjetSessionImportSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly root: string;
}

interface SourceFile {
  readonly sourceKey: string;
  readonly source: WorkjetSessionImportSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface ImportedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

interface ParsedSession {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<ImportedMessage>;
}

interface ImportRow {
  readonly source_key: string;
  readonly thread_id: string;
  readonly imported_message_count: number;
  readonly prefix_hash: string;
}

const sha256 = (value: string | Buffer): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const stableUuid = (seed: string): string => {
  const hex = sha256(seed).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
};

const sourceKeyFor = (
  source: WorkjetSessionImportSource,
  instanceId: string,
  path: string,
): string => `wjsi_${sha256(`${source}\0${instanceId}\0${path}`).slice(0, 32)}`;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const isWorkjetSessionImportError = Schema.is(WorkjetSessionImportError);

const isoOr = (value: unknown, fallback: string): string => {
  const text = asString(value);
  if (!text) return fallback;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
};

const visibleText = (
  content: unknown,
  allowedType: "input_text" | "output_text" | "text",
): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((entry) => {
      const block = asRecord(entry);
      if (!block || block.type !== allowedType) return [];
      const text = asString(block.text);
      return text ? [text] : [];
    })
    .join("\n");
};

const isInjectedCodexContext = (text: string): boolean =>
  text.includes("<recommended_plugins>") ||
  text.includes("# AGENTS.md instructions") ||
  text.includes("<permissions instructions>") ||
  text.includes("<environment_context>");

const isInternalHealthProbe = (text: string): boolean =>
  text.trimStart().startsWith("WORKJET HEALTH PROBE V1.");

export const parseCodexSessionTranscript = (
  lines: ReadonlyArray<string>,
  fallbackIso: string,
): ParsedSession | null => {
  let workspaceRoot = "";
  let createdAt = fallbackIso;
  const messages: ImportedMessage[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(value);
    const payload = asRecord(record?.payload);
    if (record?.type === "session_meta" && payload) {
      if (payload.parent_thread_id || payload.agent_path) return null;
      workspaceRoot = asString(payload.cwd) ?? workspaceRoot;
      createdAt = isoOr(payload.timestamp ?? record.timestamp, createdAt);
      continue;
    }
    if (record?.type !== "response_item" || payload?.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = visibleText(
      payload.content,
      role === "user" ? "input_text" : "output_text",
    ).trim();
    if (!text || (role === "user" && isInjectedCodexContext(text))) continue;
    messages.push({ role, text, createdAt: isoOr(record.timestamp, fallbackIso) });
  }
  if (!workspaceRoot || !messages.some((message) => message.role === "user")) return null;
  if (messages.some((message) => message.role === "user" && isInternalHealthProbe(message.text))) {
    return null;
  }
  const title = messages.find((message) => message.role === "user")?.text ?? "Codex session";
  return {
    title: title.replace(/\s+/gu, " ").slice(0, 120).trim() || "Codex session",
    workspaceRoot,
    createdAt,
    updatedAt: messages.at(-1)?.createdAt ?? fallbackIso,
    messages,
  };
};

export const parseClaudeSessionTranscript = (
  lines: ReadonlyArray<string>,
  fallbackIso: string,
): ParsedSession | null => {
  let workspaceRoot = "";
  let title = "";
  const messages: ImportedMessage[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(value);
    if (!record || record.isSidechain === true) return null;
    workspaceRoot = asString(record.cwd) ?? workspaceRoot;
    if (record.type === "ai-title") title = asString(record.title) ?? title;
    if (record.type !== "user" && record.type !== "assistant") continue;
    const message = asRecord(record.message);
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = visibleText(message?.content, "text").trim();
    if (!text) continue;
    messages.push({ role, text, createdAt: isoOr(record.timestamp, fallbackIso) });
  }
  if (!workspaceRoot || !messages.some((message) => message.role === "user")) return null;
  if (messages.some((message) => message.role === "user" && isInternalHealthProbe(message.text))) {
    return null;
  }
  title ||= messages.find((message) => message.role === "user")?.text ?? "Claude Code session";
  return {
    title: title.replace(/\s+/gu, " ").slice(0, 120).trim() || "Claude Code session",
    workspaceRoot,
    createdAt: messages[0]?.createdAt ?? fallbackIso,
    updatedAt: messages.at(-1)?.createdAt ?? fallbackIso,
    messages,
  };
};

const parseSession = (file: SourceFile, text: string): ParsedSession | null => {
  const fallbackIso = new Date(file.mtimeMs).toISOString();
  const lines = text.split(/\r?\n/u).filter(Boolean);
  const parsed =
    file.source === "codex"
      ? parseCodexSessionTranscript(lines, fallbackIso)
      : parseClaudeSessionTranscript(lines, fallbackIso);
  if (!parsed) return null;
  if (
    parsed.messages.length > MAX_MESSAGE_COUNT ||
    parsed.messages.some((message) => message.text.length > MAX_MESSAGE_CHARS)
  ) {
    throw new WorkjetSessionImportError({ reason: "session_too_large", subject: null });
  }
  return parsed;
};

const readConfigHomePath = (config: unknown): string | undefined => {
  const value = asString(asRecord(config)?.homePath)?.trim();
  return value ? value : undefined;
};

const resolveLocations = (settings: ServerSettings, path: Path.Path): SourceLocation[] => {
  const locations: SourceLocation[] = [];
  const codexDriver = ProviderDriverKind.make("codex");
  const claudeDriver = ProviderDriverKind.make("claudeAgent");
  const codexDefault = ProviderInstanceId.make("codex");
  const claudeDefault = ProviderInstanceId.make("claudeAgent");
  const codexHome = settings.providers.codex.homePath.trim();
  const claudeHome = settings.providers.claudeAgent.homePath.trim();
  locations.push({
    source: "codex",
    providerInstanceId: codexDefault,
    root: path.join(
      path.resolve(
        codexHome
          ? codexHome.replace(/^~(?=$|\/)/u, NodeOS.homedir())
          : path.join(NodeOS.homedir(), ".codex"),
      ),
      "sessions",
    ),
  });
  locations.push({
    source: "claude-code",
    providerInstanceId: claudeDefault,
    root: path.join(
      path.resolve(
        claudeHome
          ? claudeHome.replace(/^~(?=$|\/)/u, NodeOS.homedir())
          : path.join(NodeOS.homedir(), ".claude"),
      ),
      "projects",
    ),
  });

  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (instance.driver !== codexDriver && instance.driver !== claudeDriver) continue;
    const homePath = readConfigHomePath(instance.config);
    if (!homePath) continue;
    const root =
      instance.driver === codexDriver
        ? path.join(path.resolve(homePath.replace(/^~(?=$|\/)/u, NodeOS.homedir())), "sessions")
        : path.join(path.resolve(homePath.replace(/^~(?=$|\/)/u, NodeOS.homedir())), "projects");
    locations.push({
      source: instance.driver === codexDriver ? "codex" : "claude-code",
      providerInstanceId: ProviderInstanceId.make(instanceId),
      root,
    });
  }
  return locations.filter(
    (location, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.source === location.source &&
          candidate.providerInstanceId === location.providerInstanceId &&
          candidate.root === location.root,
      ) === index,
  );
};

const discoverFiles = async (locations: ReadonlyArray<SourceLocation>): Promise<SourceFile[]> => {
  const files: SourceFile[] = [];
  for (const location of locations) {
    const stack = [location.root];
    while (stack.length > 0 && files.length < MAX_DISCOVERED_FILES) {
      const directory = stack.pop();
      if (!directory) break;
      try {
        const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const entryPath = NodePath.join(directory, entry.name);
          if (entry.isDirectory()) {
            stack.push(entryPath);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          try {
            const stat = await NodeFSP.stat(entryPath);
            files.push({
              sourceKey: sourceKeyFor(
                location.source,
                location.providerInstanceId,
                await NodeFSP.realpath(entryPath),
              ),
              source: location.source,
              providerInstanceId: location.providerInstanceId,
              path: entryPath,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            });
          } catch {
            // Files can disappear while the source app rotates its sessions.
          }
          if (files.length >= MAX_DISCOVERED_FILES) break;
        }
      } catch {
        continue;
      }
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
};

const readSession = async (file: SourceFile): Promise<ParsedSession | null> => {
  if (file.size > MAX_TRANSCRIPT_BYTES) {
    throw new WorkjetSessionImportError({ reason: "session_too_large", subject: file.sourceKey });
  }
  const text = await NodeFSP.readFile(file.path, "utf8");
  return parseSession(file, text);
};

const readSessionPreview = async (file: SourceFile): Promise<ParsedSession | null> => {
  const handle = await NodeFSP.open(file.path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(file.size, MAX_PREVIEW_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseSession(file, buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
};

const prefixHash = (messages: ReadonlyArray<ImportedMessage>, count = messages.length): string =>
  sha256(JSON.stringify(messages.slice(0, count)));

const toFailure = (candidateId: string, error: unknown) => ({
  candidateId,
  status: "failed" as const,
  threadId: null,
  importedMessages: 0,
  totalMessages: 0,
  message: isWorkjetSessionImportError(error)
    ? error.message
    : "The static session copy could not be imported.",
});

export interface WorkjetSessionImportShape {
  readonly inspect: (
    limit?: number,
  ) => Effect.Effect<WorkjetSessionImportInspection, WorkjetSessionImportError>;
  readonly importSessions: (
    input: WorkjetSessionImportInput,
  ) => Effect.Effect<WorkjetSessionImportResult>;
}

export class WorkjetSessionImport extends Context.Service<
  WorkjetSessionImport,
  WorkjetSessionImportShape
>()("t3/workjet/sessionImport/WorkjetSessionImport") {}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;

  const inspect: WorkjetSessionImportShape["inspect"] = (requestedLimit) =>
    Effect.gen(function* () {
      const limit = Math.min(requestedLimit ?? 50, WORKJET_SESSION_IMPORT_MAX_CANDIDATES);
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          () => new WorkjetSessionImportError({ reason: "source_unavailable", subject: null }),
        ),
      );
      const locations = resolveLocations(settings, path);
      const files = yield* Effect.tryPromise({
        try: () => discoverFiles(locations),
        catch: () => new WorkjetSessionImportError({ reason: "source_unavailable", subject: null }),
      });
      const rows =
        yield* sql<ImportRow>`SELECT source_key, thread_id, imported_message_count, prefix_hash FROM workjet_session_imports`;
      const importedByKey = new Map(rows.map((row) => [row.source_key, row]));
      const candidates: WorkjetSessionImportCandidate[] = [];
      for (const file of files) {
        if (candidates.length >= limit) break;
        if (file.size > MAX_TRANSCRIPT_BYTES) continue;
        const parsed = yield* Effect.promise(() => readSessionPreview(file).catch(() => null));
        if (!parsed) continue;
        const imported = importedByKey.get(file.sourceKey);
        candidates.push({
          candidateId: file.sourceKey,
          source: file.source,
          providerInstanceId: file.providerInstanceId,
          title: parsed.title,
          workspaceRoot: parsed.workspaceRoot,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          sourceSizeBytes: file.size,
          importedThreadId: imported ? ThreadId.make(imported.thread_id) : null,
          workspaceAvailable: yield* Effect.promise(() =>
            NodeFSP.access(parsed.workspaceRoot).then(
              () => true,
              () => false,
            ),
          ),
        });
      }
      const summaries = (["codex", "claude-code"] as const).map((source) => ({
        source,
        configured: locations.some((location) => location.source === source),
        discoveredCount: files.filter((file) => file.source === source).length,
        shownCount: candidates.filter((candidate) => candidate.source === source).length,
      }));
      return { sources: summaries, candidates, truncated: files.length > candidates.length };
    }).pipe(
      Effect.mapError((error) =>
        isWorkjetSessionImportError(error)
          ? error
          : new WorkjetSessionImportError({ reason: "source_unavailable", subject: null }),
      ),
    );

  const importOne = (candidateId: string) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const locations = resolveLocations(settings, path);
      const files = yield* Effect.tryPromise({
        try: () => discoverFiles(locations),
        catch: () => new WorkjetSessionImportError({ reason: "source_unavailable", subject: null }),
      });
      const file = files.find((entry) => entry.sourceKey === candidateId);
      if (!file)
        return yield* new WorkjetSessionImportError({
          reason: "candidate_expired",
          subject: candidateId,
        });
      const parsed = yield* Effect.tryPromise({
        try: () => readSession(file),
        catch: (error) =>
          isWorkjetSessionImportError(error)
            ? error
            : new WorkjetSessionImportError({ reason: "source_unreadable", subject: candidateId }),
      });
      if (!parsed)
        return yield* new WorkjetSessionImportError({
          reason: "source_unreadable",
          subject: candidateId,
        });

      const existingRows = yield* sql<ImportRow>`
      SELECT source_key, thread_id, imported_message_count, prefix_hash
      FROM workjet_session_imports WHERE source_key = ${candidateId}
    `;
      const existing = existingRows[0];
      if (
        existing &&
        prefixHash(parsed.messages, existing.imported_message_count) !== existing.prefix_hash
      ) {
        return yield* new WorkjetSessionImportError({
          reason: "source_changed",
          subject: candidateId,
        });
      }

      let project = Option.getOrUndefined(
        yield* query.getActiveProjectByWorkspaceRoot(parsed.workspaceRoot),
      );
      const now = new Date().toISOString();
      if (!project) {
        const projectId = ProjectId.make(NodeCrypto.randomUUID());
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          projectId,
          title: NodePath.basename(parsed.workspaceRoot) || "Imported sessions",
          workspaceRoot: parsed.workspaceRoot,
          createWorkspaceRootIfMissing: false,
          createdAt: now,
        } as const satisfies OrchestrationCommand);
        project = Option.getOrUndefined(
          yield* query.getActiveProjectByWorkspaceRoot(parsed.workspaceRoot),
        );
        if (!project)
          return yield* new WorkjetSessionImportError({
            reason: "import_failed",
            subject: candidateId,
          });
      }

      let threadId = existing
        ? ThreadId.make(existing.thread_id)
        : ThreadId.make(stableUuid(`thread:${candidateId}`));
      let thread = Option.getOrUndefined(yield* query.getThreadDetailById(threadId));
      if (!thread) {
        if (existing) threadId = ThreadId.make(NodeCrypto.randomUUID());
        const driver = file.source === "codex" ? "codex" : "claudeAgent";
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          projectId: project.id,
          title: parsed.title,
          modelSelection: {
            instanceId: file.providerInstanceId,
            model: DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make(driver)] ?? "default",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
          branch: null,
          worktreePath: null,
          createdAt: parsed.createdAt,
        } as const satisfies OrchestrationCommand);
        thread = Option.getOrUndefined(yield* query.getThreadDetailById(threadId));
      }

      if (!thread) {
        return yield* new WorkjetSessionImportError({
          reason: "import_failed",
          subject: candidateId,
        });
      }
      const sourceIndexByMessageId = new Map(
        parsed.messages.map((_, index) => [
          MessageId.make(stableUuid(`message:${candidateId}:${index}`)),
          index,
        ]),
      );
      const persistedSourceIndexes = new Set<number>();
      for (const persisted of thread.messages) {
        const index = sourceIndexByMessageId.get(persisted.id);
        const sourceMessage = index === undefined ? undefined : parsed.messages[index];
        if (
          index === undefined ||
          sourceMessage === undefined ||
          persisted.role !== sourceMessage.role ||
          persisted.text !== sourceMessage.text
        ) {
          return yield* new WorkjetSessionImportError({
            reason: "source_changed",
            subject: candidateId,
          });
        }
        persistedSourceIndexes.add(index);
      }
      let alreadyImported = 0;
      while (persistedSourceIndexes.has(alreadyImported)) alreadyImported += 1;
      if (alreadyImported !== persistedSourceIndexes.size) {
        return yield* new WorkjetSessionImportError({
          reason: "source_changed",
          subject: candidateId,
        });
      }
      if (alreadyImported < (existing?.imported_message_count ?? 0)) {
        return yield* new WorkjetSessionImportError({
          reason: "source_changed",
          subject: candidateId,
        });
      }
      const missingMessages = parsed.messages.slice(alreadyImported);
      for (let offset = 0; offset < missingMessages.length; offset += IMPORT_CHUNK_SIZE) {
        const chunk = missingMessages.slice(offset, offset + IMPORT_CHUNK_SIZE);
        yield* engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          messages: chunk.map((message, index) => ({
            messageId: MessageId.make(
              stableUuid(`message:${candidateId}:${alreadyImported + offset + index}`),
            ),
            ...message,
          })),
          createdAt: now,
        } as const satisfies OrchestrationCommand);
      }

      const nextHash = prefixHash(parsed.messages);
      yield* sql`
      INSERT INTO workjet_session_imports (
        source_key, source, provider_instance_id, thread_id,
        imported_message_count, prefix_hash, created_at, updated_at
      ) VALUES (
        ${candidateId}, ${file.source}, ${file.providerInstanceId}, ${threadId},
        ${parsed.messages.length}, ${nextHash}, ${now}, ${now}
      ) ON CONFLICT(source_key) DO UPDATE SET
        thread_id = excluded.thread_id,
        imported_message_count = excluded.imported_message_count,
        prefix_hash = excluded.prefix_hash,
        updated_at = excluded.updated_at
    `;
      return {
        candidateId,
        status: existing
          ? missingMessages.length > 0
            ? ("updated" as const)
            : ("unchanged" as const)
          : ("imported" as const),
        threadId,
        importedMessages: missingMessages.length,
        totalMessages: parsed.messages.length,
        message:
          missingMessages.length > 0
            ? `${missingMessages.length} messages copied into Workjet.`
            : "The Workjet copy is already up to date.",
      };
    }).pipe(
      Effect.mapError((error) =>
        isWorkjetSessionImportError(error)
          ? error
          : new WorkjetSessionImportError({ reason: "import_failed", subject: candidateId }),
      ),
    );

  const importSessions: WorkjetSessionImportShape["importSessions"] = (input) =>
    Effect.forEach(input.candidateIds, (candidateId) =>
      importOne(candidateId).pipe(
        Effect.catch((error) => Effect.succeed(toFailure(candidateId, error))),
      ),
    ).pipe(Effect.map((items) => ({ items })));

  return { inspect, importSessions } satisfies WorkjetSessionImportShape;
});

export const layer = Layer.effect(WorkjetSessionImport, make);
