/**
 * The client-facing half of the one-shot legacy Swift Workjet import.
 *
 * The decision, the mapping, and the durable marker already live in
 * {@link LegacyWorkjetImport}; this module adds no second implementation of any
 * of them. What it adds is the OFFER SURFACE:
 *
 *  - `inspect` — a pure read. It resolves the decision, previews the offer with
 *    NO bindings (the honest floor), and reports every record that needs an
 *    operator binding together with the bounded evidence needed to choose one,
 *    plus every field that will NOT come across.
 *  - `decide` — the only write, and it is terminal.
 *
 * ## What the server refuses
 *
 * A binding is an id the CALLER supplies, so the server verifies every one of
 * them against an authority it can actually name, and refuses the whole request
 * — no settings patch, no marker — when it cannot:
 *
 *  - ENVIRONMENTS. A server is one environment and holds no registry of the
 *    others, so exactly two are verifiable: its OWN id, and any environment the
 *    current `settings.workjet` already references because an operator chose it
 *    earlier through the ordinary Computers surface. Anything else is
 *    `unknown-environment`. Inventing an environment id here would produce a
 *    computer whose reference can never resolve, which is precisely what the
 *    mapping refuses to do on its own.
 *  - GATEWAY ACCOUNTS. Verified against the environment's own provider-gateway
 *    catalog. A catalog that cannot be read is `gateway-unavailable`, never an
 *    empty list treated as "no accounts exist".
 *  - LEGACY RECORDS. A binding must name a record the CURRENT offer actually
 *    reports as pending (`unknown-record`), each record may be answered once
 *    (`conflicting-binding`), and every bindable pending record must be answered
 *    — bound or explicitly skipped — before an accept is allowed
 *    (`unresolved-pending`). "I did not notice that one" can therefore never
 *    silently become "do not import it".
 */

import {
  WORKJET_LEGACY_IMPORT_MAX_DROPS,
  WORKJET_LEGACY_IMPORT_MAX_EVIDENCE_ITEMS,
  WORKJET_LEGACY_IMPORT_MAX_PENDING,
  WORKJET_LEGACY_IMPORT_SCHEMA_VERSION,
  WorkjetLegacyImportError,
  type EnvironmentId,
  type WorkjetGatewayAccountId,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayOperationError,
  type WorkjetLegacyImportBindableAccount,
  type WorkjetLegacyImportBindableEnvironment,
  type WorkjetLegacyImportBindings,
  type WorkjetLegacyImportDecideInput,
  type WorkjetLegacyImportDecisionResult,
  type WorkjetLegacyImportDrop,
  type WorkjetLegacyImportFailure,
  type WorkjetLegacyImportInspectInput,
  type WorkjetLegacyImportInspection,
  type WorkjetLegacyImportPending,
  type WorkjetLegacyImportUnreadableReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { LegacyWorkjetReadFailure } from "./LegacyWorkjetConfig.ts";
import type {
  LegacyWorkjetImport,
  LegacyWorkjetImportOffer,
  LegacyWorkjetImportResult,
} from "./LegacyWorkjetImport.ts";
import {
  EMPTY_LEGACY_WORKJET_BINDINGS,
  type LegacyWorkjetDecision,
  type LegacyWorkjetImportBindings as LegacyWorkjetMappingBindings,
  type LegacyWorkjetPendingBinding,
} from "./LegacyWorkjetMapping.ts";

const SCHEMA_VERSION = WORKJET_LEGACY_IMPORT_SCHEMA_VERSION;

/**
 * Legacy text is operator-authored and reaches the wire through length- and
 * charset-bounded schemas, so it is cleaned here rather than risking an encode
 * failure that would take the whole offer down over one stray byte.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

const presentable = (value: string | null | undefined, maximum: number): string | null => {
  if (value === undefined || value === null) return null;
  const cleaned = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, maximum).trim();
};

/** Presentation text that must exist; falls back to the record's own id. */
const presentableOr = (value: string | null | undefined, fallback: string, maximum: number) =>
  presentable(value, maximum) ?? presentable(fallback, maximum) ?? "(unnamed)";

const toFailure = (failure: LegacyWorkjetReadFailure): WorkjetLegacyImportFailure => ({
  reason: failure.reason as WorkjetLegacyImportUnreadableReason,
  path: presentable(failure.path, 400),
  detail: presentableOr(failure.detail, "The legacy document could not be read.", 1024),
});

/**
 * The mapping's pending records, as the wire reports them. Recognition evidence
 * only: a host to recognize a machine by, an account label and CLIProxy account
 * hash to tell two provider accounts apart, model ids to match a catalog. No
 * transport detail, credential, or key material crosses this boundary.
 */
export const toContractPending = (
  pending: readonly LegacyWorkjetPendingBinding[],
): readonly WorkjetLegacyImportPending[] =>
  pending.slice(0, WORKJET_LEGACY_IMPORT_MAX_PENDING).map((record): WorkjetLegacyImportPending => {
    switch (record._tag) {
      case "computer-environment":
        return {
          kind: "computer-environment",
          computerId: presentableOr(record.computerId, "(no id)", 200),
          computerName: presentableOr(record.computerName, record.computerId, 200),
          transport: record.transport,
          host: presentable(record.host, 400),
        };
      case "provider-account":
        return {
          kind: "provider-account",
          providerId: presentableOr(record.providerId, "(no id)", 200),
          providerName: presentableOr(record.providerName, record.providerId, 200),
          modelProvider: presentable(record.modelProvider, 120),
          accountLabel: presentable(record.accountLabel, 200),
          externalCredentialId: presentable(record.externalCredentialId, 200),
          modelIds: record.modelIds
            .slice(0, WORKJET_LEGACY_IMPORT_MAX_EVIDENCE_ITEMS)
            .map((modelId) => presentable(modelId, 200))
            .filter((modelId): modelId is string => modelId !== null),
        };
      case "provider-pool-account":
        return {
          kind: "provider-pool-account",
          pool: presentableOr(record.pool, "(no pool)", 200),
          workerIds: record.workerIds
            .slice(0, WORKJET_LEGACY_IMPORT_MAX_EVIDENCE_ITEMS)
            .map((workerId) => presentable(workerId, 200))
            .filter((workerId): workerId is string => workerId !== null),
          failoverLoss: true,
        };
      case "worker":
        return {
          kind: "worker",
          workerId: presentableOr(record.workerId, "(no id)", 200),
          workerName: presentableOr(record.workerName, record.workerId, 200),
          blockedBy: record.blockedBy,
          detail: presentableOr(record.detail, "This worker cannot be imported yet.", 1024),
        };
    }
  });

/** Every field the import will NOT carry over, with the mapping's own reason. */
export const toContractDrops = (
  decisions: readonly LegacyWorkjetDecision[],
): readonly WorkjetLegacyImportDrop[] =>
  decisions
    .filter((decision) => decision.outcome === "dropped" || decision.outcome === "unmapped-field")
    .slice(0, WORKJET_LEGACY_IMPORT_MAX_DROPS)
    .map((decision) => ({
      kind: decision.outcome === "dropped" ? ("dropped" as const) : ("unmapped-field" as const),
      source: presentableOr(decision.source, "(no source path)", 400),
      reason: presentableOr(decision.reason, "No reason recorded.", 1024),
    }));

const countDrops = (decisions: readonly LegacyWorkjetDecision[]): number =>
  decisions.filter(
    (decision) => decision.outcome === "dropped" || decision.outcome === "unmapped-field",
  ).length;

export interface LegacyWorkjetImportRpcDependencies {
  readonly importer: LegacyWorkjetImport["Service"];
  /**
   * The environment's provider-gateway catalog. Its FAILURE is meaningful: it
   * means the accounts could not be verified, never that there are none.
   */
  readonly gatewayCatalog: Effect.Effect<WorkjetGatewayCatalog, WorkjetGatewayOperationError>;
  /** This server's OWN environment id. Never caller-supplied. */
  readonly environmentId: Effect.Effect<EnvironmentId>;
  /**
   * Environment ids the current `settings.workjet` already references. A read
   * failure yields none: fewer verifiable targets is the safe direction.
   */
  readonly configuredEnvironmentIds: Effect.Effect<readonly EnvironmentId[]>;
}

export interface LegacyWorkjetImportRpcHandlers {
  readonly inspect: (
    input: WorkjetLegacyImportInspectInput,
  ) => Effect.Effect<WorkjetLegacyImportInspection, WorkjetLegacyImportError>;
  readonly decide: (
    input: WorkjetLegacyImportDecideInput,
  ) => Effect.Effect<WorkjetLegacyImportDecisionResult, WorkjetLegacyImportError>;
}

const refuse = (
  reason: WorkjetLegacyImportError["reason"],
  subject: string | null = null,
): WorkjetLegacyImportError => new WorkjetLegacyImportError({ reason, subject });

/** The bindable pending records of one offer, indexed for validation. */
interface BindableSubjects {
  readonly computerIds: ReadonlySet<string>;
  readonly providerIds: ReadonlySet<string>;
  readonly pools: ReadonlySet<string>;
}

const bindableSubjects = (offer: LegacyWorkjetImportOffer): BindableSubjects => {
  const computerIds = new Set<string>();
  const providerIds = new Set<string>();
  const pools = new Set<string>();
  if (offer.preview._tag !== "mapped") return { computerIds, providerIds, pools };
  for (const record of offer.preview.result.pending) {
    if (record._tag === "computer-environment") computerIds.add(record.computerId);
    else if (record._tag === "provider-account") providerIds.add(record.providerId);
    else if (record._tag === "provider-pool-account") pools.add(record.pool);
  }
  return { computerIds, providerIds, pools };
};

export const makeLegacyWorkjetImportRpcHandlers = (
  dependencies: LegacyWorkjetImportRpcDependencies,
): LegacyWorkjetImportRpcHandlers => {
  /**
   * The environments this server can vouch for: itself, plus whatever the
   * current configuration already points at.
   */
  const bindableEnvironments = Effect.gen(function* () {
    const own = yield* dependencies.environmentId;
    const configured = yield* dependencies.configuredEnvironmentIds;
    const seen = new Map<string, WorkjetLegacyImportBindableEnvironment>();
    seen.set(own, { environmentId: own, isSelf: true, referencedByConfiguration: false });
    for (const environmentId of configured) {
      const existing = seen.get(environmentId);
      seen.set(environmentId, {
        environmentId,
        isSelf: existing?.isSelf ?? false,
        referencedByConfiguration: true,
      });
    }
    return [...seen.values()];
  });

  /** `Option.none` means the catalog could not be read at all. */
  const gatewayAccounts = dependencies.gatewayCatalog.pipe(
    Effect.map((catalog) =>
      Option.some(
        catalog.accounts.map(
          (account): WorkjetLegacyImportBindableAccount => ({
            accountId: account.id,
            label: presentableOr(account.label, account.id, 200),
            provider: presentableOr(account.provider, "unknown", 64),
            credentialSuffix: presentable(account.credentialSuffix, 8),
          }),
        ),
      ),
    ),
    Effect.orElseSucceed(() => Option.none<readonly WorkjetLegacyImportBindableAccount[]>()),
  );

  const inspect = (
    _input: WorkjetLegacyImportInspectInput,
  ): Effect.Effect<WorkjetLegacyImportInspection, WorkjetLegacyImportError> =>
    Effect.gen(function* () {
      const state = yield* dependencies.importer.state;

      if (state.decision._tag === "fresh") {
        return { schemaVersion: SCHEMA_VERSION, state: "nothing-to-import" } as const;
      }

      if (state.decision._tag === "already-decided") {
        const marker = Option.getOrUndefined(state.marker);
        return {
          schemaVersion: SCHEMA_VERSION,
          state: "already-decided",
          outcome: state.decision.outcome,
          decidedAt: presentable(marker?.decidedAt, 64),
          legacyPath: presentable(marker?.legacyPath, 1024),
          importedComputers: marker?.importedComputers ?? 0,
          importedLlmRoutes: marker?.importedLlmRoutes ?? 0,
          importedWorkerProfiles: marker?.importedWorkerProfiles ?? 0,
          pendingAtImport: marker?.pendingBindings ?? 0,
        } as const;
      }

      const legacyPath = presentableOr(state.decision.legacyPath, "(unknown path)", 1024);
      // The document exists but could not be read at all. Not a reader refusal,
      // and still no marker: there is nothing here the operator decided.
      if (Option.isNone(state.offer)) {
        return {
          schemaVersion: SCHEMA_VERSION,
          state: "unreadable",
          legacyPath,
          failure: null,
        } as const;
      }

      const offer = state.offer.value;
      if (offer.preview._tag === "unreadable") {
        return {
          schemaVersion: SCHEMA_VERSION,
          state: "unreadable",
          legacyPath,
          failure: toFailure(offer.preview.failure),
        } as const;
      }

      const result = offer.preview.result;
      const accounts = yield* gatewayAccounts;
      const pending = toContractPending(result.pending);
      const drops = toContractDrops(result.decisions);
      return {
        schemaVersion: SCHEMA_VERSION,
        state: "offer",
        legacyPath,
        settingsPath: presentableOr(offer.settingsPath, "(unknown path)", 1024),
        summary: {
          computersImported: result.counts.computersImported,
          computersTotal: result.counts.computersTotal,
          llmRoutesImported: result.counts.llmRoutesImported,
          workersImported: result.counts.workersImported,
          workersTotal: result.counts.workersTotal,
          pendingTotal: result.pending.length,
          dropTotal: countDrops(result.decisions),
        },
        pending,
        pendingTruncated: result.pending.length > pending.length,
        drops,
        dropsTruncated: countDrops(result.decisions) > drops.length,
        bindable: {
          environments: yield* bindableEnvironments,
          gatewayAccounts: Option.getOrElse(
            accounts,
            () => [] as readonly WorkjetLegacyImportBindableAccount[],
          ),
          gatewayCatalogAvailable: Option.isSome(accounts),
        },
      } as const;
    });

  /**
   * Verify every binding, then hand the mapping's own binding shape to the
   * runner. Nothing is written until every check below has passed.
   */
  const validate = (
    offer: LegacyWorkjetImportOffer,
    bindings: WorkjetLegacyImportBindings,
  ): Effect.Effect<LegacyWorkjetMappingBindings, WorkjetLegacyImportError> =>
    Effect.gen(function* () {
      const subjects = bindableSubjects(offer);

      /** One answer per record: no duplicate, no bound-and-skipped. */
      const answered = new Set<string>();
      const claim = (kind: string, subject: string) => {
        const key = `${kind}:${subject}`;
        if (answered.has(key)) return Effect.fail(refuse("conflicting-binding", subject));
        answered.add(key);
        return Effect.void;
      };
      const requireKnown = (known: ReadonlySet<string>, subject: string) =>
        known.has(subject) ? Effect.void : Effect.fail(refuse("unknown-record", subject));

      const environments = new Set(
        (yield* bindableEnvironments).map((environment) => environment.environmentId as string),
      );

      const environmentByComputerId: Record<string, EnvironmentId> = {};
      for (const binding of bindings.computers) {
        yield* requireKnown(subjects.computerIds, binding.computerId);
        yield* claim("computer", binding.computerId);
        if (!environments.has(binding.environmentId)) {
          return yield* Effect.fail(refuse("unknown-environment", binding.environmentId));
        }
        environmentByComputerId[binding.computerId] = binding.environmentId;
      }
      for (const computerId of bindings.skippedComputerIds) {
        yield* requireKnown(subjects.computerIds, computerId);
        yield* claim("computer", computerId);
      }

      // The catalog is read only when an account binding actually needs it, so
      // skipping every provider does not require a running gateway.
      const needsAccounts = bindings.providers.length > 0 || bindings.pools.length > 0;
      const accounts = needsAccounts ? yield* gatewayAccounts : Option.none();
      if (needsAccounts && Option.isNone(accounts)) {
        return yield* Effect.fail(refuse("gateway-unavailable"));
      }
      const accountIds = new Set(
        Option.getOrElse(accounts, () => []).map((account) => account.accountId as string),
      );

      const gatewayAccountByProviderId: Record<string, WorkjetGatewayAccountId> = {};
      for (const binding of bindings.providers) {
        yield* requireKnown(subjects.providerIds, binding.providerId);
        yield* claim("provider", binding.providerId);
        if (!accountIds.has(binding.gatewayAccountId)) {
          return yield* Effect.fail(refuse("unknown-gateway-account", binding.gatewayAccountId));
        }
        gatewayAccountByProviderId[binding.providerId] = binding.gatewayAccountId;
      }
      for (const providerId of bindings.skippedProviderIds) {
        yield* requireKnown(subjects.providerIds, providerId);
        yield* claim("provider", providerId);
      }

      const gatewayAccountByProviderPool: Record<string, WorkjetGatewayAccountId> = {};
      for (const binding of bindings.pools) {
        yield* requireKnown(subjects.pools, binding.pool);
        yield* claim("pool", binding.pool);
        if (!accountIds.has(binding.gatewayAccountId)) {
          return yield* Effect.fail(refuse("unknown-gateway-account", binding.gatewayAccountId));
        }
        gatewayAccountByProviderPool[binding.pool] = binding.gatewayAccountId;
      }
      for (const pool of bindings.skippedPools) {
        yield* requireKnown(subjects.pools, pool);
        yield* claim("pool", pool);
      }

      // Every bindable record must have been answered. A worker record is a
      // consequence of the three above, never a control, so it is not required
      // to be answered — and cannot be.
      for (const [kind, known] of [
        ["computer", subjects.computerIds],
        ["provider", subjects.providerIds],
        ["pool", subjects.pools],
      ] as const) {
        for (const subject of known) {
          if (!answered.has(`${kind}:${subject}`)) {
            return yield* Effect.fail(refuse("unresolved-pending", subject));
          }
        }
      }

      return {
        environmentByComputerId,
        gatewayAccountByProviderId,
        gatewayAccountByProviderPool,
      } satisfies LegacyWorkjetMappingBindings;
    });

  const toDecisionResult = (
    result: LegacyWorkjetImportResult,
  ): WorkjetLegacyImportDecisionResult => {
    switch (result._tag) {
      case "imported":
        return {
          schemaVersion: SCHEMA_VERSION,
          outcome: "imported",
          legacyPath: presentableOr(result.legacyPath, "(unknown path)", 1024),
          importedComputers: result.configuration.computers.length,
          importedLlmRoutes: result.configuration.llmRoutes.length,
          importedWorkerProfiles: result.configuration.workerProfiles.length,
          pending: toContractPending(result.pending),
        };
      case "already-decided":
        return {
          schemaVersion: SCHEMA_VERSION,
          outcome: "already-decided",
          previousOutcome: result.outcome,
        };
      case "fresh":
        return { schemaVersion: SCHEMA_VERSION, outcome: "nothing-to-import" };
      case "unreadable":
        return {
          schemaVersion: SCHEMA_VERSION,
          outcome: "unreadable",
          legacyPath: presentableOr(result.legacyPath, "(unknown path)", 1024),
          failure: toFailure(result.failure),
        };
      case "not-persisted":
        return {
          schemaVersion: SCHEMA_VERSION,
          outcome: "not-persisted",
          legacyPath: presentableOr(result.legacyPath, "(unknown path)", 1024),
          detail: presentableOr(result.detail, "The settings store rejected the patch.", 1024),
        };
    }
  };

  const decide = (
    input: WorkjetLegacyImportDecideInput,
  ): Effect.Effect<WorkjetLegacyImportDecisionResult, WorkjetLegacyImportError> =>
    Effect.gen(function* () {
      const state = yield* dependencies.importer.state;

      if (state.decision._tag === "already-decided") {
        return {
          schemaVersion: SCHEMA_VERSION,
          outcome: "already-decided",
          previousOutcome: state.decision.outcome,
        } as const;
      }
      if (state.decision._tag === "fresh") {
        return { schemaVersion: SCHEMA_VERSION, outcome: "nothing-to-import" } as const;
      }

      if (input.action === "decline") {
        yield* dependencies.importer.decline;
        return { schemaVersion: SCHEMA_VERSION, outcome: "declined" } as const;
      }

      // An offer that could not be described cannot carry bindings either. The
      // runner answers for it — and records nothing.
      if (Option.isNone(state.offer)) {
        return toDecisionResult(yield* dependencies.importer.accept(EMPTY_LEGACY_WORKJET_BINDINGS));
      }

      const bindings = yield* validate(state.offer.value, input.bindings);
      return toDecisionResult(yield* dependencies.importer.accept(bindings));
    });

  return { inspect, decide };
};
