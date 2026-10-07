// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { matchSessionProject } from "./sessionProjectMatch.ts";
import { projectTranscriptRecords } from "./transcriptRecords.ts";

import {
  CommandId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  MessageId,
  hideSessionInitialization,
  isSessionInitializationPrompt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WORKJET_SESSION_IMPORT_MAX_CANDIDATES,
  WorkjetSessionImportError,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type ServerSettings,
  type WorkjetSessionImportCandidate,
  type WorkjetSessionImportInput,
  type WorkjetSessionImportInspectInput,
  type WorkjetSessionImportInspection,
  type WorkjetSessionImportResult,
  type WorkjetSessionImportSource,
} from "@workjet/contracts";
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

const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_EXTENDED_PREVIEW_BYTES = 4 * MAX_PREVIEW_BYTES;
const MAX_CACHED_PREVIEWS = 512;
const MAX_MESSAGE_CHARS = 200_000;
const IMPORT_CHUNK_SIZE = 200;
// Retain the full normalized object and property order used by persisted prefix hashes.
const encodeImportedMessageJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
  readonly sourceTitles?: ReadonlyMap<string, string>;
  readonly titleVersion?: string;
}

interface ImportedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

interface ParsedSession {
  readonly sourceThreadId?: string;
  readonly repositoryUrl?: string;
  readonly title: string;
  readonly model: string | null;
  readonly workspaceRoot: string | null;
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

import { stableSessionImportId as stableUuid } from "./sessionImportIds.ts";
import { readCodexSessionTitles } from "./sourceSessionTitles.ts";

const sha256 = (value: string | Buffer): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const sourceKeyFor = (
  source: WorkjetSessionImportSource,
  instanceId: string,
  path: string,
): string => `wjsi_${sha256(`${source}\0${instanceId}\0${path}`).slice(0, 32)}`;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const recordedModel = (value: unknown): string | null => {
  const model = asString(value)?.trim();
  return model && model !== "<synthetic>" ? model : null;
};

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

const stripInjectedCodexContext = (text: string): string => {
  let remaining = text.trimStart();
  let stripped = false;
  for (;;) {
    const header = /^# AGENTS\.md instructions(?: for [^\r\n]+)?(?:\r?\n|$)/u.exec(remaining);
    if (header) {
      const body = remaining.slice(header[0].length).trimStart();
      if (!body) return "";
      const instructions = /^<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/u.exec(body);
      if (!instructions) return stripped ? remaining : text;
      remaining = body.slice(instructions[0].length).trimStart();
      stripped = true;
      continue;
    }
    const context =
      /^<(recommended_plugins|permissions instructions|environment_context)>[\s\S]*?<\/\1>/u.exec(
        remaining,
      );
    if (!context) break;
    remaining = remaining.slice(context[0].length).trimStart();
    stripped = true;
  }
  // A literal marker or unknown envelope remains user text.
  return stripped ? remaining : text;
};

// These are UI context messages, not the user's conversation title or history.
const stripCodexUiContext = (text: string): string =>
  text
    .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/gu, "")
    .replace(/<codex_apps_open_page>[\s\S]*?<\/codex_apps_open_page>/gu, "")
    .trim();

const isInternalHealthProbe = (text: string): boolean =>
  text.trimStart().startsWith("WORKJET HEALTH PROBE V1.");

const initializationText = (text: string): boolean =>
  isSessionInitializationPrompt(text) ||
  /^(?:hi|hello|hallo|READY|BEREIT)[.!]?$/iu.test(text.trim());

const transcriptParser = (
  source: WorkjetSessionImportSource,
  fallbackIso: string,
  sourceTitles: ReadonlyMap<string, string> = new Map(),
) => {
  let workspaceRoot = "";
  let sourceThreadId: string | undefined;
  let repositoryUrl: string | undefined;
  let recordedTitle = "";
  let customTitle = "";
  let createdAt = fallbackIso;
  let updatedAt = fallbackIso;
  let model: string | null = null;
  let valid = true;
  let userFound = false;
  let contextOnlyUserFound = false;
  let meaningful = false;
  let count = 0;
  let firstUser = "";
  let firstContentUser = "";
  const feed = (line: string): ImportedMessage | null => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    const record = asRecord(value);
    if (!record) return null;
    let role: unknown;
    let text = "";
    if (source === "codex") {
      const payload = asRecord(record.payload);
      if (record.type === "session_meta" && payload) {
        if (payload.parent_thread_id || payload.agent_path) valid = false;
        workspaceRoot = asString(payload.cwd) ?? workspaceRoot;
        sourceThreadId = asString(payload.id)?.trim().slice(0, 256) || sourceThreadId;
        repositoryUrl = asString(asRecord(payload.git)?.repository_url) ?? repositoryUrl;
        recordedTitle =
          sourceTitles.get(asString(payload.id) ?? "") ??
          asString(payload.title) ??
          asString(payload.thread_name) ??
          recordedTitle;
        createdAt = isoOr(payload.timestamp ?? record.timestamp, createdAt);
        model = recordedModel(payload.model) ?? model;
        return null;
      }
      if (record.type === "turn_context" && payload) {
        model = recordedModel(payload.model) ?? model;
        return null;
      }
      if (record.type !== "response_item" || payload?.type !== "message") return null;
      if (payload.channel === "analysis") return null;
      role = payload.role;
      const visible = stripCodexUiContext(
        visibleText(payload.content, role === "user" ? "input_text" : "output_text"),
      );
      text = role === "user" ? stripInjectedCodexContext(visible) : visible;
      if (role === "user" && visible && !text) contextOnlyUserFound = true;
    } else {
      if (record.isSidechain === true) valid = false;
      workspaceRoot = asString(record.cwd) ?? workspaceRoot;
      sourceThreadId ||= asString(record.sessionId)?.trim().slice(0, 256) || undefined;
      if (record.type === "ai-title")
        recordedTitle = asString(record.aiTitle) ?? asString(record.title) ?? recordedTitle;
      if (record.type === "custom-title") customTitle = asString(record.customTitle) ?? customTitle;
      if (record.type !== "user" && record.type !== "assistant") return null;
      const message = asRecord(record.message);
      role = message?.role;
      if (role === "assistant") model = recordedModel(message?.model) ?? model;
      text = visibleText(message?.content, "text").trim();
    }
    if ((role !== "user" && role !== "assistant") || !text) return null;
    if (role === "user") {
      userFound = true;
      firstUser ||= text;
      if (!initializationText(text)) firstContentUser ||= text;
      if (isInternalHealthProbe(text)) valid = false;
    }
    meaningful ||= !initializationText(text);
    const timestamp = isoOr(record.timestamp, fallbackIso);
    if (source === "claude-code" && count === 0) createdAt = timestamp;
    count += 1;
    updatedAt = timestamp;
    return { role, text, createdAt: timestamp };
  };
  return {
    feed,
    hasContent: () => meaningful,
    finish: (messages: ReadonlyArray<ImportedMessage>): ParsedSession | null => {
      // Some named Codex work histories log only injected context as user messages.
      // Keep their visible assistant history without fabricating a user request.
      const namedContextHistory =
        source === "codex" &&
        contextOnlyUserFound &&
        meaningful &&
        !!sourceThreadId &&
        !!recordedTitle.trim() &&
        !initializationText(recordedTitle);
      if (!valid || (!userFound && !namedContextHistory)) return null;
      const title =
        customTitle ||
        recordedTitle ||
        firstContentUser ||
        firstUser ||
        (source === "codex" ? "Codex session" : "Claude Code session");
      return {
        title: title.replace(/\s+/gu, " ").slice(0, 120).trim(),
        model,
        workspaceRoot: workspaceRoot || null,
        createdAt,
        updatedAt,
        messages,
        ...(sourceThreadId ? { sourceThreadId } : {}),
        ...(repositoryUrl ? { repositoryUrl } : {}),
      };
    },
  };
};

export const parseCodexSessionTranscript = (
  lines: ReadonlyArray<string>,
  fallbackIso: string,
  sourceTitles: ReadonlyMap<string, string> = new Map(),
): ParsedSession | null => {
  const parser = transcriptParser("codex", fallbackIso, sourceTitles);
  return parser.finish(
    lines.flatMap((line) => {
      const message = parser.feed(line);
      return message ? [message] : [];
    }),
  );
};

export const parseClaudeSessionTranscript = (
  lines: ReadonlyArray<string>,
  fallbackIso: string,
): ParsedSession | null => {
  const parser = transcriptParser("claude-code", fallbackIso);
  return parser.finish(
    lines.flatMap((line) => {
      const message = parser.feed(line);
      return message ? [message] : [];
    }),
  );
};

const parseSession = (file: SourceFile, text: string, complete: boolean): ParsedSession | null => {
  const fallbackIso = new Date(file.mtimeMs).toISOString();
  const lines = text.split(/\r?\n/u).filter(Boolean);
  const parsed =
    file.source === "codex"
      ? parseCodexSessionTranscript(lines, fallbackIso, file.sourceTitles)
      : parseClaudeSessionTranscript(lines, fallbackIso);
  if (
    !parsed ||
    (complete &&
      parsed.messages.every((message) => initializationText(message.text)))
  )
    return null;
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
  return locations
    .flatMap((location) =>
      location.source === "codex"
        ? [
            location,
            { ...location, root: path.join(path.dirname(location.root), "archived_sessions") },
          ]
        : [location],
    )
    .filter(
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
  const titlesByHome = new Map<string, ReadonlyMap<string, string>>();
  for (const location of locations) {
    const home = NodePath.dirname(location.root);
    const sourceTitles =
      location.source === "codex"
        ? (titlesByHome.get(home) ?? (await readCodexSessionTitles(home)))
        : undefined;
    if (sourceTitles) titlesByHome.set(home, sourceTitles);
    const titleVersion = sourceTitles ? sha256(JSON.stringify([...sourceTitles])) : "";
    const stack = [location.root];
    while (stack.length > 0) {
      const directory = stack.pop();
      if (!directory) break;
      try {
        const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
        let entryIndex = 0;
        // Refresh source metadata on every inspection with at most two filesystem workers.
        const readEntries = async (): Promise<void> => {
          while (entryIndex < entries.length) {
            const entry = entries[entryIndex];
            entryIndex += 1;
            if (!entry || entry.isSymbolicLink()) continue;
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
                ...(sourceTitles ? { sourceTitles, titleVersion } : {}),
              });
            } catch {
              // Files can disappear while the source app rotates its sessions.
            }
          }
        };
        await Promise.all([readEntries(), readEntries()]);
      } catch {
        continue;
      }
    }
  }
  return files.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.sourceKey.localeCompare(right.sourceKey),
  );
};

interface SessionArchive {
  readonly session: Omit<ParsedSession, "messages">;
  readonly messageCount: number;
  readonly fullHash: string;
  readonly messages: () => AsyncGenerator<ImportedMessage>;
  readonly dispose: () => Promise<void>;
}

const readSession = async (
  file: SourceFile,
  signal: AbortSignal,
): Promise<SessionArchive | null> => {
  const expected = await NodeFSP.lstat(file.path);
  if (
    !expected.isFile() ||
    sourceKeyFor(file.source, file.providerInstanceId, await NodeFSP.realpath(file.path)) !==
      file.sourceKey
  )
    throw new WorkjetSessionImportError({ reason: "candidate_expired", subject: file.sourceKey });
  const handle = await NodeFSP.open(
    file.path,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  let directory: string | undefined;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.size !== expected.size ||
      stat.mtimeMs !== expected.mtimeMs
    )
      throw new WorkjetSessionImportError({ reason: "source_changed", subject: file.sourceKey });
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-visible-history-"));
    const archivePath = NodePath.join(directory, "messages.jsonl");
    const sink = await NodeFSP.open(archivePath, "wx", 0o600);
    const parser = transcriptParser(
      file.source,
      new Date(stat.mtimeMs).toISOString(),
      file.sourceTitles,
    );
    let messageCount = 0;
    let bytesRead = 0;
    const hash = NodeCrypto.createHash("sha256").update("[");
    const sourceHash = NodeCrypto.createHash("sha256");
    try {
      const chunks = handle.createReadStream({
        encoding: null,
        highWaterMark: 64 * 1024,
        autoClose: false,
        start: 0,
        end: Math.max(0, stat.size - 1),
        signal,
      });
      const decoded = async function* () {
        const decoder = new NodeStringDecoder.StringDecoder("utf8");
        for await (const chunk of chunks as AsyncIterable<Buffer>) {
          sourceHash.update(chunk);
          yield decoder.write(chunk);
        }
        const tail = decoder.end();
        if (tail) yield tail;
      };
      for await (const line of projectTranscriptRecords(decoded())) {
        signal.throwIfAborted();
        const parsedMessage = parser.feed(line);
        if (!parsedMessage) continue;
        const message =
          parsedMessage.text.length > MAX_MESSAGE_CHARS
            ? {
                ...parsedMessage,
                text:
                  parsedMessage.text.slice(0, MAX_MESSAGE_CHARS - 25) +
                  "\n[message text truncated]",
              }
            : parsedMessage;
        const encoded = JSON.stringify(message);
        if (messageCount) hash.update(",");
        hash.update(encoded);
        messageCount += 1;
        await sink.writeFile(encoded + "\n");
      }
      bytesRead = chunks.bytesRead;
    } finally {
      await sink.close();
    }
    const after = await handle.stat();
    const pathname = await NodeFSP.lstat(file.path);
    if (
      bytesRead !== stat.size ||
      after.size < stat.size ||
      (after.size === stat.size && after.mtimeMs !== stat.mtimeMs) ||
      pathname.dev !== stat.dev ||
      pathname.ino !== stat.ino
    )
      throw new WorkjetSessionImportError({ reason: "source_changed", subject: file.sourceKey });
    if (after.size > stat.size) {
      // A live parent may append. Verify the exact fixed byte prefix before accepting its snapshot.
      const verifyHash = NodeCrypto.createHash("sha256");
      const prefix = handle.createReadStream({
        encoding: null,
        highWaterMark: 64 * 1024,
        autoClose: false,
        start: 0,
        end: Math.max(0, stat.size - 1),
        signal,
      });
      for await (const chunk of prefix as AsyncIterable<Buffer>) verifyHash.update(chunk);
      const verified = await handle.stat();
      const currentPath = await NodeFSP.lstat(file.path);
      if (
        prefix.bytesRead !== stat.size ||
        verified.size < stat.size ||
        currentPath.dev !== stat.dev ||
        currentPath.ino !== stat.ino ||
        verifyHash.digest("hex") !== sourceHash.digest("hex")
      )
        throw new WorkjetSessionImportError({ reason: "source_changed", subject: file.sourceKey });
    }
    signal.throwIfAborted();
    const parsed = parser.finish([]);
    if (!parsed || !parser.hasContent()) {
      await NodeFSP.rm(directory, { recursive: true, force: true });
      return null;
    }
    const ownedDirectory = directory;
    const messages = async function* (): AsyncGenerator<ImportedMessage> {
      const stream = NodeFS.createReadStream(archivePath, {
        encoding: "utf8",
        highWaterMark: 64 * 1024,
      });
      const lines = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) yield JSON.parse(line) as ImportedMessage;
      } finally {
        lines.close();
        stream.destroy();
      }
    };
    return {
      session: parsed,
      messageCount,
      fullHash: hash.update("]").digest("hex"),
      messages,
      dispose: () => NodeFSP.rm(ownedDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await handle.close();
  }
};

const readSessionPreview = async (file: SourceFile): Promise<ParsedSession | null> => {
  const handle = await NodeFSP.open(file.path, "r");
  try {
    // An attached image can make the first visible JSONL record exceed the usual preview.
    for (const limit of [MAX_PREVIEW_BYTES, MAX_EXTENDED_PREVIEW_BYTES]) {
      const buffer = Buffer.alloc(Math.min(file.size, limit));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const complete = bytesRead >= file.size;
      const parsed = parseSession(file, buffer.subarray(0, bytesRead).toString("utf8"), complete);
      if (parsed || complete) return parsed;
    }
    return null;
  } finally {
    await handle.close();
  }
};

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
    input?: WorkjetSessionImportInspectInput,
  ) => Effect.Effect<WorkjetSessionImportInspection, WorkjetSessionImportError>;
  readonly refreshTitles: Effect.Effect<void>;
  readonly importSessions: (
    input: WorkjetSessionImportInput,
  ) => Effect.Effect<WorkjetSessionImportResult>;
}

export class WorkjetSessionImport extends Context.Service<
  WorkjetSessionImport,
  WorkjetSessionImportShape
>()("workjet/workjet/sessionImport/WorkjetSessionImport") {}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;

  // Reuse source paths across import batches, without retaining transcript content.
  let indexedLocations: readonly SourceLocation[] = [];
  let indexedFiles = new Map<string, SourceFile>();
  const rememberFiles = (locations: readonly SourceLocation[], files: readonly SourceFile[]) => {
    indexedLocations = locations;
    indexedFiles = new Map(files.map((file) => [file.sourceKey, file]));
  };
  const sameLocations = (locations: readonly SourceLocation[]) =>
    locations.length === indexedLocations.length &&
    locations.every((location, index) => {
      const previous = indexedLocations[index];
      return (
        previous?.source === location.source &&
        previous.providerInstanceId === location.providerInstanceId &&
        previous.root === location.root
      );
    });

  const previewCache = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly session: Omit<ParsedSession, "messages"> & {
        readonly previewMessages: NonNullable<WorkjetSessionImportCandidate["previewMessages"]>;
      };
    }
  >();
  const inspect: WorkjetSessionImportShape["inspect"] = (input = {}) =>
    Effect.gen(function* () {
      const limit = Math.min(input.limit ?? 20, WORKJET_SESSION_IMPORT_MAX_CANDIDATES);
      const offset = input.offset ?? 0;
      const search = input.query?.trim().toLocaleLowerCase() ?? "";
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
      rememberFiles(locations, files);
      const discoveryHash = NodeCrypto.createHash("sha256");
      for (const file of files) {
        if (input.source && file.source !== input.source) continue;
        discoveryHash
          .update(file.sourceKey)
          .update("\0")
          .update(String(file.size))
          .update("\0")
          .update(String(file.mtimeMs))
          .update(file.titleVersion ?? "")
          .update("\n");
      }
      const discoveryVersion = discoveryHash.digest("hex");
      const rows =
        yield* sql<ImportRow>`SELECT source_key, thread_id, imported_message_count, prefix_hash FROM workjet_session_imports`;
      const fileKeys = new Set(files.map((file) => file.sourceKey));
      for (const key of previewCache.keys()) if (!fileKeys.has(key)) previewCache.delete(key);
      const candidates: WorkjetSessionImportCandidate[] = [];
      let matched = 0;
      let hasMore = false;
      for (const file of files) {
        if (input.source && file.source !== input.source) continue;
        const fingerprint = `${file.mtimeMs}:${file.size}:${file.titleVersion ?? ""}`;
        let parsed =
          previewCache.get(file.sourceKey)?.fingerprint === fingerprint
            ? previewCache.get(file.sourceKey)?.session
            : undefined;
        if (!parsed) {
          const preview = yield* Effect.promise(() => readSessionPreview(file).catch(() => null));
          if (preview) {
            parsed = {
              title: preview.title,
              ...(preview.sourceThreadId ? { sourceThreadId: preview.sourceThreadId } : {}),
              ...(preview.repositoryUrl ? { repositoryUrl: preview.repositoryUrl } : {}),
              model: preview.model,
              workspaceRoot: preview.workspaceRoot,
              createdAt: preview.createdAt,
              updatedAt: preview.updatedAt,
              previewMessages: preview.messages
                .slice(0, 3)
                .map(({ role, text }) => ({ role, text: text.slice(0, 1_000) })),
            };
            previewCache.set(file.sourceKey, { fingerprint, session: parsed });
            if (previewCache.size > MAX_CACHED_PREVIEWS) {
              const oldestKey = previewCache.keys().next().value;
              if (oldestKey !== undefined) previewCache.delete(oldestKey);
            }
          }
        }
        if (!parsed) continue;
        if (
          search &&
          !`${parsed.title}\n${parsed.workspaceRoot ?? ""}`.toLocaleLowerCase().includes(search)
        )
          continue;
        if (matched++ < offset) continue;
        if (candidates.length === limit) {
          hasMore = true;
          break;
        }
        const copies = rows.filter(
          (row) =>
            row.source_key === file.sourceKey || row.source_key.startsWith(`${file.sourceKey}:`),
        );
        const importedCopies: NonNullable<
          WorkjetSessionImportCandidate["importedCopies"]
        >[number][] = [];
        for (const copy of copies) {
          const thread = Option.getOrUndefined(
            yield* query.getThreadShellById(ThreadId.make(copy.thread_id)),
          );
          if (thread && !importedCopies.some((entry) => entry.threadId === thread.id))
            importedCopies.push({ projectId: thread.projectId, threadId: thread.id });
        }
        candidates.push({
          candidateId: file.sourceKey,
          source: file.source,
          providerInstanceId: file.providerInstanceId,
          title: parsed.title,
          ...(parsed.sourceThreadId ? { sourceThreadId: parsed.sourceThreadId } : {}),
          workspaceRoot: parsed.workspaceRoot,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          sourceSizeBytes: file.size,
          importedThreadId: importedCopies[0]?.threadId ?? null,
          importedCopies,
          previewMessages: parsed.previewMessages,
          workspaceAvailable: yield* Effect.promise(() =>
            parsed.workspaceRoot
              ? NodeFSP.access(parsed.workspaceRoot).then(
                  () => true,
                  () => false,
                )
              : Promise.resolve(false),
          ),
        });
      }
      const summaries = (["codex", "claude-code"] as const).map((source) => ({
        source,
        configured: locations.some((location) => location.source === source),
        discoveredCount: files.filter((file) => file.source === source).length,
        shownCount: candidates.filter((candidate) => candidate.source === source).length,
      }));
      return {
        sources: summaries,
        candidates,
        truncated: hasMore,
        discoveryVersion,
        nextOffset: hasMore ? offset + candidates.length : null,
        discoveryLimitReached: false,
      };
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) =>
        isWorkjetSessionImportError(error)
          ? error
          : new WorkjetSessionImportError({ reason: "source_unavailable", subject: null }),
      ),
    );

  const importOne = (
    candidateId: string,
    file: SourceFile | undefined,
    destinationProjectId?: ProjectId,
    destinationProject?: OrchestrationProjectShell,
  ) =>
    Effect.gen(function* () {
      if (!file)
        return yield* new WorkjetSessionImportError({
          reason: "candidate_expired",
          subject: candidateId,
        });
      const archive = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: (signal) => readSession(file, signal),
          catch: (error) =>
            isWorkjetSessionImportError(error)
              ? error
              : new WorkjetSessionImportError({
                  reason: "source_unreadable",
                  subject: candidateId,
                }),
        }),
        (archive) => Effect.promise(() => archive?.dispose() ?? Promise.resolve()),
        { interruptible: true },
      );
      if (!archive)
        return yield* new WorkjetSessionImportError({
          reason: "source_unreadable",
          subject: candidateId,
        });

      const parsed = archive.session;
      let project = destinationProjectId ? destinationProject : undefined;
      if (!destinationProjectId) {
        const snapshot = yield* query.getShellSnapshot();
        project = matchSessionProject(parsed, snapshot.projects);
        if (!project && !parsed.repositoryUrl && parsed.workspaceRoot) {
          const remote = yield* Effect.promise(async () => {
            try {
              return (
                await NodeUtil.promisify(NodeChildProcess.execFile)(
                  "git",
                  ["-C", parsed.workspaceRoot!, "remote", "get-url", "origin"],
                  { timeout: 3000, maxBuffer: 8192 },
                )
              ).stdout.trim();
            } catch {
              return undefined;
            }
          });
          if (remote)
            project = matchSessionProject({ ...parsed, repositoryUrl: remote }, snapshot.projects);
        }
      }
      if (!project)
        return yield* new WorkjetSessionImportError({
          reason: "project_unavailable",
          subject: candidateId,
        });
      const now = new Date().toISOString();
      // Separate copies in separate projects; legacy single-copy keys remain readable.
      const importKey = `${candidateId}:${project.id}`;
      const existingRows = yield* sql<ImportRow>`
      SELECT source_key, thread_id, imported_message_count, prefix_hash
      FROM workjet_session_imports WHERE source_key = ${importKey} OR source_key = ${candidateId}
    `;
      let existing = existingRows.find((row) => row.source_key === importKey);
      if (existing) {
        const copy = Option.getOrUndefined(
          yield* query.getThreadShellById(ThreadId.make(existing.thread_id)),
        );
        if (!copy) existing = undefined;
        else if (copy.projectId !== project.id)
          return yield* new WorkjetSessionImportError({
            reason: "source_changed",
            subject: candidateId,
          });
      }
      const legacy = existingRows.find((row) => row.source_key === candidateId);
      if (!existing && legacy) {
        const legacyThread = Option.getOrUndefined(
          yield* query.getThreadShellById(ThreadId.make(legacy.thread_id)),
        );
        if (legacyThread?.projectId === project.id) existing = legacy;
      }
      const threadId = existing
        ? ThreadId.make(existing.thread_id)
        : existingRows.some((row) => row.source_key === importKey)
          ? ThreadId.make(NodeCrypto.randomUUID())
          : ThreadId.make(stableUuid(`thread:${importKey}`));
      const messageSeed =
        existing?.source_key === candidateId ? candidateId : `${importKey}:${threadId}`;
      const thread = Option.getOrUndefined(yield* query.getThreadDetailById(threadId));
      if ((!thread && existing) || thread?.deletedAt != null) {
        return yield* new WorkjetSessionImportError({
          reason: "source_changed",
          subject: candidateId,
        });
      }
      const createThread = thread
        ? undefined
        : {
            projectId: project.id,
            title: parsed.title,
            modelSelection: {
              instanceId: file.providerInstanceId,
              model: parsed.model ?? "unknown",
            },
            runtimeMode: "approval-required" as const,
            interactionMode: "default" as const,
            workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
            branch: null,
            worktreePath: null,
            createdAt: parsed.createdAt,
          };
      const persistedById = new Map(
        (thread?.messages ?? []).map((message) => [message.id, message]),
      );
      let alreadyImported = 0;
      let sourceIndex = 0;
      let recordedPrefix: string | undefined;
      const prefix = NodeCrypto.createHash("sha256").update("[");
      if (existing?.imported_message_count === 0)
        recordedPrefix = prefix.copy().update("]").digest("hex");
      const validationMessages = yield* Effect.acquireRelease(
        Effect.sync(archive.messages),
        (iterator) => Effect.promise(() => iterator.return(undefined)),
      );
      for (;;) {
        const next = yield* Effect.promise(() => validationMessages.next());
        if (next.done) break;
        const message = next.value;
        if (sourceIndex) prefix.update(",");
        prefix.update(yield* encodeImportedMessageJson(message).pipe(Effect.orDie));
        const persisted = persistedById.get(
          MessageId.make(stableUuid(`message:${messageSeed}:${sourceIndex}`)),
        );
        if (persisted) {
          if (
            sourceIndex !== alreadyImported ||
            persisted.role !== message.role ||
            persisted.text !== message.text
          )
            return yield* new WorkjetSessionImportError({
              reason: "source_changed",
              subject: candidateId,
            });
          alreadyImported += 1;
        }
        sourceIndex += 1;
        if (sourceIndex === existing?.imported_message_count)
          recordedPrefix = prefix.copy().update("]").digest("hex");
      }
      if (existing && recordedPrefix !== existing.prefix_hash)
        return yield* new WorkjetSessionImportError({
          reason: "source_changed",
          subject: candidateId,
        });
      if (alreadyImported < (existing?.imported_message_count ?? 0)) {
        return yield* new WorkjetSessionImportError({
          reason: "source_changed",
          subject: candidateId,
        });
      }
      const missingMessageCount = archive.messageCount - alreadyImported;
      if (
        missingMessageCount === 0 &&
        Option.isNone(yield* query.getProjectShellById(project.id))
      ) {
        return yield* new WorkjetSessionImportError({
          reason: "project_unavailable",
          subject: candidateId,
        });
      }
      let offset = 0;
      let chunk: ImportedMessage[] = [];
      let chunkChars = 0;
      const saveChunk = (messages: ImportedMessage[], start: number) =>
        engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          ...(start === alreadyImported && createThread ? { bootstrap: { createThread } } : {}),
          messages: messages.map((message, index) => ({
            messageId: MessageId.make(stableUuid(`message:${messageSeed}:${start + index}`)),
            ...message,
          })),
          createdAt: now,
        } as const satisfies OrchestrationCommand);
      const importMessages = yield* Effect.acquireRelease(
        Effect.sync(archive.messages),
        (iterator) => Effect.promise(() => iterator.return(undefined)),
      );
      for (;;) {
        const next = yield* Effect.promise(() => importMessages.next());
        if (next.done) break;
        const message = next.value;
        if (offset++ < alreadyImported) continue;
        chunk.push(message);
        chunkChars += message.text.length;
        if (chunk.length === IMPORT_CHUNK_SIZE || chunkChars >= 500_000) {
          yield* saveChunk(chunk, offset - chunk.length);
          chunk = [];
          chunkChars = 0;
        }
      }
      if (chunk.length) yield* saveChunk(chunk, offset - chunk.length);

      const nextHash = archive.fullHash;
      yield* sql`
      INSERT INTO workjet_session_imports (
        source_key, source, provider_instance_id, thread_id,
        imported_message_count, prefix_hash, created_at, updated_at
      ) VALUES (
        ${existing?.source_key ?? importKey}, ${file.source}, ${file.providerInstanceId}, ${threadId},
        ${archive.messageCount}, ${nextHash}, ${now}, ${now}
      ) ON CONFLICT(source_key) DO UPDATE SET
        thread_id = excluded.thread_id,
        imported_message_count = excluded.imported_message_count,
        prefix_hash = excluded.prefix_hash,
        updated_at = excluded.updated_at
    `;
      return {
        candidateId,
        status: existing
          ? missingMessageCount > 0
            ? ("updated" as const)
            : ("unchanged" as const)
          : ("imported" as const),
        threadId,
        importedMessages: missingMessageCount,
        totalMessages: archive.messageCount,
        message:
          missingMessageCount > 0
            ? `${missingMessageCount} messages copied into Workjet.`
            : "The Workjet copy is already up to date.",
      };
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) =>
        isWorkjetSessionImportError(error)
          ? error
          : new WorkjetSessionImportError({ reason: "import_failed", subject: candidateId }),
      ),
    );

  const importSessions: WorkjetSessionImportShape["importSessions"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const locations = resolveLocations(settings, path);
      if (!sameLocations(locations) || input.candidateIds.some((id) => !indexedFiles.has(id))) {
        const files = yield* Effect.tryPromise({
          try: () => discoverFiles(locations),
          catch: () =>
            new WorkjetSessionImportError({ reason: "source_unavailable", subject: null }),
        });
        rememberFiles(locations, files);
      }
      const byId = indexedFiles;
      // Resolve the explicitly chosen destination once per bounded request. The
      // engine checks active thread/project state again before every saved chunk.
      const destinationProject = input.projectId
        ? Option.getOrUndefined(yield* query.getProjectShellById(input.projectId))
        : undefined;
      const items = yield* Effect.forEach([...new Set(input.candidateIds)], (candidateId) =>
        importOne(candidateId, byId.get(candidateId), input.projectId, destinationProject).pipe(
          Effect.catch((error) => Effect.succeed(toFailure(candidateId, error))),
        ),
      );
      return { items };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          items: [...new Set(input.candidateIds)].map((candidateId) =>
            toFailure(
              candidateId,
              isWorkjetSessionImportError(error)
                ? error
                : new WorkjetSessionImportError({
                    reason: "source_unavailable",
                    subject: candidateId,
                  }),
            ),
          ),
        }),
      ),
    );

  const refreshTitles = Effect.gen(function* () {
    const rows =
      yield* sql<ImportRow>`SELECT source_key, thread_id, imported_message_count, prefix_hash FROM workjet_session_imports`;
    const legacyRows = yield* sql<{
      readonly thread_id: string;
      readonly provider_name: string;
      readonly provider_instance_id: string | null;
      readonly resume_cursor_json: string | null;
    }>`SELECT thread_id, provider_name, provider_instance_id, resume_cursor_json FROM provider_session_runtime`.pipe(
      Effect.catch(() => Effect.succeed([])),
    );
    if (rows.length === 0 && legacyRows.length === 0) return;
    const settings = yield* settingsService.getSettings;
    const files = yield* Effect.promise(() => discoverFiles(resolveLocations(settings, path)));
    for (const file of files) {
      const provider = file.source === "codex" ? "codex" : "claudeAgent";
      const legacyCopies = legacyRows.filter((row) => {
        if (
          row.provider_name !== provider ||
          (row.provider_instance_id ?? provider) !== file.providerInstanceId
        )
          return false;
        try {
          const cursor = asRecord(JSON.parse(row.resume_cursor_json ?? "null"));
          const resume = asString(cursor?.resume);
          return (
            resume !== null &&
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(resume) &&
            file.path.endsWith(resume + ".jsonl")
          );
        } catch {
          return false;
        }
      });
      const copies = [
        ...new Set([
          ...rows
            .filter(
              (row) =>
                row.source_key === file.sourceKey ||
                row.source_key.startsWith(file.sourceKey + ":"),
            )
            .map((row) => row.thread_id),
          ...legacyCopies.map((row) => row.thread_id),
        ]),
      ];
      if (copies.length === 0) continue;
      const parsed = yield* Effect.promise(() => readSessionPreview(file).catch(() => null));
      if (!parsed) continue;
      const originalTitle = parsed.messages
        .find((message) => message.role === "user")
        ?.text.replace(/\s+/gu, " ")
        .slice(0, 120)
        .trim();
      for (const copy of copies) {
        const threadId = ThreadId.make(copy);
        const thread = Option.getOrUndefined(yield* query.getThreadShellById(threadId));
        // Respect a local rename; only correct the importer-generated first-prompt title.
        const initialHandshake =
          hideSessionInitialization(parsed.messages).length < parsed.messages.length;
        const automaticInitTitle =
          initialHandshake &&
          /^(?:hi|hallo|hello|bereit|ready|nur bereit antworten)[.!]?$/iu.test(thread?.title ?? "");
        if (
          !thread ||
          (thread.title !== originalTitle && !automaticInitTitle) ||
          thread.title === parsed.title
        )
          continue;
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          title: parsed.title,
        });
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Imported session title refresh failed", { cause }),
    ),
  );
  return { inspect, importSessions, refreshTitles } satisfies WorkjetSessionImportShape;
});

export const layer = Layer.effect(WorkjetSessionImport, make);
