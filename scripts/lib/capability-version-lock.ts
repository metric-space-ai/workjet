import {
  canonicalCapabilityJson,
  capabilityLockPolicies,
  CAPABILITY_LOCK_DIMENSIONS,
  dualHostCapabilities,
  greppyArtifactSha256,
  greppyImplementationRevision,
  WEB_STACK_TOOLS,
  type CapabilityLockDimension,
  type CapabilityLockDimensionPolicy,
} from "@metric-space-ai/workjet-capabilities";

/**
 * THE CANONICAL CAPABILITY VERSION LOCK.
 *
 * One capability is defined once, in `packages/workjet-capabilities`, and is
 * then resolved twice: by the Code host (T3 MCP toolkit) and by the CTOX host
 * (Business OS MCP over the shared `ctox-web-stack` capability core). This
 * module derives, for every dual-host capability, what each host resolves along
 * four dimensions — manifest, JSON schemas, implementation revision, artifact
 * hash — and reports every divergence. `scripts/check-capability-version-lock.ts`
 * supplies the on-disk halves and fails release assembly on any divergence.
 *
 * Every function here is pure: same inputs, same lock bytes. Nothing reads the
 * filesystem, the clock, or the network.
 *
 * WHY SOME DIMENSIONS ARE `unenforceable`. A comparison needs two independent
 * values. Where only one host records a dimension in this repository (Greppy:
 * the CTOX host runs its own Greppy runtime and pins nothing here), the lock
 * records the Code value, marks the dimension unenforceable, and carries the
 * reason. It deliberately does NOT compare the single value with itself, which
 * would render a check that can never fail.
 */

export const CAPABILITY_VERSION_LOCK_FILENAME = "capability-version-lock.json";
export const CAPABILITY_VERSION_LOCK_SCHEMA = "workjet.capability-version-lock.v1";

export const WEB_STACK_CONTRACT_PATH = "native/web-stack/schema/web-stack-tools.v1.json";
export const WEB_STACK_FIXTURE_PATH = "native/web-stack/fixtures/capability-adapter-v1.json";
export const WEB_STACK_BIN_PATH = "native/web-stack/src/bin/workjet-web-stack.rs";
export const GENERATED_CONTRACT_PATH =
  "packages/workjet-capabilities/src/generated/web-stack-tools.v1.ts";
export const CTOX_SHELL_MANIFEST_PATH =
  "apps/desktop/resources/ctox/business-os-shell.manifest.json";

/**
 * Which compiled-in surface-version expectation the Code adapter enforces for
 * each capability, and therefore which crate-declared surface strings the CTOX
 * host must be running. `apps/server` refuses any binary whose
 * `--surface-version` answer differs, so a mismatch here means the two hosts
 * would execute different implementations of the same capability.
 */
export const CAPABILITY_SURFACE_CONSTANTS = {
  "web-search": ["SEARCH_SURFACE_VERSION", "RESEARCH_SURFACE_VERSION"],
  "web-stack-browser": ["BROWSER_SURFACE_VERSION"],
} as const;

/** The `apps/server` file and exported constant that carries each expectation. */
export const CODE_SURFACE_EXPECTATIONS = {
  SEARCH_SURFACE_VERSION: {
    file: "apps/server/src/mcp/toolkits/workjet/WebStackSearch.ts",
    constant: "WEB_STACK_SURFACE_VERSION",
  },
  RESEARCH_SURFACE_VERSION: {
    file: "apps/server/src/mcp/toolkits/workjet/WebStackResearch.ts",
    constant: "WEB_STACK_RESEARCH_SURFACE_VERSION",
  },
  BROWSER_SURFACE_VERSION: {
    file: "apps/server/src/mcp/toolkits/workjet/WebStackBrowser.ts",
    constant: "WEB_STACK_BROWSER_SURFACE_VERSION",
  },
} as const;

export type SurfaceConstantName = keyof typeof CODE_SURFACE_EXPECTATIONS;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface WebStackToolDocument {
  readonly name: string;
  readonly capabilityId: string;
  readonly contractVersion: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
}

export interface WebStackContractDocument {
  readonly schemaVersion: number;
  readonly tools: ReadonlyArray<WebStackToolDocument>;
}

export interface WebStackAdapterFixture {
  readonly schemaVersion: number;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly capabilityId: string;
    readonly contractVersion: string;
  }>;
}

export interface CtoxHostArtifactManifest {
  readonly schema: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly archiveSha256: string;
  readonly embeddedManifestSha256: string;
  readonly manifestSha256: string;
}

/**
 * Everything the check reads from disk, already parsed. Passing it in keeps the
 * model pure and makes the mutation tests trivial: flip one field, assert the
 * comparison fails.
 */
export interface CapabilityVersionLockInputs {
  /** `native/web-stack/schema/web-stack-tools.v1.json` — the CTOX crate's embedded contract. */
  readonly ctoxContract: WebStackContractDocument;
  /** `native/web-stack/fixtures/capability-adapter-v1.json` — the CTOX host's published inventory. */
  readonly ctoxFixture: WebStackAdapterFixture;
  /** Surface-version strings declared by the shared crate binary. */
  readonly ctoxSurfaceVersions: Readonly<Record<string, string>>;
  /** Surface-version strings the Code adapter compiles in and enforces. */
  readonly codeSurfaceVersions: Readonly<Record<string, string>>;
  /** sha256 of `packages/workjet-capabilities/src/generated/web-stack-tools.v1.ts`. */
  readonly codeContractArtifactSha256: string;
  /** sha256 of `native/web-stack/schema/web-stack-tools.v1.json`. */
  readonly ctoxContractArtifactSha256: string;
  /**
   * Whether the Code artifact is byte-current with the CTOX artifact, as decided
   * by `packages/workjet-capabilities/scripts/generate-web-stack-contract.mjs --check`.
   * The two artifacts are different formats, so equality of their raw digests is
   * meaningless; regeneration is the honest equivalence test.
   */
  readonly codeContractArtifactIsByteCurrent: boolean;
  /** The pinned CTOX host artifact this repository assembles into the release. */
  readonly ctoxHostArtifact: CtoxHostArtifactManifest;
  /** sha256 over an arbitrary UTF-8 string. Injected so the model stays pure. */
  readonly sha256: (value: string) => string;
}

// ---------------------------------------------------------------------------
// Output document
// ---------------------------------------------------------------------------

export interface CapabilityLockDimensionRecord {
  readonly enforcement: CapabilityLockDimensionPolicy["enforcement"];
  readonly code: string;
  readonly ctox: string | null;
  readonly codeSource: string;
  readonly ctoxSource: string | null;
  readonly reason: string;
}

export interface CapabilityLockRecord {
  readonly capabilityId: string;
  readonly version: string;
  readonly adapters: {
    readonly code: ReadonlyArray<string>;
    readonly ctox: ReadonlyArray<string>;
  };
  readonly dimensions: Readonly<Record<CapabilityLockDimension, CapabilityLockDimensionRecord>>;
}

export interface CapabilityVersionLockDocument {
  readonly schema: string;
  readonly generator: string;
  readonly ctoxHostArtifact: CtoxHostArtifactManifest;
  readonly capabilities: ReadonlyArray<CapabilityLockRecord>;
}

export interface CapabilityLockDivergence {
  readonly capabilityId: string;
  readonly dimension: CapabilityLockDimension;
  readonly codeValue: string;
  readonly ctoxValue: string;
  readonly codeSource: string;
  readonly ctoxSource: string;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const toolsForCapability = (
  tools: ReadonlyArray<{ readonly capabilityId: string; readonly name: string }>,
  capabilityId: string,
): ReadonlyArray<string> =>
  tools
    .filter((tool) => tool.capabilityId === capabilityId)
    .map((tool) => tool.name)
    .sort();

const contractVersionForCapability = (
  tools: ReadonlyArray<{ readonly capabilityId: string; readonly contractVersion: string }>,
  capabilityId: string,
): string | null => {
  const versions = [
    ...new Set(
      tools
        .filter((tool) => tool.capabilityId === capabilityId)
        .map((tool) => tool.contractVersion),
    ),
  ].sort();
  return versions.length === 1 ? (versions[0] as string) : versions.length === 0 ? null : versions.join("|");
};

const schemasForCapability = (
  tools: ReadonlyArray<WebStackToolDocument>,
  capabilityId: string,
): ReadonlyArray<unknown> =>
  tools
    .filter((tool) => tool.capabilityId === capabilityId)
    .map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

const surfaceValue = (
  versions: Readonly<Record<string, string>>,
  names: ReadonlyArray<string>,
): string => names.map((name) => `${name}=${(versions[name] ?? "<missing>").trim()}`).join(" ");

const dimensionRecord = (
  policy: CapabilityLockDimensionPolicy,
  code: string,
  ctox: string | null,
): CapabilityLockDimensionRecord => ({
  enforcement: policy.enforcement,
  code,
  ctox: policy.enforcement === "cross-host" ? ctox : null,
  codeSource: policy.codeSource,
  ctoxSource: policy.enforcement === "cross-host" ? policy.ctoxSource : null,
  reason: policy.reason,
});

export class CapabilityLockPolicyMissingError extends Error {
  readonly capabilityId: string;

  constructor(capabilityId: string) {
    super(
      `No capability lock policy for dual-host capability '${capabilityId}'. Every dual-host capability must declare, in packages/workjet-capabilities/src/dualHost.ts, where each host resolves each of the four locked dimensions — or state, with evidence, that a dimension is unenforceable.`,
    );
    this.capabilityId = capabilityId;
    this.name = "CapabilityLockPolicyMissingError";
  }
}

/**
 * Resolve both hosts for every dual-host capability and render the canonical
 * lock document. Deterministic: the same inputs always render the same bytes.
 */
export const resolveCapabilityVersionLock = (
  inputs: CapabilityVersionLockInputs,
): CapabilityVersionLockDocument => {
  const capabilities = dualHostCapabilities.map(({ manifest, adaptersByHost }) => {
    const policy = capabilityLockPolicies.find(
      (candidate) => candidate.capabilityId === manifest.id,
    );
    if (policy === undefined) throw new CapabilityLockPolicyMissingError(manifest.id);

    // MANIFEST. The Code host publishes identity, version, and tool inventory
    // from the TypeScript catalog it compiles in. The CTOX host publishes them
    // from the shared adapter fixture the `ctox-web-stack` crate embeds. Two
    // sources, so the comparison can actually fail.
    const codeManifest = canonicalCapabilityJson({
      capabilityId: manifest.id,
      contractVersion: manifest.version,
      toolNames: toolsForCapability(WEB_STACK_TOOLS, manifest.id),
    });
    const ctoxFixtureVersion = contractVersionForCapability(inputs.ctoxFixture.tools, manifest.id);
    const ctoxManifest =
      ctoxFixtureVersion === null
        ? null
        : canonicalCapabilityJson({
            capabilityId: manifest.id,
            contractVersion: ctoxFixtureVersion,
            toolNames: toolsForCapability(inputs.ctoxFixture.tools, manifest.id),
          });

    // SCHEMAS. Code resolves them through the generated TypeScript contract that
    // the MCP toolkit registers as its `tools/list` schemas; CTOX resolves them
    // from the JSON document the crate embeds with `include_str!`. For a
    // capability with no Web Stack tools the Code host's schemas are the
    // manifest's own, and there is no second source (see the lock policy).
    const codeCapabilitySchemas = schemasForCapability(
      WEB_STACK_TOOLS as unknown as ReadonlyArray<WebStackToolDocument>,
      manifest.id,
    );
    const codeSchemas = inputs.sha256(
      canonicalCapabilityJson(
        codeCapabilitySchemas.length > 0
          ? { tools: codeCapabilitySchemas }
          : {
              tools: [
                {
                  name: manifest.id,
                  inputSchema: manifest.inputSchema,
                  outputSchema: manifest.outputSchema,
                },
              ],
            },
      ),
    );
    const ctoxCapabilitySchemas = schemasForCapability(inputs.ctoxContract.tools, manifest.id);
    const ctoxSchemas =
      ctoxCapabilitySchemas.length > 0
        ? inputs.sha256(canonicalCapabilityJson({ tools: ctoxCapabilitySchemas }))
        : null;

    const surfaceNames =
      manifest.id in CAPABILITY_SURFACE_CONSTANTS
        ? CAPABILITY_SURFACE_CONSTANTS[manifest.id as keyof typeof CAPABILITY_SURFACE_CONSTANTS]
        : [];

    const codeRevision =
      manifest.id === "greppy"
        ? greppyImplementationRevision
        : surfaceValue(inputs.codeSurfaceVersions, surfaceNames);
    const ctoxRevision =
      manifest.id === "greppy" ? null : surfaceValue(inputs.ctoxSurfaceVersions, surfaceNames);

    const codeArtifact =
      manifest.id === "greppy" ? greppyArtifactSha256 : inputs.codeContractArtifactSha256;
    const ctoxArtifact = manifest.id === "greppy" ? null : inputs.ctoxContractArtifactSha256;

    return {
      capabilityId: manifest.id,
      version: manifest.version,
      adapters: {
        code: [...adaptersByHost.code],
        ctox: [...adaptersByHost.ctox],
      },
      dimensions: {
        manifest: dimensionRecord(policy.dimensions.manifest, codeManifest, ctoxManifest),
        schemas: dimensionRecord(policy.dimensions.schemas, codeSchemas, ctoxSchemas),
        implementationRevision: dimensionRecord(
          policy.dimensions.implementationRevision,
          codeRevision,
          ctoxRevision,
        ),
        artifactHash: dimensionRecord(
          policy.dimensions.artifactHash,
          codeArtifact,
          ctoxArtifact,
        ),
      },
    } satisfies CapabilityLockRecord;
  });

  return {
    schema: CAPABILITY_VERSION_LOCK_SCHEMA,
    generator: "scripts/check-capability-version-lock.ts",
    ctoxHostArtifact: inputs.ctoxHostArtifact,
    capabilities,
  };
};

/**
 * Every dimension where the two hosts resolved different values. Empty means
 * both hosts resolve one capability version.
 *
 * `artifactHash` is special: the two hosts carry the same contract in two
 * FORMATS (generated TypeScript, embedded JSON), so their raw digests can never
 * be equal and comparing them would be theatre. The honest equivalence test is
 * regeneration, which the caller performs and reports through
 * `codeContractArtifactIsByteCurrent`.
 */
export const findCapabilityLockDivergences = (
  document: CapabilityVersionLockDocument,
  inputs: Pick<CapabilityVersionLockInputs, "codeContractArtifactIsByteCurrent">,
): ReadonlyArray<CapabilityLockDivergence> => {
  const divergences: Array<CapabilityLockDivergence> = [];

  for (const capability of document.capabilities) {
    for (const dimension of CAPABILITY_LOCK_DIMENSIONS) {
      const record = capability.dimensions[dimension];
      if (record.enforcement !== "cross-host") continue;

      if (dimension === "artifactHash") {
        if (!inputs.codeContractArtifactIsByteCurrent) {
          divergences.push({
            capabilityId: capability.capabilityId,
            dimension,
            codeValue: record.code,
            ctoxValue: record.ctox ?? "<absent>",
            codeSource: record.codeSource,
            ctoxSource: record.ctoxSource ?? "<absent>",
          });
        }
        continue;
      }

      if (record.ctox === null || record.code !== record.ctox) {
        divergences.push({
          capabilityId: capability.capabilityId,
          dimension,
          codeValue: record.code,
          ctoxValue: record.ctox ?? "<absent>",
          codeSource: record.codeSource,
          ctoxSource: record.ctoxSource ?? "<absent>",
        });
      }
    }
  }

  return divergences;
};

export const renderCapabilityVersionLock = (document: CapabilityVersionLockDocument): string =>
  `${JSON.stringify(document, null, 2)}\n`;

export const describeCapabilityLockDivergence = (
  divergence: CapabilityLockDivergence,
): string =>
  divergence.dimension === "artifactHash"
    ? `${divergence.capabilityId}: the Code capability contract artifact (${divergence.codeSource}, sha256 ${divergence.codeValue}) is not byte-current with the CTOX artifact (${divergence.ctoxSource}, sha256 ${divergence.ctoxValue}). Run 'node packages/workjet-capabilities/scripts/generate-web-stack-contract.mjs' and commit the result.`
    : `${divergence.capabilityId}: hosts resolve different ${divergence.dimension}. Code (${divergence.codeSource}) = ${divergence.codeValue}; CTOX (${divergence.ctoxSource}) = ${divergence.ctoxValue}.`;

/**
 * Surface-version constants declared in a Rust or TypeScript source file, e.g.
 * `const SEARCH_SURFACE_VERSION: &str = "workjet-web-stack-json-v1";` or
 * `export const WEB_STACK_SURFACE_VERSION = "workjet-web-stack-json-v1\n";`.
 */
export const parseSurfaceVersionConstants = (
  source: string,
  names: ReadonlyArray<string>,
): Readonly<Record<string, string>> => {
  const parsed: Record<string, string> = {};
  for (const name of names) {
    const match = new RegExp(`\\b${name}\\b[^=]*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u").exec(source);
    if (match?.[1] === undefined) continue;
    parsed[name] = match[1].replace(/\\n/gu, "\n").trim();
  }
  return parsed;
};
