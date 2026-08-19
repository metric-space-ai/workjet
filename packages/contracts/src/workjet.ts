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

export const WorkjetCapabilityId = Schema.Literals(["greppy", "web-search", "web-stack-browser"]);
export type WorkjetCapabilityId = typeof WorkjetCapabilityId.Type;

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
  capabilityIds: Schema.Array(WorkjetCapabilityId).pipe(
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
export const WORKJET_CONFIGURATION_SCHEMA_VERSION = 2;

/**
 * Accepts every published configuration version and normalizes to the current
 * one. A stored `1` is upgraded in place by migration step 2, which rewrites the
 * route reference field; there is no other v1/v2 difference.
 */
const WorkjetConfigurationSchemaVersion = Schema.Literals([1, 2]).pipe(
  Schema.decodeTo(
    Schema.Literal(2),
    SchemaTransformation.transformOrFail({
      decode: (_version: 1 | 2): Effect.Effect<2> => Effect.succeed(2 as const),
      encode: (_version: 2): Effect.Effect<1 | 2> => Effect.succeed(2 as const),
    }),
  ),
  Schema.withDecodingDefault(Effect.succeed(2 as const)),
);

/** Whole-object value schema without an outer default, used by patch contracts. */
export const WorkjetConfigurationValue = Schema.Struct({
  schemaVersion: WorkjetConfigurationSchemaVersion,
  computers: Schema.Array(WorkjetComputer).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
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
]);
export type WorkjetThreadConfig = typeof WorkjetThreadConfig.Type;

export const DEFAULT_WORKJET_THREAD_CONFIG = {
  schemaVersion: 1,
  role: "standard",
  parent: null,
  managedInstructions: "",
  enabledCapabilityIds: [],
} as const satisfies WorkjetThreadConfig;

/**
 * Gateway providers whose account is created by an OAuth login in the user's
 * own browser. Workjet never sees the credential.
 */
export const WorkjetGatewayOauthProvider = Schema.Literals(["claude", "codex", "antigravity"]);
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

export const WorkjetGatewayCatalog = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  accounts: Schema.Array(WorkjetGatewayAccountSummary),
  pools: Schema.Array(WorkjetGatewayPoolSummary),
  routes: Schema.Array(WorkjetGatewayRouteSummary),
  models: Schema.Array(WorkjetGatewayModelSummary),
});
export type WorkjetGatewayCatalog = typeof WorkjetGatewayCatalog.Type;

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
