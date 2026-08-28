// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The redacted desktop support bundle and the crash-report metadata that
 * shares its redaction gate.
 *
 * This module implements `docs/workjet-plan.md` Wave 7: "Port support-bundle
 * redaction and crash-report metadata without secrets."
 *
 * The discipline is the same one {@link ./workjetMailboxAudit.ts} applies to
 * relay audit events, applied here to a file the USER hands to a stranger:
 *
 * - Every field is a closed literal, a bounded integer, a boolean, or a
 *   bounded string that has passed the redaction gate. There is no free-form
 *   `Record<string, unknown>`, no `Schema.Unknown`, and no payload field, so a
 *   would-be secret has no field to travel in.
 * - A value the gate cannot make safe is REPLACED BY A NAMED PLACEHOLDER
 *   ({@link SupportBundleRedactionPlaceholder}), never silently truncated and
 *   never quietly dropped: the reader can always see that something was
 *   withheld and why.
 * - The bundle is written to disk and its exact path is reported back. It is
 *   never uploaded. {@link SUPPORT_BUNDLE_UPLOAD_SUPPORTED} is a hard `false`:
 *   the repository has no consent mechanism, so local-only is the only honest
 *   default, and the same flag governs the crash reporter's
 *   `uploadToServer`.
 *
 * {@link SUPPORT_BUNDLE_FIELD_INVENTORY} is the declared shape of the
 * document. It is not documentation — the desktop's builder test walks the
 * document it actually produced and fails when a path is present that this
 * list does not declare. Adding a field to the bundle therefore requires
 * adding it here, which is the "no accidental leak" guarantee.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/** Current schema version of every contract in this module. */
export const SUPPORT_BUNDLE_SCHEMA_VERSION = 1;

/**
 * Hard ceiling for the written document. The builder drops log excerpts (in
 * order, oldest file first) until the encoded document fits, and records what
 * it dropped in `logs[].omittedReason`; it never writes a larger file.
 */
export const SUPPORT_BUNDLE_MAX_BYTES = 1_048_576;

/** Longest single redacted string any field may carry. */
export const SUPPORT_BUNDLE_MAX_FIELD_LENGTH = 512;

/** Longest raw input the gate will even attempt to redact. */
export const SUPPORT_BUNDLE_MAX_RAW_LENGTH = 8_192;

/** Log lines retained per collected file (the newest ones). */
export const SUPPORT_BUNDLE_MAX_LOG_LINES = 120;

/** Log files collected at most, newest first. */
export const SUPPORT_BUNDLE_MAX_LOG_FILES = 6;

/** Provider-gateway accounts summarized at most. */
export const SUPPORT_BUNDLE_MAX_ACCOUNTS = 64;

/**
 * Whether this build can upload a support bundle or a crash report anywhere.
 * It cannot, and the value is a literal `false` rather than a setting: there
 * is no consent surface in this repository, and shipping an upload path
 * without one would be the exact failure this wave exists to prevent.
 */
export const SUPPORT_BUNDLE_UPLOAD_SUPPORTED = false as const;

/**
 * Every reason a value can fail to reach the bundle intact. `redacted:*`
 * means a recognized secret shape was substituted inside an otherwise
 * readable string; `omitted:*` means the whole value was refused.
 */
export const SupportBundleRedactionPlaceholder = Schema.Literals([
  "[redacted:token]",
  "[redacted:secret]",
  "[redacted:authorization]",
  "[redacted:email]",
  "[redacted:path]",
  "[redacted:url]",
  "[omitted:oversized]",
  "[omitted:unredactable]",
  "[omitted:unavailable]",
]);
export type SupportBundleRedactionPlaceholder = typeof SupportBundleRedactionPlaceholder.Type;

/** The literal placeholder strings, for the gate and its canary tests. */
export const SUPPORT_BUNDLE_PLACEHOLDERS = {
  token: "[redacted:token]",
  secret: "[redacted:secret]",
  authorization: "[redacted:authorization]",
  email: "[redacted:email]",
  path: "[redacted:path]",
  url: "[redacted:url]",
  oversized: "[omitted:oversized]",
  unredactable: "[omitted:unredactable]",
  unavailable: "[omitted:unavailable]",
} as const satisfies Record<string, SupportBundleRedactionPlaceholder>;

/**
 * A string that has been through the gate. Bounded, single-line, and free of
 * control characters — the gate guarantees all three, and the schema refuses
 * anything that is not.
 */
export const SupportBundleText = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(SUPPORT_BUNDLE_MAX_FIELD_LENGTH)),
  // \P{Cc} rather than an explicit range: the point is that no control
  // character may smuggle a newline into a bundle field.
  Schema.check(Schema.isPattern(/^\P{Cc}*$/u)),
);
export type SupportBundleText = typeof SupportBundleText.Type;

/** Build identity. Nothing here is user-supplied. */
export const SupportBundleAppSection = Schema.Struct({
  displayName: SupportBundleText,
  stageLabel: SupportBundleText,
  version: SupportBundleText,
  commitHash: SupportBundleText,
  updateChannel: SupportBundleText,
  isPackaged: Schema.Boolean,
  isDevelopment: Schema.Boolean,
});
export type SupportBundleAppSection = typeof SupportBundleAppSection.Type;

/** Host and runtime versions. */
export const SupportBundleRuntimeSection = Schema.Struct({
  platform: SupportBundleText,
  processArch: SupportBundleText,
  hostArch: SupportBundleText,
  appArch: SupportBundleText,
  runningUnderArm64Translation: Schema.Boolean,
  electronVersion: SupportBundleText,
  chromeVersion: SupportBundleText,
  nodeVersion: SupportBundleText,
  v8Version: SupportBundleText,
});
export type SupportBundleRuntimeSection = typeof SupportBundleRuntimeSection.Type;

/**
 * Capability / feature availability. Booleans and closed labels only — the
 * WSL distro name, for instance, is reduced to "is one configured", because
 * a distro name is user-typed text.
 */
export const SupportBundleFeatureSection = Schema.Struct({
  serverExposureMode: SupportBundleText,
  tailscaleServeEnabled: Schema.Boolean,
  wslBackendEnabled: Schema.Boolean,
  wslOnly: Schema.Boolean,
  wslDistroConfigured: Schema.Boolean,
  updateChannelConfiguredByUser: Schema.Boolean,
  linuxPasswordStore: SupportBundleText,
  crashReporterStarted: Schema.Boolean,
  crashReportUploadToServer: Schema.Literal(false),
});
export type SupportBundleFeatureSection = typeof SupportBundleFeatureSection.Type;

/**
 * One provider-gateway account, reduced to routing facts.
 *
 * There is deliberately no id, no label, and no credential suffix. The label
 * is user-typed free text and the suffix is part of a credential; the id adds
 * nothing a support reader can act on once the label is gone. Accounts are
 * identified by their ordinal position in the gateway configuration.
 */
export const SupportBundleGatewayAccount = Schema.Struct({
  index: NonNegativeInt,
  provider: SupportBundleText,
  enabled: Schema.Boolean,
  priority: Schema.Int,
  weight: Schema.Int,
  modelCount: NonNegativeInt,
  hasCredentialReference: Schema.Boolean,
});
export type SupportBundleGatewayAccount = typeof SupportBundleGatewayAccount.Type;

/**
 * Provider-gateway status as the DESKTOP can observe it: the on-disk
 * configuration the server writes plus the host pid record.
 *
 * `accountHealth` mirrors {@link ./workjet.ts}'s `WorkjetGatewayHealth`: the
 * Rust host keeps per-credential cooldown state in an in-process store its
 * management surface never publishes, so the honest value is
 * `not-reported-by-host` rather than an invented one.
 */
export const SupportBundleGatewaySection = Schema.Struct({
  configurationPresent: Schema.Boolean,
  configurationReadable: Schema.Boolean,
  hostProcessRecorded: Schema.Boolean,
  routingStrategy: SupportBundleText,
  accountCount: NonNegativeInt,
  enabledAccountCount: NonNegativeInt,
  poolCount: NonNegativeInt,
  routeCount: NonNegativeInt,
  accountHealth: Schema.Literal("not-reported-by-host"),
  accounts: Schema.Array(SupportBundleGatewayAccount).pipe(
    Schema.check(Schema.isMaxLength(SUPPORT_BUNDLE_MAX_ACCOUNTS)),
  ),
});
export type SupportBundleGatewaySection = typeof SupportBundleGatewaySection.Type;

/** User-data migration state. Directories are counted, never named. */
export const SupportBundleMigrationSection = Schema.Struct({
  decision: SupportBundleText,
  outcome: SupportBundleText,
  offerPending: Schema.Boolean,
  legacyCandidateCount: NonNegativeInt,
});
export type SupportBundleMigrationSection = typeof SupportBundleMigrationSection.Type;

/**
 * A bounded excerpt of one log file. `lines` are the newest
 * {@link SUPPORT_BUNDLE_MAX_LOG_LINES} lines, each passed through the gate
 * individually so one poisoned line cannot cost the whole file.
 */
export const SupportBundleLogExcerpt = Schema.Struct({
  fileName: SupportBundleText,
  byteLength: NonNegativeInt,
  totalLineCount: NonNegativeInt,
  omittedLeadingLineCount: NonNegativeInt,
  omittedReason: Schema.NullOr(SupportBundleRedactionPlaceholder),
  lines: Schema.Array(SupportBundleText).pipe(
    Schema.check(Schema.isMaxLength(SUPPORT_BUNDLE_MAX_LOG_LINES)),
  ),
});
export type SupportBundleLogExcerpt = typeof SupportBundleLogExcerpt.Type;

/** Counters describing the collection itself, so the reader can spot gaps. */
export const SupportBundleCounterSection = Schema.Struct({
  logFileCount: NonNegativeInt,
  collectedLogFileCount: NonNegativeInt,
  collectedLogLineCount: NonNegativeInt,
  redactedFieldCount: NonNegativeInt,
  omittedFieldCount: NonNegativeInt,
});
export type SupportBundleCounterSection = typeof SupportBundleCounterSection.Type;

export const SupportBundleDocument = Schema.Struct({
  schemaVersion: Schema.Literal(SUPPORT_BUNDLE_SCHEMA_VERSION),
  generatedAtIso: SupportBundleText,
  uploadSupported: Schema.Literal(false),
  app: SupportBundleAppSection,
  runtime: SupportBundleRuntimeSection,
  features: SupportBundleFeatureSection,
  providerGateway: SupportBundleGatewaySection,
  migration: SupportBundleMigrationSection,
  logs: Schema.Array(SupportBundleLogExcerpt).pipe(
    Schema.check(Schema.isMaxLength(SUPPORT_BUNDLE_MAX_LOG_FILES)),
  ),
  counters: SupportBundleCounterSection,
});
export type SupportBundleDocument = typeof SupportBundleDocument.Type;

/**
 * Crash-report metadata. Electron's `crashReporter` `extra` map is
 * string-to-string, and this is the whole of it: build identity, nothing
 * else. It is produced by the same gate as the bundle.
 */
export const SupportCrashMetadata = Schema.Struct({
  appVersion: SupportBundleText,
  commitHash: SupportBundleText,
  platform: SupportBundleText,
  arch: SupportBundleText,
  channel: SupportBundleText,
  packaged: SupportBundleText,
});
export type SupportCrashMetadata = typeof SupportCrashMetadata.Type;

/** The keys the crash reporter is allowed to attach. Nothing else may be set. */
export const SUPPORT_CRASH_METADATA_KEYS = [
  "appVersion",
  "commitHash",
  "platform",
  "arch",
  "channel",
  "packaged",
] as const satisfies ReadonlyArray<keyof SupportCrashMetadata>;

/**
 * What the desktop hands back after writing a bundle. `filePath` is the exact
 * location, reported so the user can inspect the file before sharing it.
 */
export const DesktopSupportBundleResult = Schema.Struct({
  filePath: Schema.String,
  byteLength: NonNegativeInt,
  fieldCount: NonNegativeInt,
  redactedFieldCount: NonNegativeInt,
  omittedFieldCount: NonNegativeInt,
  generatedAtIso: Schema.String,
});
export type DesktopSupportBundleResult = typeof DesktopSupportBundleResult.Type;

/**
 * Every leaf path the bundle document may contain, in dotted form with `[]`
 * for array elements.
 *
 * The desktop's builder test flattens the document it actually produced and
 * asserts the resulting path set equals this list. An undeclared field fails
 * the test; a declared field the builder stopped emitting fails it too.
 */
export const SUPPORT_BUNDLE_FIELD_INVENTORY: readonly string[] = [
  "schemaVersion",
  "generatedAtIso",
  "uploadSupported",
  "app.displayName",
  "app.stageLabel",
  "app.version",
  "app.commitHash",
  "app.updateChannel",
  "app.isPackaged",
  "app.isDevelopment",
  "runtime.platform",
  "runtime.processArch",
  "runtime.hostArch",
  "runtime.appArch",
  "runtime.runningUnderArm64Translation",
  "runtime.electronVersion",
  "runtime.chromeVersion",
  "runtime.nodeVersion",
  "runtime.v8Version",
  "features.serverExposureMode",
  "features.tailscaleServeEnabled",
  "features.wslBackendEnabled",
  "features.wslOnly",
  "features.wslDistroConfigured",
  "features.updateChannelConfiguredByUser",
  "features.linuxPasswordStore",
  "features.crashReporterStarted",
  "features.crashReportUploadToServer",
  "providerGateway.configurationPresent",
  "providerGateway.configurationReadable",
  "providerGateway.hostProcessRecorded",
  "providerGateway.routingStrategy",
  "providerGateway.accountCount",
  "providerGateway.enabledAccountCount",
  "providerGateway.poolCount",
  "providerGateway.routeCount",
  "providerGateway.accountHealth",
  "providerGateway.accounts[].index",
  "providerGateway.accounts[].provider",
  "providerGateway.accounts[].enabled",
  "providerGateway.accounts[].priority",
  "providerGateway.accounts[].weight",
  "providerGateway.accounts[].modelCount",
  "providerGateway.accounts[].hasCredentialReference",
  "migration.decision",
  "migration.outcome",
  "migration.offerPending",
  "migration.legacyCandidateCount",
  "logs[].fileName",
  "logs[].byteLength",
  "logs[].totalLineCount",
  "logs[].omittedLeadingLineCount",
  "logs[].omittedReason",
  "logs[].lines[]",
  "counters.logFileCount",
  "counters.collectedLogFileCount",
  "counters.collectedLogLineCount",
  "counters.redactedFieldCount",
  "counters.omittedFieldCount",
];

/**
 * Flattens a decoded bundle document (or any JSON value) into the dotted leaf
 * paths {@link SUPPORT_BUNDLE_FIELD_INVENTORY} declares. Array elements
 * collapse onto a single `[]` segment, so the path set does not grow with the
 * data.
 */
export function flattenSupportBundlePaths(value: unknown, prefix = ""): ReadonlySet<string> {
  const paths = new Set<string>();

  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      const elementPath = `${path}[]`;
      if (node.length === 0) {
        paths.add(elementPath);
        return;
      }
      for (const element of node) visit(element, elementPath);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        visit(child, path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    paths.add(path);
  };

  visit(value, prefix);
  return paths;
}
