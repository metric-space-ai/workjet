import type {
  CapabilityAdapter,
  CapabilityManifest,
  WorkjetCapabilityId,
} from "@t3tools/contracts";

import { GREPPY_RUNTIME_PIN } from "./greppyRuntime.ts";
import { builtInCapabilityManifests } from "./manifests.ts";

/**
 * THE CANONICAL DUAL-HOST CAPABILITY SOURCE.
 *
 * `builtInCapabilityManifests` is the one catalog. This module derives — never
 * restates — everything the two hosts, the release-assembly version lock, the
 * cross-host conformance gate, and both UIs need from it:
 *
 *   - which capabilities are DUAL-HOST at all (derived from `supportedAdapters`),
 *   - the exact manifest and schema projections the version lock digests,
 *   - where each host's copy of each locked dimension physically lives,
 *   - which host-policy differences are ALLOWED, each with a reason,
 *   - the canonical success/error projection both adapters must produce.
 *
 * Nothing here reads the filesystem, the clock, or the network. The
 * `scripts/check-capability-version-lock.ts` CLI supplies the on-disk halves.
 */

export const CAPABILITY_HOSTS = ["code", "ctox"] as const;
export type CapabilityHostId = (typeof CAPABILITY_HOSTS)[number];

/**
 * Adapter → host. The manifest vocabulary is per ADAPTER (`t3-mcp`,
 * `ctox-business-command`, …); the version lock and the conformance gate reason
 * per HOST. This map is the only place that translation is written down.
 */
export const CAPABILITY_HOST_ADAPTERS = {
  code: ["t3-mcp", "t3-prompt"],
  ctox: ["ctox-business-os-mcp", "ctox-business-command"],
} as const satisfies Record<CapabilityHostId, ReadonlyArray<CapabilityAdapter>>;

export const capabilityHostForAdapter = (adapter: CapabilityAdapter): CapabilityHostId =>
  (CAPABILITY_HOST_ADAPTERS.code as ReadonlyArray<CapabilityAdapter>).includes(adapter)
    ? "code"
    : "ctox";

export interface DualHostCapability {
  readonly manifest: CapabilityManifest;
  readonly adaptersByHost: Readonly<Record<CapabilityHostId, ReadonlyArray<CapabilityAdapter>>>;
}

const adaptersForHost = (
  manifest: CapabilityManifest,
  host: CapabilityHostId,
): ReadonlyArray<CapabilityAdapter> =>
  manifest.supportedAdapters.filter((adapter) => capabilityHostForAdapter(adapter) === host);

/**
 * A capability is dual-host when the catalog says it is reachable from at least
 * one adapter on EACH host. Derived, so a new manifest is covered by the lock
 * and the gate the moment it declares both sides.
 */
export const dualHostCapabilities: ReadonlyArray<DualHostCapability> = Object.freeze(
  builtInCapabilityManifests
    .map((manifest) => ({
      manifest,
      adaptersByHost: {
        code: adaptersForHost(manifest, "code"),
        ctox: adaptersForHost(manifest, "ctox"),
      },
    }))
    .filter(
      ({ adaptersByHost }) => adaptersByHost.code.length > 0 && adaptersByHost.ctox.length > 0,
    ),
);

export const dualHostCapabilityIds: ReadonlyArray<WorkjetCapabilityId> = Object.freeze(
  dualHostCapabilities.map(({ manifest }) => manifest.id),
);

export const findDualHostCapability = (capabilityId: string): DualHostCapability | undefined =>
  dualHostCapabilities.find(({ manifest }) => manifest.id === capabilityId);

/**
 * Deterministic JSON with recursively sorted object keys. Two hosts that
 * resolved the same value produce the same bytes regardless of how their own
 * source happened to order its properties, so a digest over this string is a
 * meaningful cross-host comparison rather than a formatting comparison.
 */
export const canonicalCapabilityJson = (value: unknown): string => {
  const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(normalize);
    if (typeof node !== "object" || node === null) return node;
    const record = node as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      sorted[key] = normalize(record[key]);
    }
    return sorted;
  };
  return JSON.stringify(normalize(value));
};

// ---------------------------------------------------------------------------
// Version-lock projections
// ---------------------------------------------------------------------------

export const CAPABILITY_LOCK_DIMENSIONS = [
  "manifest",
  "schemas",
  "implementationRevision",
  "artifactHash",
] as const;
export type CapabilityLockDimension = (typeof CAPABILITY_LOCK_DIMENSIONS)[number];

/**
 * The manifest fields BOTH hosts publish. Deliberately not the whole manifest:
 * the CTOX host publishes its capability inventory through the shared adapter
 * fixture, which carries identity and contract version, not prompt text. A lock
 * that digested fields only one host can produce would compare a value with
 * itself and always pass.
 */
export interface CapabilityManifestLockProjection {
  readonly schemaVersion: number;
  readonly id: string;
  readonly version: string;
  readonly supportedAdapters: ReadonlyArray<string>;
}

export const capabilityManifestLockProjection = (
  manifest: CapabilityManifest,
): CapabilityManifestLockProjection => ({
  schemaVersion: manifest.schemaVersion,
  id: manifest.id,
  version: manifest.version,
  supportedAdapters: [...manifest.supportedAdapters].sort(),
});

export interface CapabilitySchemaLockProjection {
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
}

export const capabilitySchemaLockProjection = (
  manifest: CapabilityManifest,
): CapabilitySchemaLockProjection => ({
  inputSchema: manifest.inputSchema,
  outputSchema: manifest.outputSchema,
});

/**
 * Where one host's copy of one locked dimension physically lives, and whether
 * the two copies can honestly be compared at all.
 *
 * `enforcement: "cross-host"` means two INDEPENDENT sources exist and the check
 * compares them. `enforcement: "unenforceable"` means only one host records the
 * dimension today; `reason` states the evidence. The check REPORTS unenforceable
 * dimensions instead of comparing a value with itself, because a comparison that
 * cannot fail is worse than a documented gap.
 */
export interface CapabilityLockDimensionPolicy {
  readonly enforcement: "cross-host" | "unenforceable";
  readonly codeSource: string;
  readonly ctoxSource: string | null;
  readonly reason: string;
}

export interface CapabilityLockPolicy {
  readonly capabilityId: WorkjetCapabilityId;
  readonly dimensions: Readonly<Record<CapabilityLockDimension, CapabilityLockDimensionPolicy>>;
}

const WEB_STACK_CONTRACT_SOURCE = "native/web-stack/schema/web-stack-tools.v1.json";
const WEB_STACK_FIXTURE_SOURCE = "native/web-stack/fixtures/capability-adapter-v1.json";
const WEB_STACK_BIN_SOURCE = "native/web-stack/src/bin/workjet-web-stack.rs";
const CATALOG_SOURCE = "packages/workjet-capabilities/src/manifests.ts";
const GENERATED_CONTRACT_SOURCE =
  "packages/workjet-capabilities/src/generated/web-stack-tools.v1.ts";
const GREPPY_PIN_SOURCE = "packages/workjet-capabilities/src/greppyRuntime.ts";
const CODE_SURFACE_SOURCE = "apps/server/src/mcp/toolkits/workjet";

const GREPPY_CTOX_GAP =
  "The CTOX host runs its own Greppy runtime. This repository pins Greppy for the Code host only (GREPPY_RUNTIME_PIN); no CTOX-side manifest, schema, revision, or artifact hash for Greppy exists here, so there is no second value to compare.";

const webStackLockPolicy = (capabilityId: WorkjetCapabilityId): CapabilityLockPolicy => ({
  capabilityId,
  dimensions: {
    manifest: {
      enforcement: "cross-host",
      codeSource: CATALOG_SOURCE,
      ctoxSource: WEB_STACK_FIXTURE_SOURCE,
      reason:
        "The Code host resolves identity and contract version from the TypeScript catalog; the CTOX host resolves them from the shared adapter fixture embedded in the ctox-web-stack crate.",
    },
    schemas: {
      enforcement: "cross-host",
      codeSource: GENERATED_CONTRACT_SOURCE,
      ctoxSource: WEB_STACK_CONTRACT_SOURCE,
      reason:
        "The Code host resolves JSON Schemas from the generated TypeScript contract; the CTOX host resolves them from the JSON document the crate embeds with include_str!.",
    },
    implementationRevision: {
      enforcement: "cross-host",
      codeSource: CODE_SURFACE_SOURCE,
      ctoxSource: WEB_STACK_BIN_SOURCE,
      reason:
        "The Code adapter refuses any binary whose --surface-version answer differs from its compiled-in expectation; the shared crate both hosts execute declares those strings. Divergence means Code and CTOX are running different implementations of the same capability.",
    },
    artifactHash: {
      enforcement: "cross-host",
      codeSource: GENERATED_CONTRACT_SOURCE,
      ctoxSource: WEB_STACK_CONTRACT_SOURCE,
      reason:
        "Both hosts carry a byte-level copy of the capability contract artifact. The lock digests each copy independently, so a hand-edit to either one fails release assembly.",
    },
  },
});

export const capabilityLockPolicies: ReadonlyArray<CapabilityLockPolicy> = Object.freeze([
  {
    capabilityId: "greppy",
    dimensions: {
      manifest: {
        enforcement: "unenforceable",
        codeSource: CATALOG_SOURCE,
        ctoxSource: null,
        reason: GREPPY_CTOX_GAP,
      },
      schemas: {
        enforcement: "unenforceable",
        codeSource: CATALOG_SOURCE,
        ctoxSource: null,
        reason: GREPPY_CTOX_GAP,
      },
      implementationRevision: {
        enforcement: "unenforceable",
        codeSource: GREPPY_PIN_SOURCE,
        ctoxSource: null,
        reason: GREPPY_CTOX_GAP,
      },
      artifactHash: {
        enforcement: "unenforceable",
        codeSource: GREPPY_PIN_SOURCE,
        ctoxSource: null,
        reason: GREPPY_CTOX_GAP,
      },
    },
  },
  webStackLockPolicy("web-search"),
  webStackLockPolicy("web-stack-browser"),
] as const satisfies ReadonlyArray<CapabilityLockPolicy>);

export const findCapabilityLockPolicy = (capabilityId: string): CapabilityLockPolicy | undefined =>
  capabilityLockPolicies.find((policy) => policy.capabilityId === capabilityId);

/**
 * The Code host's own record of the Greppy implementation, kept here so the lock
 * digests a derived value instead of a second hand-written copy of the pin.
 */
export const greppyImplementationRevision = `greppy@${GREPPY_RUNTIME_PIN.version}+${GREPPY_RUNTIME_PIN.commit}`;
export const greppyArtifactSha256 = GREPPY_RUNTIME_PIN.sourceSha256;

// ---------------------------------------------------------------------------
// Cross-host conformance: canonical projections and declared host policy
// ---------------------------------------------------------------------------

/**
 * The host-neutral shape of one capability call outcome. Both adapters must
 * project to exactly this; anything a host adds, drops, or renames is a
 * divergence unless it appears in `HOST_POLICY_DIFFERENCES`.
 */
export type CanonicalCapabilityProjection =
  | { readonly outcome: "success"; readonly structuredContent: unknown }
  | { readonly outcome: "error"; readonly errorClass: CanonicalCapabilityErrorClass };

/**
 * The finite canonical error vocabulary. Host-specific reason strings collapse
 * into these classes so two adapters that legitimately word a refusal
 * differently still compare equal, while a host that turns a refusal into a
 * success — or into a different KIND of refusal — fails the gate.
 */
export const CANONICAL_CAPABILITY_ERROR_CLASSES = [
  "invalid-arguments",
  "capability-not-granted",
  "execution-failed",
] as const;
export type CanonicalCapabilityErrorClass = (typeof CANONICAL_CAPABILITY_ERROR_CLASSES)[number];

/**
 * How the CTOX host's half of the conformance comparison is obtained for each
 * dual-host capability. `shared-fixture` means the CTOX projection is read from
 * the Rust-owned adapter fixture that `native/web-stack/tests/capability_contract.rs`
 * independently holds the CTOX host to — a real second source. `unrepresented`
 * is a declared, reasoned gap: the gate still drives the Code adapter, and a NEW
 * dual-host capability with no entry here fails the gate rather than silently
 * being skipped.
 */
export interface CapabilityConformanceCoverage {
  readonly capabilityId: WorkjetCapabilityId;
  readonly ctoxProjectionSource: "shared-fixture" | "unrepresented";
  readonly reason: string;
}

export const capabilityConformanceCoverage: ReadonlyArray<CapabilityConformanceCoverage> =
  Object.freeze([
    {
      capabilityId: "greppy",
      ctoxProjectionSource: "unrepresented",
      reason: GREPPY_CTOX_GAP,
    },
    {
      capabilityId: "web-search",
      ctoxProjectionSource: "shared-fixture",
      reason:
        "native/web-stack/fixtures/capability-adapter-v1.json is the CTOX host's published contract and is separately asserted by native/web-stack/tests/capability_contract.rs.",
    },
    {
      capabilityId: "web-stack-browser",
      ctoxProjectionSource: "shared-fixture",
      reason:
        "native/web-stack/fixtures/capability-adapter-v1.json is the CTOX host's published contract and is separately asserted by native/web-stack/tests/capability_contract.rs.",
    },
  ] as const satisfies ReadonlyArray<CapabilityConformanceCoverage>);

/**
 * The ONLY differences the conformance gate tolerates between the two adapters.
 * Each entry names the capability, the exact property that differs, both host
 * values, and why the difference is a deliberate host policy rather than drift.
 * An observed difference with no entry here fails the gate.
 */
export interface HostPolicyDifference {
  readonly capabilityId: WorkjetCapabilityId | "*";
  readonly property: string;
  readonly codeValue: string;
  readonly ctoxValue: string;
  readonly reason: string;
}

export const HOST_POLICY_DIFFERENCES: ReadonlyArray<HostPolicyDifference> = Object.freeze([
  {
    capabilityId: "*",
    property: "maxResponseBytes",
    codeValue: "2097152",
    ctoxValue: "262144",
    reason:
      "Documented host budget split. The Code host streams a capability answer into a per-thread MCP session and allows 2 MiB (WEB_STACK_RESPONSE_MAX_BYTES); the CTOX host answers over the Business OS MCP control channel and allows 256 KiB. Both budgets are declared together in the shared adapter fixture's hostBudgets array, and the capability host truncates to a still-schema-valid projection rather than failing, so the OUTCOME class is identical on both hosts.",
  },
  {
    capabilityId: "*",
    property: "runtimeConfigStore",
    codeValue: "WorkjetRuntimeConfigStore (host-supplied key/value map)",
    ctoxValue: "CtoxRuntimeConfigStore (runtime/ctox-runtime.sqlite3)",
    reason:
      "State separation is the point of the two-store split: Workjet capability calls must never read CTOX's SQLite runtime configuration. The fixture's stateSeparation block pins this, and it changes no field of the canonical projection.",
  },
  {
    capabilityId: "greppy",
    property: "sessionCwd",
    codeValue: "required (McpSessionCwdUnavailableError when absent)",
    ctoxValue: "not applicable",
    reason:
      "The Code adapter resolves Greppy against the effective per-thread session cwd and refuses without one. The CTOX host has no thread cwd concept; its Greppy runtime is instance-scoped. This is a Code-only precondition, so the gate compares Greppy's canonical projections only for calls that already satisfy it.",
  },
] as const satisfies ReadonlyArray<HostPolicyDifference>);

export const findHostPolicyDifference = (
  capabilityId: string,
  property: string,
): HostPolicyDifference | undefined =>
  HOST_POLICY_DIFFERENCES.find(
    (difference) =>
      (difference.capabilityId === "*" || difference.capabilityId === capabilityId) &&
      difference.property === property,
  );

export interface CapabilityProjectionDivergence {
  readonly capabilityId: string;
  readonly fixtureId: string;
  readonly property: string;
  readonly codeValue: string;
  readonly ctoxValue: string;
}

/**
 * Compare one fixture's two adapter projections. Returns every undeclared
 * difference; an empty array is conformance.
 */
export const compareCapabilityProjections = (input: {
  readonly capabilityId: string;
  readonly fixtureId: string;
  readonly code: CanonicalCapabilityProjection;
  readonly ctox: CanonicalCapabilityProjection;
}): ReadonlyArray<CapabilityProjectionDivergence> => {
  const divergences: Array<CapabilityProjectionDivergence> = [];
  const report = (property: string, codeValue: string, ctoxValue: string): void => {
    if (codeValue === ctoxValue) return;
    if (findHostPolicyDifference(input.capabilityId, property) !== undefined) return;
    divergences.push({
      capabilityId: input.capabilityId,
      fixtureId: input.fixtureId,
      property,
      codeValue,
      ctoxValue,
    });
  };

  report("outcome", input.code.outcome, input.ctox.outcome);
  if (input.code.outcome === "error" && input.ctox.outcome === "error") {
    report("errorClass", input.code.errorClass, input.ctox.errorClass);
  }
  if (input.code.outcome === "success" && input.ctox.outcome === "success") {
    report(
      "structuredContent",
      canonicalCapabilityJson(input.code.structuredContent),
      canonicalCapabilityJson(input.ctox.structuredContent),
    );
  }

  return divergences;
};
