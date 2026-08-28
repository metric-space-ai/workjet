// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * ADDITIVE. Wire contracts for the ONE-SHOT import of the legacy Swift Workjet
 * configuration into `settings.workjet`.
 *
 * Nothing here changes an existing schema. It is a new file for a new concern,
 * exported alongside the other Workjet contracts.
 *
 * ## Why the surface looks like this
 *
 * The server already owns the whole decision (`apps/server/src/workjet/legacy`):
 * it reads the legacy document that lives in the home directory OF THE MACHINE
 * THE SERVER RUNS ON, maps it, records a durable marker, and refuses to run
 * twice. These contracts do not re-decide anything — they EXPOSE that decision
 * and carry the operator's answer back.
 *
 * Three properties of that decision shape every schema below:
 *
 * 1. THREE REFERENCES CANNOT BE CARRIED OVER. A legacy computer names an
 *    SSH/Tailscale host, not a Code environment; a legacy provider names a Swift
 *    UUID and a CLIProxy account hash, neither of which is a Workjet gateway
 *    account id; a legacy provider POOL has no destination at all, because
 *    `llmRoutes` are single accounts. Each is an operator BINDING, and a record
 *    without one is reported as PENDING and NOT imported — never bound to a
 *    plausible-looking substitute. {@link WorkjetLegacyImportPending} therefore
 *    carries bounded RECOGNITION EVIDENCE (host, account label, credential
 *    suffix, model ids) and no transport or credential material.
 * 2. A POOL BINDING LOSES FAILOVER. Binding a legacy pool to one gateway account
 *    collapses an ordered set of accounts into a single route. That is a real
 *    loss of behavior, so {@link WorkjetLegacyImportPendingPool} states it in
 *    the contract (`failoverLoss`) instead of leaving it to a UI footnote.
 * 3. A DECISION IS TERMINAL. `imported` and `declined` are both recorded, so the
 *    offer is made at most once. An UNREADABLE document is not a decision: it
 *    records nothing and is reported as a defect to look at.
 *
 * The inputs carry no `environmentId` and no path: the server answers for its
 * own machine and its own settings document, and a renderer cannot express the
 * ambient-authority mistake.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { WorkjetGatewayAccountId } from "./workjet.ts";

/** Current schema version of every contract in this module. */
export const WORKJET_LEGACY_IMPORT_SCHEMA_VERSION = 1;

const LegacyImportSchemaVersion = Schema.Literal(WORKJET_LEGACY_IMPORT_SCHEMA_VERSION);

/**
 * Bounds. The legacy document is operator-authored and small (the author's real
 * configuration is 3 computers, 7 providers, 4 pools, 12 workers), so these are
 * generous ceilings that still make an unbounded read impossible.
 */
export const WORKJET_LEGACY_IMPORT_MAX_PENDING = 256;
export const WORKJET_LEGACY_IMPORT_MAX_DROPS = 512;
export const WORKJET_LEGACY_IMPORT_MAX_BINDINGS = 256;
export const WORKJET_LEGACY_IMPORT_MAX_EVIDENCE_ITEMS = 64;

const NoUnsafeControlCharacters = Schema.makeFilter((input: string) => {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0d) continue;
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return "Value must not contain ASCII control characters.";
    }
  }
  return true;
});

const boundedText = (maximum: number) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(maximum), NoUnsafeControlCharacters);

/**
 * A legacy record id, exactly as the Swift document spells it (a UUID for a
 * computer or provider, a free-text name for a pool). It is an opaque token this
 * side never interprets: it only travels back so the server can match the
 * operator's binding to the record it came from.
 */
export const WorkjetLegacyRecordId = boundedText(200);
export type WorkjetLegacyRecordId = typeof WorkjetLegacyRecordId.Type;

/** Absolute filesystem path, for display. Never a path the caller may choose. */
const LegacyPath = boundedText(1024);

/** A mapping reason, as the server's mapping table authored it. */
const DecisionReason = boundedText(1024);

// ===============================
// Pending records: what needs an operator binding
// ===============================

/** How the Swift app reached a machine. Presentation only; never imported. */
export const WorkjetLegacyTransport = Schema.Literals(["Lokal", "Tailscale", "SSH"]);
export type WorkjetLegacyTransport = typeof WorkjetLegacyTransport.Type;

/**
 * A legacy computer with no bound Code environment.
 *
 * `host` is shown so the operator can RECOGNIZE the machine, and is explicitly
 * not imported: Workjet environments remain the transport authority.
 */
export const WorkjetLegacyImportPendingComputer = Schema.Struct({
  kind: Schema.Literal("computer-environment"),
  computerId: WorkjetLegacyRecordId,
  computerName: boundedText(200),
  transport: WorkjetLegacyTransport,
  host: Schema.NullOr(boundedText(400)),
});
export type WorkjetLegacyImportPendingComputer = typeof WorkjetLegacyImportPendingComputer.Type;

/**
 * A legacy provider with no bound gateway account.
 *
 * `externalCredentialId` is the CLIProxy ACCOUNT HASH the Swift app recorded. It
 * is not a credential and cannot authenticate anything; it is carried solely so
 * the operator can tell two accounts of the same provider apart.
 */
export const WorkjetLegacyImportPendingProvider = Schema.Struct({
  kind: Schema.Literal("provider-account"),
  providerId: WorkjetLegacyRecordId,
  providerName: boundedText(200),
  modelProvider: Schema.NullOr(boundedText(120)),
  accountLabel: Schema.NullOr(boundedText(200)),
  externalCredentialId: Schema.NullOr(boundedText(200)),
  modelIds: Schema.Array(boundedText(200)).pipe(
    Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_EVIDENCE_ITEMS)),
  ),
});
export type WorkjetLegacyImportPendingProvider = typeof WorkjetLegacyImportPendingProvider.Type;

/**
 * A legacy provider POOL with no bound gateway account.
 *
 * `failoverLoss` is always true and is part of the contract rather than a UI
 * string: a pool is an ORDERED SET of accounts and the destination route is ONE
 * account, so binding it narrows the pool permanently. The operator must be able
 * to see that at the control, before accepting.
 */
export const WorkjetLegacyImportPendingPool = Schema.Struct({
  kind: Schema.Literal("provider-pool-account"),
  pool: WorkjetLegacyRecordId,
  workerIds: Schema.Array(WorkjetLegacyRecordId).pipe(
    Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_EVIDENCE_ITEMS)),
  ),
  /** Always true: the destination has no pool, so failover cannot survive. */
  failoverLoss: Schema.Literal(true),
});
export type WorkjetLegacyImportPendingPool = typeof WorkjetLegacyImportPendingPool.Type;

/**
 * A worker that cannot be imported YET. This record is a CONSEQUENCE, never a
 * control: a worker is blocked by its computer, by its route, or by being
 * invalid, and it starts importing as soon as the record it depends on is bound.
 */
export const WorkjetLegacyImportPendingWorker = Schema.Struct({
  kind: Schema.Literal("worker"),
  workerId: WorkjetLegacyRecordId,
  workerName: boundedText(200),
  blockedBy: Schema.Literals(["computer", "llm-route", "invalid-record"]),
  detail: DecisionReason,
});
export type WorkjetLegacyImportPendingWorker = typeof WorkjetLegacyImportPendingWorker.Type;

export const WorkjetLegacyImportPending = Schema.Union([
  WorkjetLegacyImportPendingComputer,
  WorkjetLegacyImportPendingProvider,
  WorkjetLegacyImportPendingPool,
  WorkjetLegacyImportPendingWorker,
]);
export type WorkjetLegacyImportPending = typeof WorkjetLegacyImportPending.Type;

/** The three pending kinds an operator can actually answer. */
export const WORKJET_LEGACY_IMPORT_BINDABLE_KINDS = [
  "computer-environment",
  "provider-account",
  "provider-pool-account",
] as const;

// ===============================
// Drops: what will not come across
// ===============================

/**
 * One legacy field that will NOT reach the destination.
 *
 * `dropped` is a field the mapping understands and deliberately refuses (a
 * transport detail, an observed status, a Swift-internal flag).
 * `unmapped-field` is a field present in the document that the reader does not
 * model at all — reported so a field a newer Swift build added cannot disappear
 * unnoticed.
 */
export const WorkjetLegacyImportDropKind = Schema.Literals(["dropped", "unmapped-field"]);
export type WorkjetLegacyImportDropKind = typeof WorkjetLegacyImportDropKind.Type;

export const WorkjetLegacyImportDrop = Schema.Struct({
  kind: WorkjetLegacyImportDropKind,
  /** Legacy field path, exactly as the server's mapping table names it. */
  source: boundedText(400),
  reason: DecisionReason,
});
export type WorkjetLegacyImportDrop = typeof WorkjetLegacyImportDrop.Type;

// ===============================
// Bindable targets the SERVER can verify
// ===============================

/**
 * A Code environment this SERVER can actually name.
 *
 * The server is one environment and holds no registry of the others, so exactly
 * two things are verifiable here: its OWN environment id, and any environment id
 * the current `settings.workjet` already references because an operator chose it
 * earlier through the ordinary Computers surface. Anything else is refused with
 * {@link WorkjetLegacyImportError} `unknown-environment` rather than stored as a
 * reference that can never resolve.
 */
export const WorkjetLegacyImportBindableEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  /** True for the environment this server itself is. */
  isSelf: Schema.Boolean,
  /** True when the current configuration already references it. */
  referencedByConfiguration: Schema.Boolean,
});
export type WorkjetLegacyImportBindableEnvironment =
  typeof WorkjetLegacyImportBindableEnvironment.Type;

/**
 * A provider-gateway account, as the environment's own gateway catalog reports
 * it. Recognition data only: label, provider, and the masked credential suffix
 * the catalog already publishes.
 */
export const WorkjetLegacyImportBindableAccount = Schema.Struct({
  accountId: WorkjetGatewayAccountId,
  label: boundedText(200),
  provider: boundedText(64),
  credentialSuffix: Schema.NullOr(boundedText(8)),
});
export type WorkjetLegacyImportBindableAccount = typeof WorkjetLegacyImportBindableAccount.Type;

export const WorkjetLegacyImportBindableTargets = Schema.Struct({
  environments: Schema.Array(WorkjetLegacyImportBindableEnvironment).pipe(
    Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_BINDINGS)),
  ),
  gatewayAccounts: Schema.Array(WorkjetLegacyImportBindableAccount).pipe(
    Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_BINDINGS)),
  ),
  /**
   * False when the gateway catalog could not be read at all. The panel must then
   * say so instead of presenting an empty account list as "no accounts exist".
   */
  gatewayCatalogAvailable: Schema.Boolean,
});
export type WorkjetLegacyImportBindableTargets = typeof WorkjetLegacyImportBindableTargets.Type;

// ===============================
// The offer summary
// ===============================

/**
 * The honest FLOOR: what the mapping produces with NO bindings at all, plus the
 * totals it was computed from. `computersImported` is therefore normally 0 —
 * that is the point. The counts after a real import come back on the decide
 * result, computed from the operator's actual bindings.
 */
export const WorkjetLegacyImportSummary = Schema.Struct({
  computersImported: NonNegativeInt,
  computersTotal: NonNegativeInt,
  llmRoutesImported: NonNegativeInt,
  workersImported: NonNegativeInt,
  workersTotal: NonNegativeInt,
  pendingTotal: NonNegativeInt,
  dropTotal: NonNegativeInt,
});
export type WorkjetLegacyImportSummary = typeof WorkjetLegacyImportSummary.Type;

/**
 * Why a legacy document could not be read. Mirrors the reader's own reasons; the
 * import writes NO marker for any of them, because an unreadable document is a
 * defect to look at, not a decision the operator made.
 */
export const WorkjetLegacyImportUnreadableReason = Schema.Literals([
  "not-json",
  "not-an-object",
  "missing-version",
  "unsupported-version",
  "invalid-type",
  "invalid-enum",
]);
export type WorkjetLegacyImportUnreadableReason = typeof WorkjetLegacyImportUnreadableReason.Type;

export const WorkjetLegacyImportFailure = Schema.Struct({
  reason: WorkjetLegacyImportUnreadableReason,
  /** Path inside the legacy document, when the reader could locate one. */
  path: Schema.NullOr(boundedText(400)),
  detail: DecisionReason,
});
export type WorkjetLegacyImportFailure = typeof WorkjetLegacyImportFailure.Type;

// ===============================
// Inspect
// ===============================

export const WorkjetLegacyImportInspectInput = Schema.Struct({});
export type WorkjetLegacyImportInspectInput = typeof WorkjetLegacyImportInspectInput.Type;

const InspectionBase = {
  schemaVersion: LegacyImportSchemaVersion,
} as const;

/**
 * Everything the operator needs to decide, in one read:
 *
 * - `nothing-to-import` — this machine never ran the Swift app.
 * - `already-decided` — a marker records a terminal outcome, with its date.
 * - `unreadable` — the document exists but failed closed. No marker was written.
 * - `offer` — the one-time offer: the honest floor, every pending record with
 *   the evidence needed to choose a binding, every drop, and the targets the
 *   server will accept a binding against.
 */
export const WorkjetLegacyImportInspection = Schema.Union([
  Schema.Struct({
    ...InspectionBase,
    state: Schema.Literal("nothing-to-import"),
  }),
  Schema.Struct({
    ...InspectionBase,
    state: Schema.Literal("already-decided"),
    outcome: Schema.Literals(["imported", "declined"]),
    decidedAt: Schema.NullOr(IsoDateTime.check(Schema.isMaxLength(64))),
    legacyPath: Schema.NullOr(LegacyPath),
    /** Counts the marker recorded when the import ran; zeroes for a decline. */
    importedComputers: NonNegativeInt,
    importedLlmRoutes: NonNegativeInt,
    importedWorkerProfiles: NonNegativeInt,
    /** Records that still needed a binding when the import ran. */
    pendingAtImport: NonNegativeInt,
  }),
  Schema.Struct({
    ...InspectionBase,
    state: Schema.Literal("unreadable"),
    legacyPath: LegacyPath,
    /**
     * The reader's own refusal, or `null` when the document could not be READ at
     * all — no permission, or it vanished between the probe and the read — so
     * there is nothing for the reader to have failed on. Either way no marker is
     * written: an unreadable document is a defect to look at, not a decision.
     */
    failure: Schema.NullOr(WorkjetLegacyImportFailure),
  }),
  Schema.Struct({
    ...InspectionBase,
    state: Schema.Literal("offer"),
    legacyPath: LegacyPath,
    /** Where the imported configuration would land. */
    settingsPath: LegacyPath,
    summary: WorkjetLegacyImportSummary,
    pending: Schema.Array(WorkjetLegacyImportPending).pipe(
      Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_PENDING)),
    ),
    /** True when the pending list was cut at the bound. */
    pendingTruncated: Schema.Boolean,
    drops: Schema.Array(WorkjetLegacyImportDrop).pipe(
      Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_DROPS)),
    ),
    dropsTruncated: Schema.Boolean,
    bindable: WorkjetLegacyImportBindableTargets,
  }),
]);
export type WorkjetLegacyImportInspection = typeof WorkjetLegacyImportInspection.Type;

// ===============================
// Decide
// ===============================

export const WorkjetLegacyImportComputerBinding = Schema.Struct({
  computerId: WorkjetLegacyRecordId,
  environmentId: EnvironmentId,
});
export type WorkjetLegacyImportComputerBinding = typeof WorkjetLegacyImportComputerBinding.Type;

export const WorkjetLegacyImportProviderBinding = Schema.Struct({
  providerId: WorkjetLegacyRecordId,
  gatewayAccountId: WorkjetGatewayAccountId,
});
export type WorkjetLegacyImportProviderBinding = typeof WorkjetLegacyImportProviderBinding.Type;

/**
 * One pool bound to ONE gateway account. `acknowledgeFailoverLoss` is required
 * to be true: the narrowing is irreversible for the imported configuration, so
 * the acknowledgement travels with the binding instead of being a UI checkbox
 * the server never sees.
 */
export const WorkjetLegacyImportPoolBinding = Schema.Struct({
  pool: WorkjetLegacyRecordId,
  gatewayAccountId: WorkjetGatewayAccountId,
  acknowledgeFailoverLoss: Schema.Literal(true),
});
export type WorkjetLegacyImportPoolBinding = typeof WorkjetLegacyImportPoolBinding.Type;

const boundedIds = Schema.Array(WorkjetLegacyRecordId).pipe(
  Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_BINDINGS)),
);

/**
 * The operator's answer to every bindable pending record.
 *
 * A record is either BOUND or explicitly SKIPPED. There is no third state: an
 * accept that leaves a pending record unanswered is refused with
 * `unresolved-pending`, so "I did not notice that one" can never silently become
 * "do not import it". A skipped record is not imported, and neither is anything
 * that depends on it.
 */
export const WorkjetLegacyImportBindings = Schema.Struct({
  computers: Schema.Array(WorkjetLegacyImportComputerBinding).pipe(
    Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_BINDINGS)),
  ),
  providers: Schema.Array(WorkjetLegacyImportProviderBinding).pipe(
    Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_BINDINGS)),
  ),
  pools: Schema.Array(WorkjetLegacyImportPoolBinding).pipe(
    Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_BINDINGS)),
  ),
  skippedComputerIds: boundedIds,
  skippedProviderIds: boundedIds,
  skippedPools: boundedIds,
});
export type WorkjetLegacyImportBindings = typeof WorkjetLegacyImportBindings.Type;

export const EMPTY_WORKJET_LEGACY_IMPORT_BINDINGS: WorkjetLegacyImportBindings = {
  computers: [],
  providers: [],
  pools: [],
  skippedComputerIds: [],
  skippedProviderIds: [],
  skippedPools: [],
};

/**
 * Accept with bindings, or decline. Decline carries no bindings by
 * construction — refusing an offer is not a configuration edit.
 */
export const WorkjetLegacyImportDecideInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("accept"),
    bindings: WorkjetLegacyImportBindings,
  }),
  Schema.Struct({
    action: Schema.Literal("decline"),
  }),
]);
export type WorkjetLegacyImportDecideInput = typeof WorkjetLegacyImportDecideInput.Type;

const DecisionResultBase = {
  schemaVersion: LegacyImportSchemaVersion,
} as const;

/**
 * What the server did. Every branch is an honest outcome of the runner, not a
 * transport failure — a refused BINDING is the error channel instead.
 */
export const WorkjetLegacyImportDecisionResult = Schema.Union([
  Schema.Struct({
    ...DecisionResultBase,
    outcome: Schema.Literal("imported"),
    legacyPath: LegacyPath,
    importedComputers: NonNegativeInt,
    importedLlmRoutes: NonNegativeInt,
    importedWorkerProfiles: NonNegativeInt,
    /** Records that stayed pending under the bindings the operator supplied. */
    pending: Schema.Array(WorkjetLegacyImportPending).pipe(
      Schema.check(Schema.isMaxLength(WORKJET_LEGACY_IMPORT_MAX_PENDING)),
    ),
  }),
  Schema.Struct({
    ...DecisionResultBase,
    outcome: Schema.Literal("declined"),
  }),
  Schema.Struct({
    ...DecisionResultBase,
    outcome: Schema.Literal("already-decided"),
    previousOutcome: Schema.Literals(["imported", "declined"]),
  }),
  Schema.Struct({
    ...DecisionResultBase,
    outcome: Schema.Literal("nothing-to-import"),
  }),
  Schema.Struct({
    ...DecisionResultBase,
    outcome: Schema.Literal("unreadable"),
    legacyPath: LegacyPath,
    failure: WorkjetLegacyImportFailure,
  }),
  Schema.Struct({
    ...DecisionResultBase,
    outcome: Schema.Literal("not-persisted"),
    legacyPath: LegacyPath,
    detail: DecisionReason,
  }),
]);
export type WorkjetLegacyImportDecisionResult = typeof WorkjetLegacyImportDecisionResult.Type;

/**
 * A REFUSED request. Every reason means the server declined to store something
 * it could not verify, and nothing was written: no settings patch, no marker.
 */
export const WorkjetLegacyImportErrorReason = Schema.Literals([
  /** The binding names an environment this server cannot verify. */
  "unknown-environment",
  /** The binding names an account the environment's gateway catalog does not hold. */
  "unknown-gateway-account",
  /**
   * The gateway catalog could not be read, so an account binding cannot be
   * verified. Fail closed: an unverifiable reference is not stored.
   */
  "gateway-unavailable",
  /** The binding names a legacy record the current offer does not contain. */
  "unknown-record",
  /** A bindable pending record was neither bound nor explicitly skipped. */
  "unresolved-pending",
  /** The same legacy record was bound twice, or bound and skipped at once. */
  "conflicting-binding",
  /** The legacy import surface is not available on this server. */
  "import-unavailable",
]);
export type WorkjetLegacyImportErrorReason = typeof WorkjetLegacyImportErrorReason.Type;

export class WorkjetLegacyImportError extends Schema.TaggedErrorClass<WorkjetLegacyImportError>()(
  "WorkjetLegacyImportError",
  {
    reason: WorkjetLegacyImportErrorReason,
    /** The legacy record id, environment id, or account id that was refused. */
    subject: Schema.NullOr(boundedText(400)),
  },
) {
  override get message(): string {
    const subject = this.subject === null ? "" : ` (${this.subject})`;
    switch (this.reason) {
      case "unknown-environment":
        return `This server cannot verify that Code environment${subject}.`;
      case "unknown-gateway-account":
        return `The provider gateway has no such account${subject}.`;
      case "gateway-unavailable":
        return "The provider gateway catalog is unavailable, so an account binding cannot be verified.";
      case "unknown-record":
        return `The legacy configuration has no such record${subject}.`;
      case "unresolved-pending":
        return `A record still needs a binding or an explicit skip${subject}.`;
      case "conflicting-binding":
        return `That legacy record was answered more than once${subject}.`;
      case "import-unavailable":
        return "The legacy Workjet import is unavailable on this server.";
    }
  }
}
