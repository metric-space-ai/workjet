// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Builds the redacted support bundle.
 *
 * FORMAT — one pretty-printed JSON file, not an archive. Three reasons, in
 * order of weight:
 *
 *  1. The bundle only helps if the user can READ IT BEFORE SENDING IT. A
 *     single JSON file opens in any editor; a zip has to be unpacked first,
 *     and in practice nobody unpacks it, which turns "inspectable" into a
 *     claim rather than a property.
 *  2. A single document makes the two hard guarantees enforceable. The size
 *     ceiling is one `Buffer.byteLength` check, and the field inventory is
 *     one walk of one object — an archive would need a per-entry gate and a
 *     per-entry inventory, i.e. exactly the sprawl that lets a field slip in
 *     undeclared.
 *  3. It adds no dependency. Pulling an archiver into the main process to
 *     write a diagnostics file would enlarge the trusted surface of the very
 *     component this wave is hardening.
 *
 * CONTENT — everything comes from surfaces that already exist (the desktop
 * environment, the persisted desktop settings, the user-data migration
 * decision, the crash-reporter state, the gateway configuration the server
 * writes, and the rotating log files under `<stateDir>/logs`). Nothing here
 * is a new telemetry channel, and nothing is sampled continuously: the
 * bundle is built once, on an explicit user action.
 *
 * REDACTION — every value passes `SupportBundleRedaction`. See that module
 * for the gate itself. Two rules matter for reading this file: a value the
 * gate refuses becomes a named `[omitted:*]` placeholder rather than
 * disappearing, and a log line is never carried as free text — only the
 * named fields of the structured record are projected out.
 *
 * DELIVERY — the file is written to
 * `<stateDir>/support-bundles/ctox-support-bundle-<timestamp>.json` and its
 * exact path is returned to the caller so the UI can show it. It is never
 * uploaded, and there is no code path that could upload it.
 */
import {
  SUPPORT_BUNDLE_MAX_ACCOUNTS,
  SUPPORT_BUNDLE_MAX_BYTES,
  SUPPORT_BUNDLE_MAX_LOG_FILES,
  SUPPORT_BUNDLE_MAX_LOG_LINES,
  SUPPORT_BUNDLE_PLACEHOLDERS,
  SUPPORT_BUNDLE_SCHEMA_VERSION,
  type DesktopSupportBundleResult,
  type SupportBundleDocument,
  type SupportBundleGatewayAccount,
  type SupportBundleGatewaySection,
  type SupportBundleLogExcerpt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopUserDataMigration from "../app/DesktopUserDataMigration.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopCrashReporting from "./DesktopCrashReporting.ts";
import {
  gateBoolean,
  gateCount,
  gateInteger,
  gateLabel,
  gateLogLine,
  gateText,
  makeSupportRedactionLedger,
  type SupportRedactionLedger,
} from "./SupportBundleRedaction.ts";

const { logInfo: logBundleInfo } = makeComponentLogger("desktop-support-bundle");

/** Directory the bundle is written into, under the desktop state directory. */
export const SUPPORT_BUNDLE_DIRECTORY_NAME = "support-bundles";

/** Tail of each log file that is even read, before line selection. */
const LOG_TAIL_MAX_BYTES = 262_144;

/** A log file larger than this is skipped outright rather than streamed. */
const LOG_FILE_MAX_BYTES = 33_554_432;

const LOG_FILE_EXTENSIONS = [".log", ".ndjson"] as const;

/** Closed label sets. An unknown value becomes `[omitted:unredactable]`. */
const SERVER_EXPOSURE_MODES = ["local-only", "network-accessible"] as const;
const UPDATE_CHANNELS = ["latest", "nightly"] as const;
const MIGRATION_DECISIONS = ["fresh", "migrate-offer", "copy-pending", "already-migrated"] as const;
const MIGRATION_OUTCOMES = ["migrated", "declined", "accepted-pending"] as const;
const GATEWAY_ROUTING_STRATEGIES = ["round-robin", "fill-first", "weighted-round-robin"] as const;
const GATEWAY_PROVIDERS = [
  "claude",
  "codex",
  "antigravity",
  "zai",
  "minimax",
  "xai",
  "kimi",
] as const;

export class DesktopSupportBundleWriteError extends Schema.TaggedErrorClass<DesktopSupportBundleWriteError>()(
  "DesktopSupportBundleWriteError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to write the support bundle to ${this.filePath}.`;
  }
}

export interface DesktopSupportBundleRuntimeVersions {
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly v8: string;
}

const readProcessRuntimeVersions = (): DesktopSupportBundleRuntimeVersions => ({
  electron: process.versions.electron ?? "",
  chrome: process.versions.chrome ?? "",
  node: process.versions.node ?? "",
  v8: process.versions.v8 ?? "",
});

export class DesktopSupportBundle extends Context.Service<
  DesktopSupportBundle,
  {
    /** Collects and redacts, without touching the filesystem for output. */
    readonly build: Effect.Effect<SupportBundleDocument>;
    /** Collects, redacts, writes, and reports the exact path. */
    readonly create: Effect.Effect<DesktopSupportBundleResult, DesktopSupportBundleWriteError>;
  }
>()("@t3tools/desktop/support/DesktopSupportBundle") {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const countArray = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/**
 * Reduces one raw gateway account object to routing facts.
 *
 * `label` and `credentialSuffix` are read but never emitted: the label is
 * user-typed free text that regularly carries an account name or an
 * environment secret, and the suffix is part of a credential. What survives
 * is what a support reader can act on — which provider, whether it is
 * enabled, how it is weighted, and whether a credential reference exists at
 * all.
 */
const summarizeGatewayAccount = (
  ledger: SupportRedactionLedger,
  raw: unknown,
  index: number,
): SupportBundleGatewayAccount => {
  const record = isRecord(raw) ? raw : {};
  const hasCredentialReference = Object.keys(record).some(
    (key) => key.endsWith("Secret") && isRecord(record[key]),
  );

  return {
    index,
    provider: gateLabel(ledger, record.provider, GATEWAY_PROVIDERS),
    enabled: gateBoolean(ledger, record.enabled),
    priority: gateInteger(ledger, record.priority, 10_000),
    weight: gateInteger(ledger, record.weight, 10_000),
    modelCount: gateCount(ledger, countArray(record.models)),
    hasCredentialReference,
  };
};

const emptyGatewaySection = (ledger: SupportRedactionLedger): SupportBundleGatewaySection => ({
  configurationPresent: false,
  configurationReadable: false,
  hostProcessRecorded: false,
  routingStrategy: gateLabel(ledger, undefined, GATEWAY_ROUTING_STRATEGIES),
  accountCount: 0,
  enabledAccountCount: 0,
  poolCount: 0,
  routeCount: 0,
  accountHealth: "not-reported-by-host",
  accounts: [],
});

/**
 * Parses the gateway configuration as a FOREIGN document. The server owns the
 * file and it carries provider-specific account variants, so it is inspected
 * key by key and never decoded into a shape this module would then have to
 * trust. Undefined means "present but unreadable", which the section reports
 * rather than hides.
 *
 * A plain function, not an Effect: this is a pure string-to-value parse whose
 * only failure mode is "not JSON".
 */
const parseGatewayConfiguration = (raw: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reads the gateway configuration the SERVER writes into the shared state
 * directory. Deliberately a bounded read of an existing artifact rather than
 * a new RPC: the desktop already owns this directory, and the file's account
 * records carry no credential — only references into the secret store, which
 * is why "does a reference exist" is reportable and the reference name is
 * not.
 *
 * Per-account HEALTH is reported as `not-reported-by-host` because that is
 * the truth: the Rust host keeps per-credential cooldown state in an
 * in-process store its management surface never publishes (see
 * `WorkjetGatewayHealth` in the contracts).
 */
const collectGatewaySection = Effect.fn("desktop.supportBundle.collectGateway")(function* (
  ledger: SupportRedactionLedger,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  fileSystem: FileSystem.FileSystem,
): Effect.fn.Return<SupportBundleGatewaySection> {
  const configurationPath = environment.path.join(environment.stateDir, "provider-gateway.json");
  const pidPath = environment.path.join(environment.stateDir, "provider-gateway-host.pid.json");

  const hostProcessRecorded = yield* fileSystem
    .exists(pidPath)
    .pipe(Effect.orElseSucceed(() => false));
  const raw = yield* fileSystem.readFileString(configurationPath).pipe(Effect.option);

  if (Option.isNone(raw)) {
    return { ...emptyGatewaySection(ledger), hostProcessRecorded };
  }

  const parsed = parseGatewayConfiguration(raw.value);
  if (parsed === undefined) {
    return {
      ...emptyGatewaySection(ledger),
      configurationPresent: true,
      hostProcessRecorded,
    };
  }

  const rawAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  const accounts = rawAccounts
    .slice(0, SUPPORT_BUNDLE_MAX_ACCOUNTS)
    .map((account, index) => summarizeGatewayAccount(ledger, account, index));

  return {
    configurationPresent: true,
    configurationReadable: true,
    hostProcessRecorded,
    routingStrategy: gateLabel(ledger, parsed.routingStrategy, GATEWAY_ROUTING_STRATEGIES),
    accountCount: gateCount(ledger, rawAccounts.length),
    enabledAccountCount: accounts.filter((account) => account.enabled).length,
    poolCount: gateCount(ledger, countArray(parsed.pools)),
    routeCount: gateCount(ledger, countArray(parsed.routes)),
    accountHealth: "not-reported-by-host",
    accounts,
  };
});

const decoder = new TextDecoder();

/**
 * Collects the newest log files, newest lines first-in-file-order, each line
 * projected through {@link gateLogLine}. Only the tail of each file is read,
 * and only files this build actually writes (`.log`, `.ndjson`) are eligible.
 */
const collectLogExcerpts = Effect.fn("desktop.supportBundle.collectLogs")(function* (
  ledger: SupportRedactionLedger,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  fileSystem: FileSystem.FileSystem,
): Effect.fn.Return<{
  readonly excerpts: readonly SupportBundleLogExcerpt[];
  readonly logFileCount: number;
}> {
  const redactionOptions = { homeDirectory: environment.homeDirectory };

  const entries = yield* fileSystem
    .readDirectory(environment.logDir)
    .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
  const candidates = entries.filter((entry) =>
    LOG_FILE_EXTENSIONS.some((extension) => entry.endsWith(extension)),
  );

  const described = yield* Effect.forEach(candidates, (fileName) =>
    fileSystem.stat(environment.path.join(environment.logDir, fileName)).pipe(
      Effect.map((info) => ({
        fileName,
        byteLength: Number(info.size),
        modifiedAtMs: Option.match(info.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        }),
      })),
      Effect.orElseSucceed(() => ({ fileName, byteLength: 0, modifiedAtMs: 0 })),
    ),
  );

  const selected = [...described]
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
    .slice(0, SUPPORT_BUNDLE_MAX_LOG_FILES);

  const excerpts = yield* Effect.forEach(selected, (candidate) =>
    Effect.gen(function* () {
      const base = {
        fileName: gateText(ledger, candidate.fileName, redactionOptions),
        byteLength: gateCount(ledger, candidate.byteLength, Number.MAX_SAFE_INTEGER),
      };

      if (candidate.byteLength > LOG_FILE_MAX_BYTES) {
        return {
          ...base,
          totalLineCount: 0,
          omittedLeadingLineCount: 0,
          omittedReason: SUPPORT_BUNDLE_PLACEHOLDERS.oversized,
          lines: [],
        } satisfies SupportBundleLogExcerpt;
      }

      const bytes = yield* fileSystem
        .readFile(environment.path.join(environment.logDir, candidate.fileName))
        .pipe(Effect.option);
      if (Option.isNone(bytes)) {
        return {
          ...base,
          totalLineCount: 0,
          omittedLeadingLineCount: 0,
          omittedReason: SUPPORT_BUNDLE_PLACEHOLDERS.unavailable,
          lines: [],
        } satisfies SupportBundleLogExcerpt;
      }

      const tail =
        bytes.value.byteLength > LOG_TAIL_MAX_BYTES
          ? bytes.value.subarray(bytes.value.byteLength - LOG_TAIL_MAX_BYTES)
          : bytes.value;
      const allLines = decoder
        .decode(tail)
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
      const retained = allLines.slice(-SUPPORT_BUNDLE_MAX_LOG_LINES);

      return {
        ...base,
        totalLineCount: gateCount(ledger, allLines.length),
        omittedLeadingLineCount: gateCount(ledger, allLines.length - retained.length),
        omittedReason: null,
        lines: retained.map((line) => gateLogLine(ledger, line, redactionOptions)),
      } satisfies SupportBundleLogExcerpt;
    }),
  );

  return { excerpts, logFileCount: candidates.length };
});

export const make = (
  options: { readonly runtimeVersions?: DesktopSupportBundleRuntimeVersions } = {},
) =>
  Effect.gen(function* () {
    const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
    const crashReporting = yield* DesktopCrashReporting.DesktopCrashReporting;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const migration = yield* DesktopUserDataMigration.DesktopUserDataMigration;
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const runtimeVersions = options.runtimeVersions ?? readProcessRuntimeVersions();
    const redactionOptions = { homeDirectory: environment.homeDirectory };

    const build = Effect.gen(function* () {
      const ledger = makeSupportRedactionLedger();
      const generatedAt = yield* DateTime.now;
      const currentSettings = yield* settings.get;
      const commitHash = yield* appIdentity.commitHash;
      const crashState = yield* crashReporting.state;
      const gateway = yield* collectGatewaySection(ledger, environment, fileSystem);
      const logs = yield* collectLogExcerpts(ledger, environment, fileSystem);

      const decision = migration.decision;
      const document = {
        schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
        generatedAtIso: gateText(ledger, DateTime.formatIso(generatedAt), redactionOptions),
        uploadSupported: false,
        app: {
          displayName: gateText(ledger, environment.displayName, redactionOptions),
          stageLabel: gateText(ledger, environment.branding.stageLabel, redactionOptions),
          version: gateText(ledger, environment.appVersion, redactionOptions),
          commitHash: gateText(
            ledger,
            Option.getOrElse(commitHash, () => "unknown"),
            redactionOptions,
          ),
          updateChannel: gateLabel(ledger, currentSettings.updateChannel, UPDATE_CHANNELS),
          isPackaged: gateBoolean(ledger, environment.isPackaged),
          isDevelopment: gateBoolean(ledger, environment.isDevelopment),
        },
        runtime: {
          platform: gateText(ledger, environment.platform, redactionOptions),
          processArch: gateText(ledger, environment.processArch, redactionOptions),
          hostArch: gateText(ledger, environment.runtimeInfo.hostArch, redactionOptions),
          appArch: gateText(ledger, environment.runtimeInfo.appArch, redactionOptions),
          runningUnderArm64Translation: gateBoolean(
            ledger,
            environment.runtimeInfo.runningUnderArm64Translation,
          ),
          electronVersion: gateText(ledger, runtimeVersions.electron, redactionOptions),
          chromeVersion: gateText(ledger, runtimeVersions.chrome, redactionOptions),
          nodeVersion: gateText(ledger, runtimeVersions.node, redactionOptions),
          v8Version: gateText(ledger, runtimeVersions.v8, redactionOptions),
        },
        features: {
          serverExposureMode: gateLabel(
            ledger,
            currentSettings.serverExposureMode,
            SERVER_EXPOSURE_MODES,
          ),
          tailscaleServeEnabled: gateBoolean(ledger, currentSettings.tailscaleServeEnabled),
          wslBackendEnabled: gateBoolean(ledger, currentSettings.wslBackendEnabled),
          wslOnly: gateBoolean(ledger, currentSettings.wslOnly),
          // The distro NAME is user-typed; only its presence is reportable.
          wslDistroConfigured: currentSettings.wslDistro !== null,
          updateChannelConfiguredByUser: gateBoolean(
            ledger,
            currentSettings.updateChannelConfiguredByUser,
          ),
          linuxPasswordStore: gateText(
            ledger,
            currentSettings.linuxPasswordStore,
            redactionOptions,
          ),
          crashReporterStarted: gateBoolean(ledger, crashState.started),
          crashReportUploadToServer: false as const,
        },
        providerGateway: gateway,
        migration: {
          decision: gateLabel(ledger, decision._tag, MIGRATION_DECISIONS),
          outcome:
            decision._tag === "already-migrated"
              ? gateLabel(ledger, decision.outcome, MIGRATION_OUTCOMES)
              : gateLabel(ledger, undefined, MIGRATION_OUTCOMES),
          offerPending: Option.isSome(migration.offer),
          // The count of legacy directory NAMES this build knows how to
          // import. The paths themselves are never named.
          legacyCandidateCount: gateCount(ledger, environment.legacyUserDataDirNames.length),
        },
        logs: logs.excerpts,
        counters: {
          logFileCount: logs.logFileCount,
          collectedLogFileCount: logs.excerpts.length,
          collectedLogLineCount: logs.excerpts.reduce(
            (total, excerpt) => total + excerpt.lines.length,
            0,
          ),
          redactedFieldCount: ledger.redactedFieldCount,
          omittedFieldCount: ledger.omittedFieldCount,
        },
      } satisfies SupportBundleDocument;

      return { document, ledger } as const;
    });

    /**
     * Encodes within the size ceiling. Log excerpts are dropped oldest-first
     * — they are last in the array because the collection sorts newest-first
     * — and every dropped excerpt keeps its header with an explicit
     * `omittedReason`, so the reader sees the gap.
     */
    const encodeWithinBudget = (
      document: SupportBundleDocument,
    ): { readonly serialized: string; readonly document: SupportBundleDocument } => {
      const logs: SupportBundleLogExcerpt[] = [...document.logs];
      const withCurrentLogs = (): SupportBundleDocument => ({
        ...document,
        logs,
        counters: {
          ...document.counters,
          collectedLogLineCount: logs.reduce((total, entry) => total + entry.lines.length, 0),
        },
      });

      // The bundle is a human-readable artifact, written with JSON indentation
      // no Schema codec produces; every value in it already passed the gate.
      const encode = (value: SupportBundleDocument) => JSON.stringify(value, null, 2);

      let current = withCurrentLogs();
      let serialized = encode(current);
      let dropIndex = logs.length - 1;

      while (Buffer.byteLength(serialized, "utf8") > SUPPORT_BUNDLE_MAX_BYTES && dropIndex >= 0) {
        const excerpt = logs[dropIndex];
        if (excerpt !== undefined) {
          logs[dropIndex] = {
            ...excerpt,
            omittedReason: SUPPORT_BUNDLE_PLACEHOLDERS.oversized,
            lines: [],
          };
        }
        current = withCurrentLogs();
        serialized = encode(current);
        dropIndex -= 1;
      }

      return { serialized, document: current };
    };

    const create = Effect.gen(function* () {
      const built = yield* build;
      const { serialized, document } = encodeWithinBudget(built.document);
      const directory = environment.path.join(environment.stateDir, SUPPORT_BUNDLE_DIRECTORY_NAME);
      const fileName = `ctox-support-bundle-${document.generatedAtIso.replace(/[^0-9A-Za-z]/gu, "")}.json`;
      const filePath = environment.path.join(directory, fileName);

      yield* fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.catch((cause) => new DesktopSupportBundleWriteError({ filePath, cause })));
      yield* fileSystem
        .writeFileString(filePath, `${serialized}\n`)
        .pipe(Effect.catch((cause) => new DesktopSupportBundleWriteError({ filePath, cause })));

      const byteLength = Buffer.byteLength(serialized, "utf8") + 1;
      yield* logBundleInfo("support bundle written", {
        byteLength,
        redactedFieldCount: built.ledger.redactedFieldCount,
        omittedFieldCount: built.ledger.omittedFieldCount,
      });

      return {
        filePath,
        byteLength,
        fieldCount:
          built.ledger.cleanFieldCount +
          built.ledger.redactedFieldCount +
          built.ledger.omittedFieldCount,
        redactedFieldCount: built.ledger.redactedFieldCount,
        omittedFieldCount: built.ledger.omittedFieldCount,
        generatedAtIso: document.generatedAtIso,
      } satisfies DesktopSupportBundleResult;
    }).pipe(Effect.withSpan("desktop.supportBundle.create"));

    return DesktopSupportBundle.of({
      build: build.pipe(Effect.map((built) => built.document)),
      create,
    });
  });

export const layer = Layer.effect(DesktopSupportBundle, make());
