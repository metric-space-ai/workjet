import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const WorkjetThreadRole = Schema.Literals(["standard", "orchestrator", "worker"]);
export type WorkjetThreadRole = typeof WorkjetThreadRole.Type;

export const WorkjetCapabilityId = Schema.Literals([
  "greppy",
  "web-search",
  "web-stack-browser",
  "decision-hub",
]);
export type WorkjetCapabilityId = typeof WorkjetCapabilityId.Type;

export const WorkjetConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).pipe(
  Schema.brand("WorkjetConnectionId"),
);
export type WorkjetConnectionId = typeof WorkjetConnectionId.Type;

export const WorkjetConnectionStatus = Schema.Literals([
  "ready",
  "needs_auth",
  "offline",
  "unsupported",
  "error",
]);
export type WorkjetConnectionStatus = typeof WorkjetConnectionStatus.Type;

export const WorkjetConnectionSource = Schema.Literals(["local_ctox", "ctox_dev"]);
export type WorkjetConnectionSource = typeof WorkjetConnectionSource.Type;

export const WorkjetConnectionSummary = Schema.Struct({
  connectionId: WorkjetConnectionId,
  instanceId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  source: WorkjetConnectionSource,
  status: WorkjetConnectionStatus,
  reason: Schema.NullOr(TrimmedString),
});
export type WorkjetConnectionSummary = typeof WorkjetConnectionSummary.Type;

export const WorkjetCtoxConnectionBindingTarget = Schema.Struct({
  kind: Schema.Literal("ctox-connection"),
  connectionId: WorkjetConnectionId,
});
export type WorkjetCtoxConnectionBindingTarget = typeof WorkjetCtoxConnectionBindingTarget.Type;

export const WorkjetCapabilityBinding = Schema.Struct({
  capabilityId: WorkjetCapabilityId,
  target: WorkjetCtoxConnectionBindingTarget,
});
export type WorkjetCapabilityBinding = typeof WorkjetCapabilityBinding.Type;

export const WorkjetComputerId = TrimmedNonEmptyString.pipe(Schema.brand("WorkjetComputerId"));
export type WorkjetComputerId = typeof WorkjetComputerId.Type;

export const WorkjetLlmRouteId = TrimmedNonEmptyString.pipe(Schema.brand("WorkjetLlmRouteId"));
export type WorkjetLlmRouteId = typeof WorkjetLlmRouteId.Type;

export const WorkjetWorkerProfileId = TrimmedNonEmptyString.pipe(
  Schema.brand("WorkjetWorkerProfileId"),
);
export type WorkjetWorkerProfileId = typeof WorkjetWorkerProfileId.Type;

export const WorkjetHarness = Schema.Literals([
  "claude-code",
  "codex-cli",
  "opencode",
  "grok-cli",
  "cursor-agent",
  "pi-code",
]);
export type WorkjetHarness = typeof WorkjetHarness.Type;

/** Presentation only. The referenced Code environment remains transport authority. */
export const WorkjetComputerPresentationKind = Schema.Literals([
  "local",
  "t3-connect",
  "ssh",
  "tailscale",
  "remote",
]);
export type WorkjetComputerPresentationKind = typeof WorkjetComputerPresentationKind.Type;

export const WorkjetHarnessConfiguration = Schema.Struct({
  harness: WorkjetHarness,
  available: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  executableOverride: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkjetHarnessConfiguration = typeof WorkjetHarnessConfiguration.Type;

export const WorkjetComputer = Schema.Struct({
  id: WorkjetComputerId,
  label: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  presentationKind: WorkjetComputerPresentationKind,
  harnesses: Schema.Array(WorkjetHarnessConfiguration).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type WorkjetComputer = typeof WorkjetComputer.Type;

/**
 * Identifier of a provider account owned by the environment-scoped Workjet
 * provider gateway. Declared here because {@link WorkjetLlmRoute} references it;
 * the rest of the gateway catalog contracts live further down this module.
 */
export const WorkjetGatewayAccountId = TrimmedNonEmptyString.pipe(
  Schema.brand("WorkjetGatewayAccountId"),
);
export type WorkjetGatewayAccountId = typeof WorkjetGatewayAccountId.Type;

/**
 * A non-secret route to credentials protected by the provider-gateway account
 * authority. The reference is a Workjet gateway account id — never a Code
 * provider-driver instance id, and never a model or a credential.
 */
export const WorkjetLlmRoute = Schema.Struct({
  id: WorkjetLlmRouteId,
  label: TrimmedNonEmptyString,
  gatewayAccountId: WorkjetGatewayAccountId,
});
export type WorkjetLlmRoute = typeof WorkjetLlmRoute.Type;

/**
 * Configuration schema v1 route shape. The reference field was named
 * `providerInstanceId` and branded as a Code provider-driver instance id
 * because the route contract predated the provider-gateway account identity.
 *
 * The field is decoded as a plain non-empty string on purpose: the v1 editor
 * wrote real gateway account ids through an unchecked brand cast, so persisted
 * values are not guaranteed to satisfy the provider-instance slug pattern.
 * Decoding must never fail here — a failure would discard the entire
 * `settings.json` (the server falls back to `DEFAULT_SERVER_SETTINGS` when the
 * settings document does not decode).
 */
const WorkjetLlmRouteV1 = Schema.Struct({
  id: WorkjetLlmRouteId,
  label: TrimmedNonEmptyString,
  providerInstanceId: TrimmedNonEmptyString,
});
type WorkjetLlmRouteV1 = typeof WorkjetLlmRouteV1.Type;

/**
 * Workjet configuration migration step 2 — "LLM route reference retype".
 *
 * Maps a v1 route `{ providerInstanceId }` to a v2 route `{ gatewayAccountId }`,
 * carrying the value over verbatim. It is a pure, exported, one-shot function so
 * the migration is inspectable and independently testable.
 *
 * Values written by the post-gateway editor are already provider-gateway account
 * ids and resolve against the gateway catalog unchanged. Genuinely historical
 * provider-driver instance ids migrate as-is and simply will not resolve against
 * the catalog; the editor then renders the raw id and the operator re-picks an
 * account. That is accepted: `llmRoutes` had no server-side consumer at the time
 * of this migration, so an unresolvable reference cannot affect a running route.
 */
export function migrateWorkjetLlmRouteV1ToV2(route: WorkjetLlmRouteV1): WorkjetLlmRoute {
  return {
    id: route.id,
    label: route.label,
    gatewayAccountId: WorkjetGatewayAccountId.make(route.providerInstanceId),
  };
}

type WorkjetLlmRoutePersistedInput = WorkjetLlmRoute | WorkjetLlmRouteV1;

/**
 * Persisted route reader. Accepts either the v2 shape or the v1 shape and always
 * yields the canonical v2 shape; encoding always writes v2.
 */
const WorkjetLlmRoutePersisted = Schema.Union([WorkjetLlmRoute, WorkjetLlmRouteV1]).pipe(
  Schema.decodeTo(
    WorkjetLlmRoute,
    SchemaTransformation.transformOrFail({
      decode: (route: WorkjetLlmRoutePersistedInput): Effect.Effect<WorkjetLlmRoute> =>
        Effect.succeed("gatewayAccountId" in route ? route : migrateWorkjetLlmRouteV1ToV2(route)),
      encode: (
        route: typeof WorkjetLlmRoute.Encoded,
      ): Effect.Effect<WorkjetLlmRoutePersistedInput> =>
        Effect.succeed({
          id: WorkjetLlmRouteId.make(route.id),
          label: route.label,
          gatewayAccountId: WorkjetGatewayAccountId.make(route.gatewayAccountId),
        }),
    }),
  ),
);

export const WorkjetReasoningSelection = Schema.Literals([
  "automatic",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
  "ultrathink",
]);
export type WorkjetReasoningSelection = typeof WorkjetReasoningSelection.Type;

export const WorkjetWorkerProfile = Schema.Struct({
  id: WorkjetWorkerProfileId,
  name: TrimmedNonEmptyString,
  instructions: Schema.optionalKey(TrimmedString),
  computerId: WorkjetComputerId,
  harness: WorkjetHarness,
  llmRouteId: WorkjetLlmRouteId,
  modelId: TrimmedNonEmptyString,
  reasoning: WorkjetReasoningSelection,
  role: Schema.Literals(["standard", "orchestrator"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("standard" as const)),
  ),
  capabilityIds: Schema.Array(WorkjetCapabilityId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  capabilityBindings: Schema.Array(WorkjetCapabilityBinding).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type WorkjetWorkerProfile = typeof WorkjetWorkerProfile.Type;

export const WorkjetExecutionConfiguration = Schema.Struct({
  probeTimeoutSeconds: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(120))),
  turnTimeoutSeconds: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(5_400))),
  degradationAllowed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type WorkjetExecutionConfiguration = typeof WorkjetExecutionConfiguration.Type;

export const WorkjetTelemetryConfiguration = Schema.Struct({
  claudeCodeEvents: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidecarEvents: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  retentionDays: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(14))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type WorkjetTelemetryConfiguration = typeof WorkjetTelemetryConfiguration.Type;

/**
 * Server-authoritative reusable Workjet catalog. Provider credentials, transport
 * connection details, and per-thread orchestration state intentionally live elsewhere.
 */
/** Current Workjet configuration schema version. Bumped by migration step 2. */
export const WORKJET_CONFIGURATION_SCHEMA_VERSION = 3;

/**
 * Accepts every published configuration version and normalizes to the current
 * one. A stored `1` is upgraded in place by migration step 2, which rewrites the
 * route reference field; there is no other v1/v2 difference.
 */
const WorkjetConfigurationSchemaVersion = Schema.Literals([1, 2, 3]).pipe(
  Schema.decodeTo(
    Schema.Literal(3),
    SchemaTransformation.transformOrFail({
      decode: (_version: 1 | 2 | 3): Effect.Effect<3> => Effect.succeed(3 as const),
      encode: (_version: 3): Effect.Effect<1 | 2 | 3> => Effect.succeed(3 as const),
    }),
  ),
  Schema.withDecodingDefault(Effect.succeed(2 as const)),
);

/** Whole-object value schema without an outer default, used by patch contracts. */
/**
 * Per-model prompt rules, the Swift app's "Modellregeln": guidance that
 * travels with every worker running this model, shown and edited on the
 * Prompt page and prepended to the worker's own task at dispatch.
 */
export const WorkjetModelPrompt = Schema.Struct({
  modelId: TrimmedNonEmptyString,
  prompt: TrimmedString,
});
export type WorkjetModelPrompt = typeof WorkjetModelPrompt.Type;

export const WorkjetConfigurationValue = Schema.Struct({
  schemaVersion: WorkjetConfigurationSchemaVersion,
  computers: Schema.Array(WorkjetComputer).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  modelPrompts: Schema.Array(WorkjetModelPrompt).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  llmRoutes: Schema.Array(WorkjetLlmRoutePersisted).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  workerProfiles: Schema.Array(WorkjetWorkerProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  managedSystemPrompt: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  telemetry: WorkjetTelemetryConfiguration,
  execution: WorkjetExecutionConfiguration,
});

/** Persisted settings schema; an absent legacy value decodes to the typed default. */
export const WorkjetConfiguration = WorkjetConfigurationValue.pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);
export type WorkjetConfiguration = typeof WorkjetConfiguration.Type;

export const DEFAULT_WORKJET_CONFIGURATION: WorkjetConfiguration = Schema.decodeSync(
  WorkjetConfiguration,
)({});

export const WorkjetParentThreadReference = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type WorkjetParentThreadReference = typeof WorkjetParentThreadReference.Type;

export const WorktreeStorageInspectionInput = Schema.Struct({
  root: TrimmedString,
});
export type WorktreeStorageInspectionInput = typeof WorktreeStorageInspectionInput.Type;

export const WorktreeStorageInvalidReason = Schema.Literals([
  "absolute-path-required",
  "not-found",
  "not-directory",
  "not-writable",
  "space-unavailable",
  "filesystem-root",
  "home-directory",
  "project-boundary",
  "server-boundary",
  "contains-protected-location",
  "inside-checkout",
]);
export type WorktreeStorageInvalidReason = typeof WorktreeStorageInvalidReason.Type;

const WorktreeStorageInspectionContext = {
  requestedRoot: Schema.String,
  configuredRoot: Schema.String,
  defaultRoot: Schema.String,
  effectiveRoot: Schema.String,
} as const;

export const WorktreeStorageInspection = Schema.Union([
  Schema.Struct({
    ...WorktreeStorageInspectionContext,
    status: Schema.Literal("valid"),
    canonicalRoot: Schema.String,
    writable: Schema.Literal(true),
    availableBytes: NonNegativeInt,
  }),
  Schema.Struct({
    ...WorktreeStorageInspectionContext,
    status: Schema.Literal("invalid"),
    canonicalRoot: Schema.NullOr(Schema.String),
    writable: Schema.Boolean,
    availableBytes: Schema.NullOr(NonNegativeInt),
    reason: WorktreeStorageInvalidReason,
    message: Schema.String,
  }),
]);
export type WorktreeStorageInspection = typeof WorktreeStorageInspection.Type;

/** Portable public contract for the server-wide managed Greppy runtime. */
export const GreppyRuntimeAvailability = Schema.Literals([
  "available",
  "unavailable",
  "unsupported",
]);
export type GreppyRuntimeAvailability = typeof GreppyRuntimeAvailability.Type;

export const GreppyRuntimeSource = Schema.Literals(["override", "managed", "path"]);
export type GreppyRuntimeSource = typeof GreppyRuntimeSource.Type;

export const GreppyRuntimeReason = Schema.Literals([
  "unsupported-host",
  "override-invalid",
  "managed-invalid",
  "path-unavailable",
  "binary-unavailable",
  "version-mismatch",
  "surface-mismatch",
  "timeout",
  "process-exit",
  "malformed-response",
  "oversized-response",
  "index-unavailable",
  "install-failed",
]);
export type GreppyRuntimeReason = typeof GreppyRuntimeReason.Type;

const GreppyRuntimeSnapshotBaseFields = {
  version: Schema.Literal("0.3.1"),
} as const;

/**
 * LIVE harness availability, probed on the host, replacing a hand-toggled
 * boolean.
 *
 * `WorkjetHarnessConfiguration.available` is a value an operator ticks in
 * settings. It is a STATEMENT OF INTENT and nothing verifies it, so a worker
 * profile can name a harness whose executable was never installed, moved, or
 * was removed after the box was ticked — and the failure only appears when a
 * delegation is already running. These types carry what the host actually
 * found instead.
 *
 * The reason vocabulary is closed and small on purpose. It answers "why can I
 * not use this" in terms an operator can act on, and it deliberately does NOT
 * carry the probe's stderr: a failing executable's output is untrusted text
 * from a third-party binary, and putting it on a typed contract would make
 * every consumer a place it could surface.
 */
export const WorkjetHarnessAvailabilityReason = Schema.Literals([
  /** Nothing resolvable at the configured path or on PATH. */
  "executable-not-found",
  /** Found, but not executable by this process. */
  "not-executable",
  /** Ran, but did not answer within the probe budget. */
  "timeout",
  /** Ran and failed, or answered something unrecognizable. */
  "probe-failed",
  /** This host cannot run this harness at all (wrong OS/arch). */
  "unsupported-host",
]);
export type WorkjetHarnessAvailabilityReason = typeof WorkjetHarnessAvailabilityReason.Type;

export const WorkjetHarnessAvailability = Schema.Union([
  Schema.Struct({
    harness: WorkjetHarness,
    availability: Schema.Literal("available"),
    /** Where the probe resolved it, for an operator diagnosing a wrong pick. */
    executablePath: TrimmedNonEmptyString,
    /**
     * Absent when the harness answered but published no parsable version. A
     * harness that works is still usable without one, so this must not be
     * required — demanding it would report a working harness as broken.
     */
    version: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    harness: WorkjetHarness,
    availability: Schema.Literal("unavailable"),
    reason: WorkjetHarnessAvailabilityReason,
  }),
]);
export type WorkjetHarnessAvailability = typeof WorkjetHarnessAvailability.Type;

/**
 * One probe pass over every configured harness on one computer.
 *
 * `probedAt` is on the SNAPSHOT rather than per entry: they are probed
 * together, and a per-entry timestamp would invite treating one entry as
 * fresher than another when it is not.
 */
export const WorkjetHarnessAvailabilitySnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  probedAt: TrimmedNonEmptyString,
  harnesses: Schema.Array(WorkjetHarnessAvailability).check(Schema.isMaxLength(32)),
});
export type WorkjetHarnessAvailabilitySnapshot = typeof WorkjetHarnessAvailabilitySnapshot.Type;

export const GreppyRuntimeSnapshot = Schema.Union([
  Schema.Struct({
    ...GreppyRuntimeSnapshotBaseFields,
    availability: Schema.Literal("available"),
    source: GreppyRuntimeSource,
    installSupported: Schema.Boolean,
  }),
  Schema.Struct({
    ...GreppyRuntimeSnapshotBaseFields,
    availability: Schema.Literal("unavailable"),
    reason: GreppyRuntimeReason,
    installSupported: Schema.Boolean,
  }),
  Schema.Struct({
    ...GreppyRuntimeSnapshotBaseFields,
    availability: Schema.Literal("unsupported"),
    reason: Schema.Literal("unsupported-host"),
    installSupported: Schema.Literal(false),
  }),
]);
export type GreppyRuntimeSnapshot = typeof GreppyRuntimeSnapshot.Type;

/**
 * Sanitized RPC failure. The wire representation is intentionally limited to
 * a bounded reason and never carries process output, paths, URLs, or arbitrary
 * server messages.
 */
export class WorkjetGreppyOperationError extends Schema.TaggedErrorClass<WorkjetGreppyOperationError>()(
  "WorkjetGreppyOperationError",
  { reason: GreppyRuntimeReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported-host":
        return "Managed Greppy is unsupported on this host.";
      case "override-invalid":
        return "The configured Greppy executable override is unusable.";
      case "managed-invalid":
        return "The managed Greppy runtime needs repair.";
      case "path-unavailable":
      case "binary-unavailable":
        return "Greppy is unavailable on this server.";
      case "version-mismatch":
      case "surface-mismatch":
        return "The Greppy runtime is incompatible.";
      case "timeout":
        return "The Greppy runtime operation timed out.";
      case "process-exit":
      case "install-failed":
        return "The Greppy runtime operation failed.";
      case "malformed-response":
      case "oversized-response":
        return "Greppy returned an invalid response.";
      case "index-unavailable":
        return "Greppy indexing is unavailable.";
    }
  }
}

const WorkjetThreadConfigV1BaseFields = {
  schemaVersion: Schema.Literal(1),
  managedInstructions: Schema.String,
  enabledCapabilityIds: Schema.Array(WorkjetCapabilityId),
} as const;

const WorkjetThreadConfigV2BaseFields = {
  schemaVersion: Schema.Literal(2),
  managedInstructions: Schema.String,
  enabledCapabilityIds: Schema.Array(WorkjetCapabilityId),
  capabilityBindings: Schema.Array(WorkjetCapabilityBinding),
} as const;

export const WorkjetThreadConfig = Schema.Union([
  Schema.Struct({
    ...WorkjetThreadConfigV1BaseFields,
    role: Schema.Literals(["standard", "orchestrator"]),
    parent: Schema.Null,
  }),
  Schema.Struct({
    ...WorkjetThreadConfigV1BaseFields,
    role: Schema.Literal("worker"),
    parent: WorkjetParentThreadReference,
  }),
  Schema.Struct({
    ...WorkjetThreadConfigV2BaseFields,
    role: Schema.Literals(["standard", "orchestrator"]),
    parent: Schema.Null,
  }),
  Schema.Struct({
    ...WorkjetThreadConfigV2BaseFields,
    role: Schema.Literal("worker"),
    parent: WorkjetParentThreadReference,
  }),
]);
export type WorkjetThreadConfig = typeof WorkjetThreadConfig.Type;

export type WorkjetThreadConfigV2 = Extract<WorkjetThreadConfig, { readonly schemaVersion: 2 }>;

export function normalizeWorkjetThreadConfig(config: WorkjetThreadConfig): WorkjetThreadConfigV2 {
  if (config.schemaVersion === 2) return config;
  if (config.role === "worker") {
    return {
      schemaVersion: 2,
      role: "worker",
      parent: config.parent,
      managedInstructions: config.managedInstructions,
      enabledCapabilityIds: config.enabledCapabilityIds,
      capabilityBindings: [],
    };
  }
  return {
    schemaVersion: 2,
    role: config.role,
    parent: null,
    managedInstructions: config.managedInstructions,
    enabledCapabilityIds: config.enabledCapabilityIds,
    capabilityBindings: [],
  };
}

export const DEFAULT_WORKJET_THREAD_CONFIG = {
  schemaVersion: 2,
  role: "standard",
  parent: null,
  managedInstructions: "",
  enabledCapabilityIds: [],
  capabilityBindings: [],
} as const satisfies WorkjetThreadConfig;

/**
 * Gateway providers whose account is created by an OAuth login in the user's
 * own browser. Workjet never sees the credential.
 */
export const WorkjetGatewayOauthProvider = Schema.Literals([
  "claude",
  "codex",
  "antigravity",
  // xAI is BOTH kinds: a subscription account arrives by device-code login
  // (this literal), an API key by paste (WorkjetGatewayApiKeyProvider).
  "xai",
]);
export type WorkjetGatewayOauthProvider = typeof WorkjetGatewayOauthProvider.Type;

/**
 * Gateway providers whose account is created by pasting an API key. The key is
 * stored in the server secret store exactly like an OAuth token and is never
 * written to a configuration file or returned on any read route.
 *
 * Every provider here speaks the OpenAI Chat Completions wire shape upstream,
 * because that is the only shape the gateway's API-key proxy path translates
 * to. A provider with a different shape must not be added.
 */
export const WorkjetGatewayApiKeyProvider = Schema.Literals(["zai", "minimax", "xai", "kimi"]);
export type WorkjetGatewayApiKeyProvider = typeof WorkjetGatewayApiKeyProvider.Type;

/** Provider accounts owned by the environment-scoped Workjet gateway, not harness drivers. */
export const WorkjetGatewayProvider = Schema.Literals([
  "claude",
  "codex",
  "antigravity",
  "zai",
  "minimax",
  "xai",
  "kimi",
]);
export type WorkjetGatewayProvider = typeof WorkjetGatewayProvider.Type;

export const WorkjetGatewayPoolId = TrimmedNonEmptyString.pipe(
  Schema.brand("WorkjetGatewayPoolId"),
);
export type WorkjetGatewayPoolId = typeof WorkjetGatewayPoolId.Type;

export const WorkjetGatewayRouteId = TrimmedNonEmptyString.pipe(
  Schema.brand("WorkjetGatewayRouteId"),
);
export type WorkjetGatewayRouteId = typeof WorkjetGatewayRouteId.Type;

export const WorkjetGatewayAccountSummary = Schema.Struct({
  id: WorkjetGatewayAccountId,
  label: TrimmedNonEmptyString,
  provider: WorkjetGatewayProvider,
  enabled: Schema.Boolean,
  priority: Schema.Number,
  weight: PositiveInt,
  modelIds: Schema.Array(TrimmedNonEmptyString),
  /**
   * Last few characters of an API-key account's credential, for recognition
   * only; `null` for OAuth accounts and whenever no suffix was recorded. This
   * is the ONLY part of a credential any read route ever carries.
   */
  credentialSuffix: Schema.NullOr(
    TrimmedNonEmptyString.pipe(Schema.check(Schema.isMaxLength(8))),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type WorkjetGatewayAccountSummary = typeof WorkjetGatewayAccountSummary.Type;

export const WorkjetGatewayPoolSummary = Schema.Struct({
  id: WorkjetGatewayPoolId,
  label: TrimmedNonEmptyString,
  provider: WorkjetGatewayProvider,
  accountIds: Schema.Array(WorkjetGatewayAccountId),
  modelIds: Schema.Array(TrimmedNonEmptyString),
});
export type WorkjetGatewayPoolSummary = typeof WorkjetGatewayPoolSummary.Type;

export const WorkjetGatewayRouteSummary = Schema.Struct({
  id: WorkjetGatewayRouteId,
  label: TrimmedNonEmptyString,
  poolId: WorkjetGatewayPoolId,
  provider: WorkjetGatewayProvider,
  modelIds: Schema.Array(TrimmedNonEmptyString),
});
export type WorkjetGatewayRouteSummary = typeof WorkjetGatewayRouteSummary.Type;

export const WorkjetGatewayModelSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  providers: Schema.Array(WorkjetGatewayProvider),
  accountIds: Schema.Array(WorkjetGatewayAccountId),
});
export type WorkjetGatewayModelSummary = typeof WorkjetGatewayModelSummary.Type;

/**
 * Account selection strategy. These are exactly the three variants the Rust
 * host implements (`SchedulerStrategy`, sdk/cliproxy/auth/scheduler.rs), in the
 * host's own kebab-case serialization, and the value is written straight into
 * the host runtime configuration's `routing_strategy`. No fourth strategy may
 * be added here without the host learning it first.
 */
export const WorkjetGatewayRoutingStrategy = Schema.Literals([
  "round-robin",
  "fill-first",
  "weighted-round-robin",
]);
export type WorkjetGatewayRoutingStrategy = typeof WorkjetGatewayRoutingStrategy.Type;

export const WORKJET_GATEWAY_DEFAULT_ROUTING_STRATEGY: WorkjetGatewayRoutingStrategy =
  "round-robin";

/** Highest priority and weight the gateway configuration accepts per account. */
export const WORKJET_GATEWAY_MAX_ACCOUNT_PRIORITY = 10_000;
export const WORKJET_GATEWAY_MAX_ACCOUNT_WEIGHT = 10_000;

/**
 * One account's membership in its provider pool. `selectable` is the host's
 * live eligibility, not a wish: an account is unselectable when it is disabled,
 * or when the pool runs the weighted strategy and the account's weight is not
 * positive (the host's `available_candidates` drops those outright), or when a
 * priority-exclusive pool has a higher-priority member.
 */
export const WorkjetGatewayPoolMember = Schema.Struct({
  accountId: WorkjetGatewayAccountId,
  label: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  priority: Schema.Number,
  weight: PositiveInt,
  selectable: Schema.Boolean,
});
export type WorkjetGatewayPoolMember = typeof WorkjetGatewayPoolMember.Type;

/**
 * A pool as the gateway host actually implements it: one implicit pool per
 * provider, holding every account configured for that provider. The host has no
 * named-pool concept and no way to route a request to a subset of a provider's
 * accounts, so this contract deliberately offers none.
 *
 * `weightHonored` is false for the API-key providers: their `ApiKeyAccountPool`
 * sorts by priority and then round-robins, ignoring both `weight` and the
 * configured strategy. `priorityExclusive` is true only for the OAuth pools,
 * whose scheduler retains the highest-priority candidates and drops the rest;
 * the API-key pool keeps lower-priority accounts in the rotation.
 */
export const WorkjetGatewayProviderPool = Schema.Struct({
  provider: WorkjetGatewayProvider,
  strategy: WorkjetGatewayRoutingStrategy,
  weightHonored: Schema.Boolean,
  priorityExclusive: Schema.Boolean,
  members: Schema.Array(WorkjetGatewayPoolMember),
});
export type WorkjetGatewayProviderPool = typeof WorkjetGatewayProviderPool.Type;

export const WorkjetGatewayCatalog = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  accounts: Schema.Array(WorkjetGatewayAccountSummary),
  pools: Schema.Array(WorkjetGatewayPoolSummary),
  routes: Schema.Array(WorkjetGatewayRouteSummary),
  models: Schema.Array(WorkjetGatewayModelSummary),
  /**
   * Additive. The single host-wide selection strategy; the host's
   * `CliproxyRuntimeConfig.routing_strategy` is one value for the whole
   * runtime, not one per pool.
   */
  routingStrategy: WorkjetGatewayRoutingStrategy.pipe(
    Schema.withDecodingDefault(Effect.succeed(WORKJET_GATEWAY_DEFAULT_ROUTING_STRATEGY)),
  ),
  /** Additive. Derived per-provider pools; see {@link WorkjetGatewayProviderPool}. */
  providerPools: Schema.Array(WorkjetGatewayProviderPool).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type WorkjetGatewayCatalog = typeof WorkjetGatewayCatalog.Type;

/**
 * Whether a health dimension is something the gateway host reports at all.
 * Kept explicit rather than omitted so the surface can say "the host does not
 * publish this" instead of rendering an invented value or a silent blank.
 */
export const WorkjetGatewayHealthAvailability = Schema.Literals([
  "reported",
  "not-reported-by-host",
]);
export type WorkjetGatewayHealthAvailability = typeof WorkjetGatewayHealthAvailability.Type;

export const WorkjetGatewayProviderPhase = Schema.Literals([
  "ready",
  "waiting-for-subscription",
  "unknown",
]);
export type WorkjetGatewayProviderPhase = typeof WorkjetGatewayProviderPhase.Type;

/**
 * Per-provider health as the host's management surface reports it: the account
 * counts and model list from `GET /v0/management/runtime-config` plus the
 * endpoint phase from `GET /v0/management/runtime-status`.
 */
export const WorkjetGatewayProviderHealth = Schema.Struct({
  provider: WorkjetGatewayProvider,
  accountCount: NonNegativeInt,
  enabledAccountCount: NonNegativeInt,
  modelIds: Schema.Array(TrimmedNonEmptyString),
  phase: WorkjetGatewayProviderPhase,
});
export type WorkjetGatewayProviderHealth = typeof WorkjetGatewayProviderHealth.Type;

/**
 * A health snapshot read from the running gateway host, with the time it was
 * read so the surface can age it honestly.
 *
 * `accountHealth` and `capacity` are availability flags, not data. The host
 * tracks per-credential cooldown state (`CooldownStateRecord`: status, reason,
 * next retry, quota, last error) but keeps it in an in-process store that its
 * management surface never publishes, and it exposes no concurrency or
 * capacity figure anywhere. Both therefore read `not-reported-by-host` until
 * the host grows a route for them.
 */
export const WorkjetGatewayHealth = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  observedAtMs: NonNegativeInt,
  activeProvider: Schema.NullOr(WorkjetGatewayProvider),
  providers: Schema.Array(WorkjetGatewayProviderHealth),
  accountHealth: WorkjetGatewayHealthAvailability,
  capacity: WorkjetGatewayHealthAvailability,
});
export type WorkjetGatewayHealth = typeof WorkjetGatewayHealth.Type;

/**
 * Where a model id came from. `gateway-catalog` is the host's own pinned model
 * catalog (`GET /v0/management/model-definitions/<channel>`);
 * `account-configuration` is a model id recorded on the account when it was
 * created. Neither is an upstream capability query — the host makes no such
 * call — so the surface must not present either as "live from the provider".
 */
export const WorkjetGatewayModelSource = Schema.Literals([
  "gateway-catalog",
  "account-configuration",
]);
export type WorkjetGatewayModelSource = typeof WorkjetGatewayModelSource.Type;

export const WorkjetGatewayDiscoveredModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  source: WorkjetGatewayModelSource,
});
export type WorkjetGatewayDiscoveredModel = typeof WorkjetGatewayDiscoveredModel.Type;

/**
 * Model discovery for one provider. `channel` is the host catalog channel that
 * answered, or `null` when the host has no catalog for this provider at all
 * (zai and minimax have none), in which case only the configured account models
 * are listed and `catalogAvailable` is false.
 */
export const WorkjetGatewayProviderModels = Schema.Struct({
  provider: WorkjetGatewayProvider,
  channel: Schema.NullOr(TrimmedNonEmptyString),
  catalogAvailable: Schema.Boolean,
  models: Schema.Array(WorkjetGatewayDiscoveredModel),
});
export type WorkjetGatewayProviderModels = typeof WorkjetGatewayProviderModels.Type;

export const WorkjetGatewayModelDiscovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  observedAtMs: NonNegativeInt,
  providers: Schema.Array(WorkjetGatewayProviderModels),
});
export type WorkjetGatewayModelDiscovery = typeof WorkjetGatewayModelDiscovery.Type;

/** One account's pool membership edit. Every field is replaced, never merged. */
export const WorkjetGatewayAccountRoutingUpdate = Schema.Struct({
  accountId: WorkjetGatewayAccountId,
  enabled: Schema.Boolean,
  priority: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(-WORKJET_GATEWAY_MAX_ACCOUNT_PRIORITY),
    Schema.isLessThanOrEqualTo(WORKJET_GATEWAY_MAX_ACCOUNT_PRIORITY),
  ),
  weight: PositiveInt.check(Schema.isLessThanOrEqualTo(WORKJET_GATEWAY_MAX_ACCOUNT_WEIGHT)),
  /**
   * Model ids this account serves, for a provider the gateway host has no
   * built-in catalog for.
   *
   * `zai` and `minimax` have `channel: null` in GATEWAY_MODEL_CHANNELS, so the
   * host serves them nothing of its own and the account must carry the list
   * itself. Without this field a valid, paid-for key sits "in rotation" and
   * can answer no request at all — which is exactly what it did.
   *
   * Omit the field to leave the account's current list alone; an empty array
   * clears it, which must stay distinguishable from "not editing this".
   */
  models: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.pipe(Schema.check(Schema.isMaxLength(128)))).pipe(
      Schema.check(Schema.isMaxLength(128)),
    ),
  ),
});
export type WorkjetGatewayAccountRoutingUpdate = typeof WorkjetGatewayAccountRoutingUpdate.Type;

/**
 * Replaces the pool configuration: the host-wide selection strategy plus the
 * membership of every listed account. Accounts omitted from `accounts` keep
 * their current membership; an unknown account id is refused rather than
 * silently ignored.
 */
export const WorkjetGatewayUpdateRoutingInput = Schema.Struct({
  strategy: WorkjetGatewayRoutingStrategy,
  accounts: Schema.Array(WorkjetGatewayAccountRoutingUpdate).pipe(
    Schema.check(Schema.isMaxLength(64)),
  ),
});
export type WorkjetGatewayUpdateRoutingInput = typeof WorkjetGatewayUpdateRoutingInput.Type;

/** The catalog as it stands after the edit, so no second read is needed. */
export const WorkjetGatewayUpdateRoutingResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  catalog: WorkjetGatewayCatalog,
});
export type WorkjetGatewayUpdateRoutingResult = typeof WorkjetGatewayUpdateRoutingResult.Type;

/**
 * One provider OAuth login flow through the local gateway host. The user opens
 * `authorizationUrl` in their own browser and completes the provider login
 * there; Workjet never sees or types credentials. `state` is the opaque
 * session handle for polling and cancellation.
 */
export const WorkjetGatewayOauthSession = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  provider: WorkjetGatewayOauthProvider,
  state: TrimmedNonEmptyString.pipe(Schema.check(Schema.isMaxLength(128))),
  authorizationUrl: TrimmedNonEmptyString.pipe(Schema.check(Schema.isMaxLength(2048))),
});
export type WorkjetGatewayOauthSession = typeof WorkjetGatewayOauthSession.Type;

export const WorkjetGatewayOauthStartInput = Schema.Struct({
  provider: WorkjetGatewayOauthProvider,
});
export type WorkjetGatewayOauthStartInput = typeof WorkjetGatewayOauthStartInput.Type;

/**
 * Longest accepted API key. Generous enough for every provider's format and
 * short enough that the RPC can never be used to push bulk data at the secret
 * store.
 */
export const WORKJET_GATEWAY_API_KEY_MAX_LENGTH = 512;

/**
 * Adds one API-key gateway account. `apiKey` is write-only: the server stores
 * it in the secret store, writes only a secret REFERENCE into the gateway
 * configuration, and never logs, echoes, or returns it. Read routes show the
 * account's label and masked suffix only.
 */
export const WorkjetGatewayAddApiKeyAccountInput = Schema.Struct({
  provider: WorkjetGatewayApiKeyProvider,
  label: TrimmedNonEmptyString.pipe(Schema.check(Schema.isMaxLength(160))),
  apiKey: TrimmedNonEmptyString.pipe(
    Schema.check(Schema.isMaxLength(WORKJET_GATEWAY_API_KEY_MAX_LENGTH)),
  ),
});
export type WorkjetGatewayAddApiKeyAccountInput = typeof WorkjetGatewayAddApiKeyAccountInput.Type;

/** Redacted result: the created account identity, never the credential. */
export const WorkjetGatewayAddApiKeyAccountResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  accountId: WorkjetGatewayAccountId,
});
export type WorkjetGatewayAddApiKeyAccountResult = typeof WorkjetGatewayAddApiKeyAccountResult.Type;

/** Removes one gateway account by id; the server deletes its secrets too. */
export const WorkjetGatewayRemoveAccountInput = Schema.Struct({
  accountId: WorkjetGatewayAccountId,
});
export type WorkjetGatewayRemoveAccountInput = typeof WorkjetGatewayRemoveAccountInput.Type;

export const WorkjetGatewayRemoveAccountResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  removedAccountId: WorkjetGatewayAccountId,
});
export type WorkjetGatewayRemoveAccountResult = typeof WorkjetGatewayRemoveAccountResult.Type;

export const WorkjetGatewayOauthPollInput = Schema.Struct({
  state: TrimmedNonEmptyString.pipe(Schema.check(Schema.isMaxLength(128))),
});
export type WorkjetGatewayOauthPollInput = typeof WorkjetGatewayOauthPollInput.Type;

/** Redacted poll result: account identities only, never credential material. */
export const WorkjetGatewayOauthPollResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  pending: Schema.Boolean,
  failed: Schema.Boolean,
  completedAccountIds: Schema.Array(WorkjetGatewayAccountId),
});
export type WorkjetGatewayOauthPollResult = typeof WorkjetGatewayOauthPollResult.Type;

export const WorkjetGatewayPhase = Schema.Literals([
  "stopped",
  "starting",
  "ready",
  "stopping",
  "faulted",
]);
export type WorkjetGatewayPhase = typeof WorkjetGatewayPhase.Type;

export const WorkjetGatewayFailureReason = Schema.Literals([
  "host-unavailable",
  "invalid-configuration",
  "secret-unavailable",
  "startup-timeout",
  "invalid-readiness",
  "management-unavailable",
  "process-exit",
  "shutdown-timeout",
  "gateway-not-ready",
  "oauth-unavailable",
  "oauth-session-invalid",
]);
export type WorkjetGatewayFailureReason = typeof WorkjetGatewayFailureReason.Type;

/** Redacted environment-local runtime status. Secret references and process output are excluded. */
export const WorkjetGatewayStatus = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  phase: WorkjetGatewayPhase,
  pid: Schema.NullOr(PositiveInt),
  providerEndpoint: Schema.NullOr(TrimmedNonEmptyString),
  managementEndpoint: Schema.NullOr(TrimmedNonEmptyString),
  failureReason: Schema.NullOr(WorkjetGatewayFailureReason),
  configuredAccountCount: Schema.Number,
  configuredModelCount: Schema.Number,
});
export type WorkjetGatewayStatus = typeof WorkjetGatewayStatus.Type;

export class WorkjetGatewayOperationError extends Schema.TaggedErrorClass<WorkjetGatewayOperationError>()(
  "WorkjetGatewayOperationError",
  { reason: WorkjetGatewayFailureReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "host-unavailable":
        return "The Workjet provider gateway host is unavailable.";
      case "invalid-configuration":
        return "The Workjet provider gateway configuration is invalid.";
      case "secret-unavailable":
        return "A Workjet provider gateway credential is unavailable.";
      case "startup-timeout":
        return "The Workjet provider gateway did not become ready in time.";
      case "invalid-readiness":
        return "The Workjet provider gateway returned an invalid readiness record.";
      case "management-unavailable":
        return "The Workjet provider gateway control plane is unavailable.";
      case "process-exit":
        return "The Workjet provider gateway process exited unexpectedly.";
      case "shutdown-timeout":
        return "The Workjet provider gateway did not stop in time.";
      case "gateway-not-ready":
        return "The Workjet provider gateway is not running.";
      case "oauth-unavailable":
        return "The Workjet provider gateway login flow is unavailable.";
      case "oauth-session-invalid":
        return "The Workjet provider gateway login session is invalid or expired.";
    }
  }
}
