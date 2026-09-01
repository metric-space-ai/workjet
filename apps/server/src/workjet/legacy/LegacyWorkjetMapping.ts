/**
 * Pure mapping from the legacy Swift Workjet configuration onto the current
 * server-authoritative `WorkjetConfiguration` contract.
 *
 * Two rules shape everything here:
 *
 *  1. **Every field gets a visible decision.** {@link LEGACY_WORKJET_MAPPING_TABLE}
 *     names each modelled legacy leaf exactly once — mapped, folded into the
 *     managed prompt, or dropped with a reason — and
 *     {@link LEGACY_WORKJET_DEFAULT_DECISIONS} names each destination that has no
 *     source at all. A test asserts the table covers the reader's field list, so
 *     a new legacy field cannot slip through unmapped.
 *  2. **Nothing is guessed.** Three legacy references point at authorities the
 *     Swift app does not share with Code:
 *       - a computer's transport identity (Code environments own that),
 *       - a provider account (the Workjet provider gateway owns those; a legacy
 *         provider id is a Swift UUID and a legacy `externalCredentialID` is a
 *         CLIProxy account hash — neither is a gateway account id, so neither
 *         can be carried over and resolve),
 *       - a provider POOL, which the settings document does not model at all
 *         (`llmRoutes` are single accounts).
 *     Each one is therefore an operator binding. Without a binding the affected
 *     record is NOT imported and is reported as pending — never bound to a
 *     plausible-looking substitute.
 */

import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  WORKJET_CONFIGURATION_SCHEMA_VERSION,
  WorkjetCapabilityId,
  WorkjetComputerId,
  WorkjetGatewayAccountId,
  WorkjetHarness,
  WorkjetLlmRouteId,
  WorkjetWorkerProfileId,
  type WorkjetComputer,
  type WorkjetConfiguration,
  type WorkjetHarnessConfiguration,
  type WorkjetLlmRoute,
  type WorkjetReasoningSelection,
  type WorkjetWorkerProfile,
} from "@t3tools/contracts";

import {
  LEGACY_WORKJET_FIELD_PATHS,
  type LegacyWorkjetConfig,
  type LegacyWorkjetHarness,
  type LegacyWorkjetReasoningEffort,
  type LegacyWorkjetTransport,
  type LegacyWorkjetWorker,
} from "./LegacyWorkjetConfig.ts";

export interface LegacyWorkjetImportBindings {
  /**
   * Legacy computer id → the Code environment that machine actually is. The
   * legacy SSH/Tailscale connection details are deliberately NOT a source for
   * this: T3 remains the environment authority.
   */
  readonly environmentByComputerId: Readonly<Record<string, EnvironmentId>>;
  /** Legacy provider id → provider-gateway account. */
  readonly gatewayAccountByProviderId: Readonly<Record<string, WorkjetGatewayAccountId>>;
  /** Legacy provider pool name → the single gateway account that stands in for it. */
  readonly gatewayAccountByProviderPool: Readonly<Record<string, WorkjetGatewayAccountId>>;
}

export const EMPTY_LEGACY_WORKJET_BINDINGS: LegacyWorkjetImportBindings = {
  environmentByComputerId: {},
  gatewayAccountByProviderId: {},
  gatewayAccountByProviderPool: {},
};

export type LegacyWorkjetDecisionOutcome =
  /** The source value reached a destination field unchanged or by a total map. */
  | "mapped"
  /** Authored prose with no structured destination, folded into the prompt text. */
  | "mapped-into-prompt"
  /** A destination assembled from more than one source field. */
  | "derived"
  /** Read by the importer, never persisted. */
  | "consumed"
  /** Understood and deliberately not imported. */
  | "dropped"
  /** A destination field that has no source at all; the shown value is a default. */
  | "defaulted"
  /** Needs an operator decision before the owning record can be imported. */
  | "pending-binding"
  /** Present in the document but not modelled by the reader. Never imported. */
  | "unmapped-field";

export interface LegacyWorkjetDecision {
  /** Legacy field path, or `null` for a destination with no source. */
  readonly source: string | null;
  /** Destination path in `WorkjetConfiguration`, or `null` for a drop. */
  readonly destination: string | null;
  readonly outcome: LegacyWorkjetDecisionOutcome;
  readonly reason: string;
}

export type LegacyWorkjetPendingBinding =
  | {
      readonly _tag: "computer-environment";
      readonly computerId: string;
      readonly computerName: string;
      readonly transport: LegacyWorkjetTransport;
      /** Shown so the operator can recognize the machine. Never imported. */
      readonly host: string;
    }
  | {
      readonly _tag: "provider-account";
      readonly providerId: string;
      readonly providerName: string;
      readonly modelProvider: string;
      readonly accountLabel: string | null;
      readonly externalCredentialId: string | null;
      readonly modelIds: readonly string[];
    }
  | {
      readonly _tag: "provider-pool-account";
      readonly pool: string;
      readonly workerIds: readonly string[];
    }
  | {
      readonly _tag: "worker";
      readonly workerId: string;
      readonly workerName: string;
      readonly blockedBy: "computer" | "llm-route" | "invalid-record";
      readonly detail: string;
    };

export interface LegacyWorkjetMappingResult {
  /** What a one-shot import would write into `settings.workjet`. */
  readonly configuration: WorkjetConfiguration;
  /** The static field table plus every record-specific decision, in that order. */
  readonly decisions: readonly LegacyWorkjetDecision[];
  /** Records that could not be imported until an operator supplies a binding. */
  readonly pending: readonly LegacyWorkjetPendingBinding[];
  readonly counts: {
    readonly computersImported: number;
    readonly computersTotal: number;
    readonly llmRoutesImported: number;
    readonly workersImported: number;
    readonly workersTotal: number;
  };
}

const HARNESS_BY_LEGACY: Readonly<Record<LegacyWorkjetHarness, WorkjetHarness>> = {
  "Claude Code": "claude-code",
  "Pi Code": "pi-code",
  "Codex CLI": "codex-cli",
  "Cursor Agent": "cursor-agent",
  OpenCode: "opencode",
  "Grok CLI": "grok-cli",
};

const PRESENTATION_BY_TRANSPORT: Readonly<
  Record<LegacyWorkjetTransport, WorkjetComputer["presentationKind"]>
> = {
  Lokal: "local",
  Tailscale: "tailscale",
  SSH: "ssh",
};

/** Every Swift raw value is shared with the destination; absence is "automatic". */
const REASONING_BY_LEGACY: Readonly<
  Record<LegacyWorkjetReasoningEffort, WorkjetReasoningSelection>
> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
  ultracode: "ultracode",
  ultrathink: "ultrathink",
};

/** Legacy skill id → Workjet capability. `web-stack-browser` has no legacy source. */
const CAPABILITY_BY_LEGACY_SKILL: Readonly<Record<string, WorkjetCapabilityId>> = {
  greppy: "greppy",
  "web-research": "web-search",
};

/**
 * One entry per modelled legacy leaf. Order follows the document, so the table
 * reads like the source file. Kept as data, not code, so the whole mapping
 * policy is reviewable in one place.
 */
export const LEGACY_WORKJET_MAPPING_TABLE: readonly LegacyWorkjetDecision[] = [
  {
    source: "version",
    destination: null,
    outcome: "consumed",
    reason:
      "Gate only. The reader accepts version 1 and nothing else; the destination carries its own schemaVersion.",
  },
  {
    source: "selectedComputerID",
    destination: "selectedComputerId",
    outcome: "mapped",
    reason:
      "The selected legacy computer becomes the persisted current computer when that computer is successfully imported; unresolved references safely become null.",
  },
  {
    source: "skillRules",
    destination: "managedSystemPrompt",
    outcome: "mapped-into-prompt",
    reason: "The orchestrator role text. First section of the composed managed prompt.",
  },
  {
    source: "skillLoaderInstructions",
    destination: null,
    outcome: "dropped",
    reason:
      "Swift-only bootstrap that tells a harness to read ~/.claude/workjet/AGENTS.md. Code compiles the managed prompt through its own managed-prompt path, so a loader stub would be an instruction to read a file Code does not write.",
  },
  {
    source: "modelPrompts",
    destination: "managedSystemPrompt",
    outcome: "mapped-into-prompt",
    reason:
      "Authored per-model rules. The contract has no per-model prompt slot, and the legacy keys mix display names with model ids, so binding them to worker profiles would be a guess. The text is preserved verbatim in a labelled prompt section instead of being discarded.",
  },
  {
    source: "progressBoardRules",
    destination: "managedSystemPrompt",
    outcome: "mapped-into-prompt",
    reason: "Authored progress-board policy. Section of the composed managed prompt.",
  },
  {
    source: "adHocLearnings",
    destination: "managedSystemPrompt",
    outcome: "mapped-into-prompt",
    reason: "Authored learnings. Section of the composed managed prompt.",
  },
  {
    source: "technicalRules",
    destination: "managedSystemPrompt",
    outcome: "mapped-into-prompt",
    reason: "Authored technical rules. Section of the composed managed prompt.",
  },
  {
    source: "transparentWorkerPromptsMigrated",
    destination: null,
    outcome: "dropped",
    reason: "Swift-internal one-shot migration flag. Meaningless outside that app.",
  },
  {
    source: "skillActivation",
    destination: null,
    outcome: "dropped",
    reason:
      "Chooses whether the Swift app installs a global include into ~/.claude or a /workjet skill. Code neither writes nor owns those files.",
  },
  {
    source: "injectWorkerDeclarations",
    destination: null,
    outcome: "dropped",
    reason:
      "Swift prompt-composition switch. Worker declarations are generated from the catalog at session start in Code, so a stored copy would go stale.",
  },
  {
    source: "telemetryClaudeCodeEvents",
    destination: "telemetry.claudeCodeEvents",
    outcome: "mapped",
    reason: "Same meaning on both sides.",
  },
  {
    source: "telemetrySidecarEvents",
    destination: "telemetry.sidecarEvents",
    outcome: "mapped",
    reason: "Same meaning on both sides.",
  },
  {
    source: "telemetryRetentionDays",
    destination: "telemetry.retentionDays",
    outcome: "mapped",
    reason:
      "Same meaning. The destination requires a positive integer; a value outside that range falls back to the typed default and is reported per document.",
  },
  {
    source: "providerSlots",
    destination: null,
    outcome: "dropped",
    reason:
      "Maximum parallel calls per provider. The contract has no such field; concurrency belongs to the provider gateway's pool configuration.",
  },
  {
    source: "probeTimeoutSeconds",
    destination: "execution.probeTimeoutSeconds",
    outcome: "mapped",
    reason: "Same meaning. Positive-integer guard as for retention days.",
  },
  {
    source: "turnTimeoutSeconds",
    destination: "execution.turnTimeoutSeconds",
    outcome: "mapped",
    reason: "Same meaning. Positive-integer guard as for retention days.",
  },
  {
    source: "degradationAllowed",
    destination: "execution.degradationAllowed",
    outcome: "mapped",
    reason: "Same meaning on both sides.",
  },

  {
    source: "computers[].id",
    destination: "computers[].id",
    outcome: "mapped",
    reason: "Carried verbatim so worker profiles keep resolving after the import.",
  },
  {
    source: "computers[].name",
    destination: "computers[].label",
    outcome: "mapped",
    reason: "Operator-facing name, carried verbatim; an empty name falls back to the id.",
  },
  {
    source: "computers[].transport",
    destination: "computers[].presentationKind",
    outcome: "mapped",
    reason:
      "Lokal→local, Tailscale→tailscale, SSH→ssh. Presentation only; the referenced environment stays the transport authority.",
  },
  {
    source: "computers[].host",
    destination: null,
    outcome: "dropped",
    reason:
      "Transport detail. Computers reference a Code environment instead of duplicating SSH, relay, or Tailscale connection data.",
  },
  {
    source: "computers[].user",
    destination: null,
    outcome: "dropped",
    reason: "Transport detail; see computers[].host.",
  },
  {
    source: "computers[].port",
    destination: null,
    outcome: "dropped",
    reason: "Transport detail; see computers[].host.",
  },
  {
    source: "computers[].knownHostsPath",
    destination: null,
    outcome: "dropped",
    reason: "Transport credential path; see computers[].host.",
  },
  {
    source: "computers[].identityFilePath",
    destination: null,
    outcome: "dropped",
    reason: "Transport credential path; see computers[].host.",
  },
  {
    source: "computers[].tailscaleSSHEnabled",
    destination: null,
    outcome: "dropped",
    reason: "Transport detail; see computers[].host.",
  },
  {
    source: "computers[].tailscaleExecutablePath",
    destination: null,
    outcome: "dropped",
    reason: "Transport detail; see computers[].host.",
  },
  {
    source: "computers[].sandboxEnabled",
    destination: null,
    outcome: "dropped",
    reason:
      "Swift sidecar sandboxing. Code sandboxes per provider driver, not per computer record.",
  },
  {
    source: "computers[].bubblewrapExecutablePath",
    destination: null,
    outcome: "dropped",
    reason: "Swift sandbox tooling path; see computers[].sandboxEnabled.",
  },
  {
    source: "computers[].pinnedSidecarVersion",
    destination: null,
    outcome: "dropped",
    reason:
      "Swift SSH/snapshot sidecar deployment state. The plan forbids porting that protocol; T3 is the workspace authority.",
  },
  {
    source: "computers[].sidecarBundlePath",
    destination: null,
    outcome: "dropped",
    reason: "Sidecar deployment state; see computers[].pinnedSidecarVersion.",
  },
  {
    source: "computers[].installedSidecarVersion",
    destination: null,
    outcome: "dropped",
    reason: "Sidecar deployment state; see computers[].pinnedSidecarVersion.",
  },
  {
    source: "computers[].installedContentHash",
    destination: null,
    outcome: "dropped",
    reason: "Sidecar deployment state; see computers[].pinnedSidecarVersion.",
  },
  {
    source: "computers[].deploymentStatus",
    destination: null,
    outcome: "dropped",
    reason: "Observed verification state, not configuration. Re-observed by Code, never imported.",
  },
  {
    source: "computers[].deploymentDetail",
    destination: null,
    outcome: "dropped",
    reason: "Observed verification state; see computers[].deploymentStatus.",
  },
  {
    source: "computers[].remoteSetupIssue",
    destination: null,
    outcome: "dropped",
    reason: "Observed verification state; see computers[].deploymentStatus.",
  },
  {
    source: "computers[].lastSuccessfulPreflightAt",
    destination: null,
    outcome: "dropped",
    reason: "Observed verification state; see computers[].deploymentStatus.",
  },
  {
    source: "computers[].lastSuccessfulDeploymentAt",
    destination: null,
    outcome: "dropped",
    reason: "Observed verification state; see computers[].deploymentStatus.",
  },
  {
    source: "computers[].telemetryEnabled",
    destination: null,
    outcome: "dropped",
    reason:
      "Per-computer telemetry toggle. The contract's telemetry settings are configuration-wide; importing a per-computer value would silently change the meaning.",
  },

  {
    source: "providers[].id",
    destination: "llmRoutes[].id",
    outcome: "mapped",
    reason: "Carried verbatim so worker profiles keep resolving after the import.",
  },
  {
    source: "providers[].name",
    destination: "llmRoutes[].label",
    outcome: "mapped",
    reason: "Operator-facing name, carried verbatim; an empty name falls back to the id.",
  },
  {
    source: "providers[].accountLabel",
    destination: null,
    outcome: "dropped",
    reason:
      "Recognition string for the underlying account. The gateway account carries its own label, so a stale copy would compete with it.",
  },
  {
    source: "providers[].externalCredentialID",
    destination: null,
    outcome: "dropped",
    reason:
      "CLIProxy account hash. It is NOT a Workjet gateway account id (those are slugs from provider-gateway.json), so carrying it over would create a reference that can never resolve. Surfaced in the pending-binding report instead, so the operator can recognize the account.",
  },
  {
    source: "providers[].credentialReference",
    destination: null,
    outcome: "dropped",
    reason: "Swift keychain reference. Credentials belong to the environment-scoped gateway.",
  },
  {
    source: "providers[].kind",
    destination: null,
    outcome: "dropped",
    reason:
      "Direct API vs. CLIProxy. The gateway account decides this now; a route is only a reference.",
  },
  {
    source: "providers[].endpoint",
    destination: null,
    outcome: "dropped",
    reason: "Owned by the gateway account; see providers[].kind.",
  },
  {
    source: "providers[].authentication",
    destination: null,
    outcome: "dropped",
    reason: "Owned by the gateway account; see providers[].kind.",
  },
  {
    source: "providers[].modelProvider",
    destination: null,
    outcome: "dropped",
    reason:
      "Owned by the gateway account. Reported in the pending-binding list so the operator can match the account.",
  },
  {
    source: "providers[].modelIDs",
    destination: null,
    outcome: "dropped",
    reason:
      "The gateway publishes its own model catalog. Reported in the pending-binding list as matching evidence.",
  },
  {
    source: "providers[].loginExecutable",
    destination: null,
    outcome: "dropped",
    reason: "Swift-side login helper. Code drives OAuth through the gateway's own routes.",
  },
  {
    source: "providers[].loginArguments",
    destination: null,
    outcome: "dropped",
    reason: "Swift-side login helper; see providers[].loginExecutable.",
  },
  {
    source: "providers[].routingPriority",
    destination: null,
    outcome: "dropped",
    reason:
      "Belongs to the gateway's pool member configuration (provider-gateway.json), not to the Workjet settings document.",
  },
  {
    source: "providers[].status",
    destination: null,
    outcome: "dropped",
    reason: "Observed probe state, not configuration.",
  },
  {
    source: "providers[].statusDetail",
    destination: null,
    outcome: "dropped",
    reason: "Observed probe state; see providers[].status.",
  },
  {
    source: "providers[].capacity",
    destination: null,
    outcome: "dropped",
    reason:
      "Observed quota/rate signals. The gateway health surface owns capacity and reports its own freshness.",
  },

  {
    source: "workers[].id",
    destination: "workerProfiles[].id",
    outcome: "mapped",
    reason: "Carried verbatim so existing references keep resolving.",
  },
  {
    source: "workers[].name",
    destination: "workerProfiles[].name",
    outcome: "mapped",
    reason: "Operator-facing name, carried verbatim; an empty name falls back to the id.",
  },
  {
    source: "workers[].model",
    destination: "workerProfiles[].modelId",
    outcome: "mapped",
    reason: "Model identifier, carried verbatim.",
  },
  {
    source: "workers[].instructions",
    destination: "workerProfiles[].instructions",
    outcome: "mapped",
    reason: "Authored worker role text. Omitted when empty, which is the contract's default.",
  },
  {
    source: "workers[].reasoningEffort",
    destination: "workerProfiles[].reasoning",
    outcome: "mapped",
    reason:
      'Total map over the shared raw values. The Swift property is an Optional, so an absent effort becomes the destination\'s "automatic".',
  },
  {
    source: "workers[].harness",
    destination: "workerProfiles[].harness",
    outcome: "mapped",
    reason:
      "Total map over the same six harnesses. Also contributes the computer's harness availability list.",
  },
  {
    source: "workers[].computerID",
    destination: "workerProfiles[].computerId",
    outcome: "mapped",
    reason:
      "Carried verbatim. A worker whose computer was not imported is not imported either, and is reported.",
  },
  {
    source: "workers[].providerID",
    destination: "workerProfiles[].llmRouteId",
    outcome: "mapped",
    reason: "Direct provider reference becomes the route id of the imported provider.",
  },
  {
    source: "workers[].providerPool",
    destination: "workerProfiles[].llmRouteId",
    outcome: "pending-binding",
    reason:
      "A pool is an ordered set of accounts; the contract's llmRoutes are single accounts, so there is no faithful destination. The operator binds one gateway account per pool and the narrowing is reported; without a binding the worker is not imported.",
  },
  {
    source: "workers[].skillOverrides",
    destination: "workerProfiles[].capabilityIds",
    outcome: "mapped",
    reason:
      "Enabled skills only: greppy→greppy, web-research→web-search. A disabled entry maps to absence. Any other skill id is reported as an unmapped field.",
  },
  {
    source: "workers[].invocation.executable",
    destination: "computers[].harnesses[].executableOverride",
    outcome: "derived",
    reason:
      "The legacy executable is per worker; the contract's override is per computer and harness. Applied when every worker on that computer/harness agrees, otherwise dropped and the conflict reported.",
  },
  {
    source: "workers[].invocation.arguments",
    destination: null,
    outcome: "dropped",
    reason:
      "Swift argv for launching the harness. Code owns harness invocation, so importing an argv would fight the harness adapter.",
  },
  {
    source: "workers[].invocation.capabilities",
    destination: null,
    outcome: "dropped",
    reason: "Free-text capability blurbs used for display only in the Swift UI.",
  },
  {
    source: "workers[].invocation.options",
    destination: null,
    outcome: "dropped",
    reason: "Swift harness options (for example fastMode). No destination field exists.",
  },
  {
    source: "workers[].capacity",
    destination: null,
    outcome: "dropped",
    reason: "Observed capacity; see providers[].capacity.",
  },

  {
    source: "cliProxy.endpoint",
    destination: null,
    outcome: "dropped",
    reason:
      "The environment-scoped provider gateway owns its own endpoint. Importing the Swift app's would point Code at a runtime it does not manage.",
  },
  {
    source: "cliProxy.inferenceCredentialReference",
    destination: null,
    outcome: "dropped",
    reason: "Credential reference; owned by the gateway. See cliProxy.endpoint.",
  },
  {
    source: "cliProxy.managementCredentialReference",
    destination: null,
    outcome: "dropped",
    reason: "Credential reference; owned by the gateway. See cliProxy.endpoint.",
  },
  {
    source: "cliProxy.usageStatisticsEnabled",
    destination: null,
    outcome: "dropped",
    reason: "Gateway usage-statistics switch; owned by the gateway. See cliProxy.endpoint.",
  },
];

/** Destinations with no legacy source. Their values are defaults, stated out loud. */
export const LEGACY_WORKJET_DEFAULT_DECISIONS: readonly LegacyWorkjetDecision[] = [
  {
    source: null,
    destination: "schemaVersion",
    outcome: "defaulted",
    reason: `The import always writes the current configuration schema version (${WORKJET_CONFIGURATION_SCHEMA_VERSION}).`,
  },
  {
    source: null,
    destination: "computers[].environmentId",
    outcome: "defaulted",
    reason:
      "No legacy source: the Swift model identifies a machine by SSH/Tailscale details, not by a Code environment. Supplied per computer as an operator binding; unbound computers are not imported.",
  },
  {
    source: null,
    destination: "computers[].harnesses[].available",
    outcome: "defaulted",
    reason:
      "Always false. The legacy model never recorded verified per-computer harness availability, so a true here would be a claim the source cannot support. Live inspection sets it later.",
  },
  {
    source: null,
    destination: "llmRoutes[].gatewayAccountId",
    outcome: "defaulted",
    reason:
      "No legacy source can resolve: gateway account ids come from the environment's provider-gateway configuration. Supplied as an operator binding; unbound providers are not imported.",
  },
  {
    source: null,
    destination: 'workerProfiles[].capabilityIds ("web-stack-browser")',
    outcome: "defaulted",
    reason: "The legacy skill model has no web-stack-browser equivalent, so it is never enabled.",
  },
];

const PROMPT_SECTION_HEADINGS = {
  progressBoardRules: "## Progress board",
  adHocLearnings: "## Ad-hoc learnings",
  technicalRules: "## Technical rules",
  modelPrompts: "## Model rules (imported from the legacy Workjet configuration)",
} as const;

/**
 * Compose the four authored prose blocks plus the per-model rules into one
 * managed prompt. Empty blocks are skipped and model rules are sorted by key, so
 * the same document always produces the same text.
 */
export function composeManagedSystemPrompt(config: LegacyWorkjetConfig): string {
  const sections: string[] = [];
  const push = (heading: string | undefined, body: string): void => {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    sections.push(heading === undefined ? trimmed : `${heading}\n\n${trimmed}`);
  };

  push(undefined, config.skillRules);
  push(PROMPT_SECTION_HEADINGS.progressBoardRules, config.progressBoardRules);
  push(PROMPT_SECTION_HEADINGS.adHocLearnings, config.adHocLearnings);
  push(PROMPT_SECTION_HEADINGS.technicalRules, config.technicalRules);

  const modelEntries = Object.entries(config.modelPrompts)
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => value.length > 0)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (modelEntries.length > 0) {
    push(
      PROMPT_SECTION_HEADINGS.modelPrompts,
      modelEntries.map(([key, value]) => `### ${key}\n\n${value}`).join("\n\n"),
    );
  }

  return sections.join("\n\n");
}

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value >= 1;

/**
 * Take a positive-integer setting or fall back to the contract default, saying
 * so. The destination checks `Schema.Int` plus a lower bound, and the legacy
 * document is plain JSON, so a bad value has to be caught before it is written.
 */
const positiveIntegerOr = (
  value: number,
  fallback: number,
  sourcePath: string,
  destinationPath: string,
  decisions: LegacyWorkjetDecision[],
): number => {
  if (isPositiveInteger(value)) return value;
  decisions.push({
    source: sourcePath,
    destination: destinationPath,
    outcome: "defaulted",
    reason: `The legacy value is not a positive integer, so the typed default ${fallback} is written instead.`,
  });
  return fallback;
};

const trimmedOrNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

interface HarnessUsage {
  readonly harness: WorkjetHarness;
  readonly executables: Set<string>;
}

/**
 * Map a legacy configuration onto the current contract.
 *
 * Pure: the same document and bindings always produce the same result. Nothing
 * about the legacy source is modified, and nothing is written anywhere.
 */
export function mapLegacyWorkjetConfig(input: {
  readonly config: LegacyWorkjetConfig;
  readonly unknownFields: readonly string[];
  readonly bindings: LegacyWorkjetImportBindings;
}): LegacyWorkjetMappingResult {
  const { config, bindings } = input;
  const decisions: LegacyWorkjetDecision[] = [
    ...LEGACY_WORKJET_MAPPING_TABLE,
    ...LEGACY_WORKJET_DEFAULT_DECISIONS,
  ];
  const pending: LegacyWorkjetPendingBinding[] = [];

  for (const path of [...input.unknownFields].sort()) {
    decisions.push({
      source: path,
      destination: null,
      outcome: "unmapped-field",
      reason:
        "Present in the legacy document but not modelled by this reader, so it has no mapping and is not imported. Reported so a field a newer Swift build added cannot disappear unnoticed.",
    });
  }

  // ---------------------------------------------------------------- computers

  // Harness availability and executable overrides are a per-computer view of a
  // per-worker legacy field, so they are collected before the computers are built.
  const harnessUsageByComputer = new Map<string, Map<WorkjetHarness, HarnessUsage>>();
  for (const worker of config.workers) {
    const harness = HARNESS_BY_LEGACY[worker.harness];
    const perComputer = harnessUsageByComputer.get(worker.computerID) ?? new Map();
    const usage = perComputer.get(harness) ?? { harness, executables: new Set<string>() };
    const executable = worker.invocation.executable.trim();
    if (executable.length > 0) usage.executables.add(executable);
    perComputer.set(harness, usage);
    harnessUsageByComputer.set(worker.computerID, perComputer);
  }

  const computers: WorkjetComputer[] = [];
  const importedComputerIds = new Set<string>();
  for (const computer of config.computers) {
    const id = computer.id.trim();
    const environmentId = bindings.environmentByComputerId[computer.id];
    if (id.length === 0) {
      decisions.push({
        source: `computers[id=${computer.id}]`,
        destination: null,
        outcome: "dropped",
        reason: "The record has an empty id, which the contract's branded id rejects.",
      });
      continue;
    }
    if (environmentId === undefined) {
      pending.push({
        _tag: "computer-environment",
        computerId: id,
        computerName: computer.name,
        transport: computer.transport,
        host: computer.host,
      });
      decisions.push({
        source: `computers[id=${id}]`,
        destination: null,
        outcome: "pending-binding",
        reason:
          "No Code environment is bound to this legacy computer. Importing it would either invent an environment id or copy the legacy SSH/Tailscale details, and both are forbidden.",
      });
      continue;
    }

    const harnesses: WorkjetHarnessConfiguration[] = [];
    for (const usage of harnessUsageByComputer.get(computer.id)?.values() ?? []) {
      const executables = [...usage.executables].sort();
      if (executables.length > 1) {
        decisions.push({
          source: `workers[computerID=${id},harness=${usage.harness}].invocation.executable`,
          destination: `computers[id=${id}].harnesses[${usage.harness}].executableOverride`,
          outcome: "dropped",
          reason: `Workers on this computer declare ${executables.length} different executables for the same harness, so no single override is faithful.`,
        });
      }
      harnesses.push({
        harness: usage.harness,
        available: false,
        ...(executables.length === 1 ? { executableOverride: executables[0] as string } : {}),
      });
    }
    harnesses.sort((left, right) => (left.harness < right.harness ? -1 : 1));

    computers.push({
      id: WorkjetComputerId.make(id),
      label: trimmedOrNull(computer.name) ?? id,
      environmentId,
      presentationKind: PRESENTATION_BY_TRANSPORT[computer.transport],
      harnesses,
    });
    importedComputerIds.add(computer.id);
  }

  // --------------------------------------------------------------- llm routes

  const llmRoutes: WorkjetLlmRoute[] = [];
  const routeIdByProviderId = new Map<string, string>();
  for (const provider of config.providers) {
    const id = provider.id.trim();
    const gatewayAccountId = bindings.gatewayAccountByProviderId[provider.id];
    if (id.length === 0) {
      decisions.push({
        source: `providers[id=${provider.id}]`,
        destination: null,
        outcome: "dropped",
        reason: "The record has an empty id, which the contract's branded id rejects.",
      });
      continue;
    }
    if (gatewayAccountId === undefined) {
      pending.push({
        _tag: "provider-account",
        providerId: id,
        providerName: provider.name,
        modelProvider: provider.modelProvider,
        accountLabel: trimmedOrNull(provider.accountLabel),
        externalCredentialId: trimmedOrNull(provider.externalCredentialID),
        modelIds: provider.modelIDs,
      });
      decisions.push({
        source: `providers[id=${id}]`,
        destination: null,
        outcome: "pending-binding",
        reason:
          "No provider-gateway account is bound to this legacy provider. Neither the Swift id nor the CLIProxy account hash is a gateway account id, so nothing can be carried over that would resolve.",
      });
      continue;
    }
    llmRoutes.push({
      id: WorkjetLlmRouteId.make(id),
      label: trimmedOrNull(provider.name) ?? id,
      gatewayAccountId,
    });
    routeIdByProviderId.set(provider.id, id);
  }

  // Pools are referenced by workers, not stored as records, so the synthetic
  // routes are collected from the worker list.
  const workerIdsByPool = new Map<string, string[]>();
  for (const worker of config.workers) {
    const pool = trimmedOrNull(worker.providerPool);
    if (pool === null) continue;
    workerIdsByPool.set(pool, [...(workerIdsByPool.get(pool) ?? []), worker.id]);
  }
  const routeIdByPool = new Map<string, string>();
  for (const [pool, workerIds] of [...workerIdsByPool.entries()].sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    const gatewayAccountId = bindings.gatewayAccountByProviderPool[pool];
    if (gatewayAccountId === undefined) {
      pending.push({ _tag: "provider-pool-account", pool, workerIds });
      decisions.push({
        source: `workers[providerPool=${pool}]`,
        destination: null,
        outcome: "pending-binding",
        reason: `No gateway account is bound to the legacy pool "${pool}". ${workerIds.length} worker(s) stay unimported rather than being bound to an arbitrary member of the pool.`,
      });
      continue;
    }
    const routeId = `pool:${pool}`;
    llmRoutes.push({
      id: WorkjetLlmRouteId.make(routeId),
      label: `${pool} (pool)`,
      gatewayAccountId,
    });
    routeIdByPool.set(pool, routeId);
    decisions.push({
      source: `workers[providerPool=${pool}]`,
      destination: `llmRoutes[id=${routeId}]`,
      outcome: "derived",
      reason:
        "A synthetic single-account route stands in for the legacy pool. Pool failover across several accounts is NOT preserved: the contract has no pool, so the import narrows the pool to the one bound account.",
    });
  }

  // ------------------------------------------------------------------ workers

  const workerProfiles: WorkjetWorkerProfile[] = [];
  for (const worker of config.workers) {
    const profile = mapWorker({ worker, importedComputerIds, routeIdByProviderId, routeIdByPool });
    if (profile._tag === "blocked") {
      pending.push({
        _tag: "worker",
        workerId: worker.id,
        workerName: worker.name,
        blockedBy: profile.blockedBy,
        detail: profile.detail,
      });
      decisions.push({
        source: `workers[id=${worker.id}]`,
        destination: null,
        outcome: profile.blockedBy === "invalid-record" ? "dropped" : "pending-binding",
        reason: profile.detail,
      });
      continue;
    }
    for (const skill of profile.unknownSkills) {
      decisions.push({
        source: `workers[id=${worker.id}].skillOverrides.${skill}`,
        destination: null,
        outcome: "unmapped-field",
        reason:
          "The legacy skill id has no Workjet capability. Reported rather than dropped, because enabling the wrong capability is worse than enabling none.",
      });
    }
    workerProfiles.push(profile.profile);
  }

  // --------------------------------------------------------------- scalars

  const telemetryDefaults = DEFAULT_WORKJET_CONFIGURATION.telemetry;
  const executionDefaults = DEFAULT_WORKJET_CONFIGURATION.execution;

  const selectedComputerId = config.selectedComputerID.trim();
  const configuration: WorkjetConfiguration = {
    schemaVersion: WORKJET_CONFIGURATION_SCHEMA_VERSION,
    computers,
    selectedComputerId: computers.some((computer) => computer.id === selectedComputerId)
      ? WorkjetComputerId.make(selectedComputerId)
      : null,
    modelPrompts: [],
    llmRoutes,
    workerProfiles,
    workerGraph: { positions: [], dependencies: [] },
    managedSystemPrompt: composeManagedSystemPrompt(config),
    managerThreadReference: "",
    telemetry: {
      claudeCodeEvents: config.telemetryClaudeCodeEvents,
      sidecarEvents: config.telemetrySidecarEvents,
      retentionDays: positiveIntegerOr(
        config.telemetryRetentionDays,
        telemetryDefaults.retentionDays,
        "telemetryRetentionDays",
        "telemetry.retentionDays",
        decisions,
      ),
    },
    execution: {
      probeTimeoutSeconds: positiveIntegerOr(
        config.probeTimeoutSeconds,
        executionDefaults.probeTimeoutSeconds,
        "probeTimeoutSeconds",
        "execution.probeTimeoutSeconds",
        decisions,
      ),
      turnTimeoutSeconds: positiveIntegerOr(
        config.turnTimeoutSeconds,
        executionDefaults.turnTimeoutSeconds,
        "turnTimeoutSeconds",
        "execution.turnTimeoutSeconds",
        decisions,
      ),
      degradationAllowed: config.degradationAllowed,
    },
  };

  return {
    configuration,
    decisions,
    pending,
    counts: {
      computersImported: computers.length,
      computersTotal: config.computers.length,
      llmRoutesImported: llmRoutes.length,
      workersImported: workerProfiles.length,
      workersTotal: config.workers.length,
    },
  };
}

type MappedWorker =
  | {
      readonly _tag: "mapped";
      readonly profile: WorkjetWorkerProfile;
      readonly unknownSkills: readonly string[];
    }
  | {
      readonly _tag: "blocked";
      readonly blockedBy: "computer" | "llm-route" | "invalid-record";
      readonly detail: string;
    };

const mapWorker = (input: {
  readonly worker: LegacyWorkjetWorker;
  readonly importedComputerIds: ReadonlySet<string>;
  readonly routeIdByProviderId: ReadonlyMap<string, string>;
  readonly routeIdByPool: ReadonlyMap<string, string>;
}): MappedWorker => {
  const { worker } = input;
  const id = worker.id.trim();
  const modelId = worker.model.trim();
  if (id.length === 0 || modelId.length === 0) {
    return {
      _tag: "blocked",
      blockedBy: "invalid-record",
      detail:
        "The worker has an empty id or model, and both are required non-empty by the destination contract.",
    };
  }
  if (!input.importedComputerIds.has(worker.computerID)) {
    return {
      _tag: "blocked",
      blockedBy: "computer",
      detail: `The worker's computer "${worker.computerID}" was not imported, so its computerId reference would dangle.`,
    };
  }

  const pool = trimmedOrNull(worker.providerPool);
  const providerId = trimmedOrNull(worker.providerID);
  const routeId =
    providerId !== null
      ? input.routeIdByProviderId.get(worker.providerID as string)
      : pool !== null
        ? input.routeIdByPool.get(pool)
        : undefined;
  if (routeId === undefined) {
    return {
      _tag: "blocked",
      blockedBy: "llm-route",
      detail:
        providerId === null && pool === null
          ? "The worker names neither a provider nor a pool, and the destination requires an LLM route."
          : "The worker's provider account or pool has no bound gateway account, so its llmRouteId would dangle.",
    };
  }

  const unknownSkills: string[] = [];
  const capabilityIds: WorkjetCapabilityId[] = [];
  for (const [skill, enabled] of Object.entries(worker.skillOverrides).sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    const capability = CAPABILITY_BY_LEGACY_SKILL[skill];
    if (capability === undefined) {
      unknownSkills.push(skill);
      continue;
    }
    if (enabled) capabilityIds.push(capability);
  }

  const instructions = worker.instructions.trim();
  return {
    _tag: "mapped",
    unknownSkills,
    profile: {
      id: WorkjetWorkerProfileId.make(id),
      name: trimmedOrNull(worker.name) ?? id,
      ...(instructions.length > 0 ? { instructions } : {}),
      computerId: WorkjetComputerId.make(worker.computerID.trim()),
      harness: HARNESS_BY_LEGACY[worker.harness],
      llmRouteId: WorkjetLlmRouteId.make(routeId),
      modelId,
      reasoning:
        worker.reasoningEffort === undefined
          ? "automatic"
          : REASONING_BY_LEGACY[worker.reasoningEffort],
      capabilityIds,
      role: "standard",
      capabilityBindings: [],
    },
  };
};

/** Legacy leaf paths this mapping accounts for. Asserted against the reader. */
export const LEGACY_WORKJET_MAPPED_FIELD_PATHS: readonly string[] =
  LEGACY_WORKJET_MAPPING_TABLE.map((decision) => decision.source).filter(
    (source): source is string => source !== null,
  );

/** Reader field paths with no entry in the mapping table. Must always be empty. */
export const legacyWorkjetFieldsWithoutDecision = (): readonly string[] => {
  const mapped = new Set(LEGACY_WORKJET_MAPPED_FIELD_PATHS);
  return LEGACY_WORKJET_FIELD_PATHS.filter((path) => !mapped.has(path));
};
