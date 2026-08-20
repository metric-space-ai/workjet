// @effect-diagnostics nodeBuiltinImport:off -- The gate reads the CTOX host's own published adapter fixture from disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import {
  canonicalCapabilityJson,
  capabilityConformanceCoverage,
  compareCapabilityProjections,
  dualHostCapabilityIds,
  findHostPolicyDifference,
  HOST_POLICY_DIFFERENCES,
  type CanonicalCapabilityProjection,
  type CapabilityProjectionDivergence,
} from "@metric-space-ai/workjet-capabilities";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as GreppySearch from "./GreppySearch.ts";
import * as GreppyTool from "./GreppyTool.ts";
import * as WebStackBrowser from "./WebStackBrowser.ts";
import * as WebStackNativeProcess from "./WebStackNativeProcess.ts";
import * as WebStackResearch from "./WebStackResearch.ts";
import * as WebStackSearch from "./WebStackSearch.ts";
import * as WebStackTool from "./WebStackTool.ts";

/**
 * THE CROSS-HOST CAPABILITY CONFORMANCE GATE
 * (docs/workjet-plan.md → "Host adapters"):
 *
 *   "Add a cross-host conformance gate that invokes every dual-host capability
 *    through both adapters against the same fixtures and compares canonical
 *    success/error projections while allowing only documented host-policy
 *    differences."
 *
 * WHAT THE TWO LEGS ACTUALLY ARE.
 *
 *   Code leg (`t3-mcp`)  — REAL. Every case below is driven through the
 *     production MCP registrations in `GreppyTool.ts` and `WebStackTool.ts` via
 *     `server.callTool`, with the capability core stubbed so the comparison is
 *     about the ADAPTER's projection, not about the network.
 *
 *   CTOX leg (`ctox-business-os-mcp`) — read from
 *     `native/web-stack/fixtures/capability-adapter-v1.json`, the CTOX host's
 *     own published adapter contract. That file is not this test's invention:
 *     `native/web-stack/tests/capability_contract.rs` independently holds the
 *     CTOX capability host to it. Drift on either side breaks one of the two
 *     suites, which is what makes this a comparison and not a restatement.
 *
 * THE SAME FIXTURES. Both legs are driven from that one file's `validInputs`
 * and `invalidInputs` arrays. The gate does not maintain a second copy of the
 * inputs, so a fixture the Rust side adds is a fixture the Code adapter must
 * immediately satisfy.
 *
 * COVERAGE, HONESTLY. Greppy is dual-host in the catalog, but this repository
 * contains no CTOX-side Greppy manifest, schema, revision, or artifact — the
 * CTOX host runs its own Greppy runtime. `capabilityConformanceCoverage`
 * records that as a DECLARED gap with its reason; the gate still drives Greppy
 * through the real Code adapter, and a NEW dual-host capability that declares
 * no coverage fails the gate rather than being silently skipped.
 *
 * HOST POLICY. The only tolerated differences are the entries in
 * `HOST_POLICY_DIFFERENCES`. The response-budget entry is load-bearing here:
 * the test below asserts the Code adapter's compiled-in budget really is the
 * value that entry claims, and really is the first of the two budgets the
 * shared fixture declares.
 */

const repoRoot = NodePath.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../../..",
);
const FIXTURE_PATH = "native/web-stack/fixtures/capability-adapter-v1.json";

interface AdapterFixture {
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly capabilityId: string;
    readonly contractVersion: string;
  }>;
  readonly validInputs: ReadonlyArray<{
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }>;
  readonly invalidInputs: ReadonlyArray<{
    readonly tool: string;
    readonly reason: string;
    readonly arguments: Record<string, unknown>;
  }>;
  readonly outputCanaries: {
    readonly marker: string;
    readonly forbiddenFields: ReadonlyArray<string>;
  };
  readonly hostBudgets: readonly [number, number];
}

const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.join(repoRoot, FIXTURE_PATH), "utf8"),
) as AdapterFixture;

const OVER_LONG_QUERY_SENTINEL = "__OVER_2000_CHARS__";

// ---------------------------------------------------------------------------
// The shared case table: the fixture's own inputs, plus Greppy's.
// ---------------------------------------------------------------------------

interface ConformanceCase {
  readonly capabilityId: string;
  readonly fixtureId: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  /** What the CTOX host must project for this case. */
  readonly ctox: CanonicalCapabilityProjection;
  /** Granted capabilities for the Code leg's bearer scope. */
  readonly grants: ReadonlyArray<"greppy" | "web-search" | "web-stack-browser">;
}

const capabilityIdForTool = (tool: string): string => {
  const entry = fixture.tools.find(({ name }) => name === tool);
  assert.ok(entry !== undefined, `fixture declares no capability for tool '${tool}'`);
  return entry.capabilityId;
};

/**
 * The structured answer the shared capability core returns for a valid call.
 * Both hosts execute the same core, so the CTOX projection of a successful call
 * IS this value; the Code leg passes if its adapter hands it through without
 * adding, renaming, or dropping a field.
 */
const CORE_SUCCESS: Readonly<Record<string, unknown>> = {
  web_search: { results: [{ title: "Evidence", url: "https://example.test/e", snippet: "s" }] },
  web_read: {
    operation: "read",
    requestedUrl: "https://example.test/evidence",
    isPdf: false,
    redirectChain: [],
    excerpts: [],
    findMatches: [],
    pageSections: [],
    transportEvidenceEligible: true,
    evidenceEligible: true,
    datasetContentExtracted: false,
  },
  web_deep_research: { operation: "deepResearch", query: "bounded research" },
  web_browser_prepare: { installAttempted: false },
  web_browser_automate: { observations: [] },
  greppy_search: { matches: [{ path: "src/retry.ts", line: 17, excerpt: "Retries." }] },
};

const grantsFor = (
  capabilityId: string,
): ReadonlyArray<"greppy" | "web-search" | "web-stack-browser"> => [
  capabilityId as "greppy" | "web-search" | "web-stack-browser",
];

const webStackCases: ReadonlyArray<ConformanceCase> = [
  ...fixture.validInputs.map((entry) => ({
    capabilityId: capabilityIdForTool(entry.tool),
    fixtureId: `valid/${entry.tool}`,
    tool: entry.tool,
    arguments: entry.arguments,
    ctox: {
      outcome: "success" as const,
      structuredContent: CORE_SUCCESS[entry.tool],
    },
    grants: grantsFor(capabilityIdForTool(entry.tool)),
  })),
  ...fixture.invalidInputs.map((entry) => ({
    capabilityId: capabilityIdForTool(entry.tool),
    fixtureId: `invalid/${entry.tool}/${entry.reason}`,
    tool: entry.tool,
    arguments:
      entry.arguments.query === OVER_LONG_QUERY_SENTINEL
        ? { ...entry.arguments, query: "a".repeat(2_001) }
        : entry.arguments,
    ctox: { outcome: "error" as const, errorClass: "invalid-arguments" as const },
    grants: grantsFor(capabilityIdForTool(entry.tool)),
  })),
  // Availability is separate from activation on BOTH hosts: an installed but
  // inactive capability must refuse, not run.
  ...fixture.validInputs.map((entry) => ({
    capabilityId: capabilityIdForTool(entry.tool),
    fixtureId: `ungranted/${entry.tool}`,
    tool: entry.tool,
    arguments: entry.arguments,
    ctox: { outcome: "error" as const, errorClass: "capability-not-granted" as const },
    grants: [] as ReadonlyArray<"greppy" | "web-search" | "web-stack-browser">,
  })),
];

/**
 * Greppy's cases. The CTOX projections are the canonical contract the catalog
 * defines for every capability; `capabilityConformanceCoverage` records that
 * this repository holds no independent CTOX source for them.
 */
const greppyCases: ReadonlyArray<ConformanceCase> = [
  {
    capabilityId: "greppy",
    fixtureId: "valid/greppy_search",
    tool: GreppyTool.GREPPY_MCP_TOOL_NAME,
    arguments: { task: "find retries" },
    ctox: { outcome: "success", structuredContent: CORE_SUCCESS.greppy_search },
    grants: ["greppy"],
  },
  {
    capabilityId: "greppy",
    fixtureId: "invalid/greppy_search/missing-task",
    tool: GreppyTool.GREPPY_MCP_TOOL_NAME,
    arguments: {},
    ctox: { outcome: "error", errorClass: "invalid-arguments" },
    grants: ["greppy"],
  },
  {
    capabilityId: "greppy",
    fixtureId: "invalid/greppy_search/empty-task",
    tool: GreppyTool.GREPPY_MCP_TOOL_NAME,
    arguments: { task: "" },
    ctox: { outcome: "error", errorClass: "invalid-arguments" },
    grants: ["greppy"],
  },
  {
    capabilityId: "greppy",
    fixtureId: "invalid/greppy_search/task-bound",
    tool: GreppyTool.GREPPY_MCP_TOOL_NAME,
    arguments: { task: "a".repeat(4_001) },
    ctox: { outcome: "error", errorClass: "invalid-arguments" },
    grants: ["greppy"],
  },
  {
    capabilityId: "greppy",
    fixtureId: "ungranted/greppy_search",
    tool: GreppyTool.GREPPY_MCP_TOOL_NAME,
    arguments: { task: "find retries" },
    ctox: { outcome: "error", errorClass: "capability-not-granted" },
    grants: [],
  },
];

const conformanceCases: ReadonlyArray<ConformanceCase> = [...greppyCases, ...webStackCases];

// ---------------------------------------------------------------------------
// The Code leg: the real T3 MCP adapter.
// ---------------------------------------------------------------------------

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "capability-conformance-gate", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation = (
  grants: ReadonlyArray<"greppy" | "web-search" | "web-stack-browser">,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-conformance"),
  threadId: ThreadId.make("thread-conformance"),
  providerSessionId: "provider-session-conformance",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"]),
  activeWorkjetMcpCapabilityIds: new Set(grants),
  // Declared host-policy difference: the Code adapter requires an effective
  // session cwd for Greppy and the CTOX host has no thread cwd. Every case runs
  // with one satisfied so the comparison is about the projection, not the
  // precondition.
  cwd: "/workspace/conformance",
  issuedAt: 1,
});

const stubLayer = Layer.mergeAll(
  Layer.succeed(
    GreppySearch.GreppySearch,
    GreppySearch.GreppySearch.of({
      search: () => Effect.succeed(CORE_SUCCESS.greppy_search as GreppySearch.GreppySearchResult),
    }),
  ),
  Layer.succeed(
    WebStackSearch.WebStackSearch,
    WebStackSearch.WebStackSearch.of({
      search: () => Effect.succeed(CORE_SUCCESS.web_search as WebStackSearch.WebStackSearchResult),
    }),
  ),
  Layer.succeed(
    WebStackResearch.WebStackResearch,
    WebStackResearch.WebStackResearch.of({
      read: () => Effect.succeed(CORE_SUCCESS.web_read as WebStackResearch.WebReadResult),
      deepResearch: () =>
        Effect.succeed(CORE_SUCCESS.web_deep_research as WebStackResearch.WebDeepResearchResult),
    }),
  ),
  Layer.succeed(
    WebStackBrowser.WebStackBrowser,
    WebStackBrowser.WebStackBrowser.of({
      prepare: () =>
        Effect.succeed(CORE_SUCCESS.web_browser_prepare as WebStackBrowser.BrowserPrepareResult),
      automate: () =>
        Effect.succeed(
          CORE_SUCCESS.web_browser_automate as WebStackBrowser.BrowserAutomationResult,
        ),
    }),
  ),
);

const gateLayer = Layer.mergeAll(
  GreppyTool.WorkjetToolkitRegistrationLive,
  WebStackTool.WebStackToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpServer.McpServer.layer), Layer.provide(stubLayer));

const errorReason = (result: McpSchema.CallToolResult): string => {
  const structured = result.structuredContent as
    | { readonly error?: { readonly reason?: string } }
    | undefined;
  return structured?.error?.reason ?? "unknown";
};

const projectCallToolResult = (result: McpSchema.CallToolResult): CanonicalCapabilityProjection =>
  result.isError
    ? {
        outcome: "error",
        errorClass:
          errorReason(result) === "capability-not-granted"
            ? "capability-not-granted"
            : "execution-failed",
      }
    : { outcome: "success", structuredContent: result.structuredContent };

/** Normalize what the real Code adapter returned into the canonical vocabulary. */
const projectCodeAdapter = Effect.fn("projectCodeAdapter")(function* (
  conformanceCase: ConformanceCase,
) {
  const server = yield* McpServer.McpServer;
  return yield* server
    .callTool({ name: conformanceCase.tool, arguments: conformanceCase.arguments })
    .pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(conformanceCase.grants),
      ),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.map(projectCallToolResult),
      // The adapter refused the arguments before reaching the capability core.
      // Only THIS failure maps to the canonical invalid-arguments class: any
      // other failure (an unregistered tool, a transport fault) must surface as
      // a test defect rather than be laundered into a conforming refusal.
      Effect.catchTag("InvalidParams", () =>
        Effect.succeed({
          outcome: "error",
          errorClass: "invalid-arguments",
        } satisfies CanonicalCapabilityProjection),
      ),
    );
});

/**
 * Drive every case through both adapters and return every undeclared
 * difference. `perturb` exists so the mutation proofs can make one adapter's
 * projection drift and watch the gate refuse it.
 */
const runConformanceGate = Effect.fn("runConformanceGate")(function* (
  perturb?: (
    conformanceCase: ConformanceCase,
    projection: CanonicalCapabilityProjection,
  ) => CanonicalCapabilityProjection,
) {
  const divergences: Array<CapabilityProjectionDivergence> = [];
  for (const conformanceCase of conformanceCases) {
    const raw = yield* projectCodeAdapter(conformanceCase);
    const code = perturb ? perturb(conformanceCase, raw) : raw;
    divergences.push(
      ...compareCapabilityProjections({
        capabilityId: conformanceCase.capabilityId,
        fixtureId: conformanceCase.fixtureId,
        code,
        ctox: conformanceCase.ctox,
      }),
    );
  }
  return divergences;
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("cross-host capability conformance gate", () => {
  it("covers every dual-host capability, with a declared reason where CTOX is unrepresented", () => {
    assert.deepStrictEqual(
      capabilityConformanceCoverage.map(({ capabilityId }) => capabilityId).sort(),
      [...dualHostCapabilityIds].sort(),
    );
    for (const coverage of capabilityConformanceCoverage) {
      assert.ok(
        coverage.reason.length > 80,
        `${coverage.capabilityId} declares a CTOX projection source without stating why`,
      );
    }
    // Every dual-host capability is actually exercised by at least one case.
    for (const capabilityId of dualHostCapabilityIds) {
      assert.ok(
        conformanceCases.some((entry) => entry.capabilityId === capabilityId),
        `no conformance case drives ${capabilityId}`,
      );
    }
  });

  it("drives the fixture's own inputs, not a private copy", () => {
    assert.ok(fixture.validInputs.length >= 5);
    assert.ok(fixture.invalidInputs.length >= 10);
    for (const entry of [...fixture.validInputs, ...fixture.invalidInputs]) {
      assert.ok(
        conformanceCases.some(
          (conformanceCase) =>
            conformanceCase.tool === entry.tool && conformanceCase.fixtureId.includes(entry.tool),
        ),
        `fixture case for ${entry.tool} is not driven by the gate`,
      );
    }
  });

  it.effect("drives real registered tools, not a stand-in", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const registered = new Set(server.tools.map(({ tool }) => tool.name));
      for (const conformanceCase of conformanceCases) {
        assert.ok(
          registered.has(conformanceCase.tool),
          `${conformanceCase.tool} is not a registered T3 MCP tool`,
        );
      }
    }).pipe(Effect.provide(gateLayer)),
  );

  it.effect("both adapters project the same canonical success and error for every fixture", () =>
    Effect.gen(function* () {
      const divergences = yield* runConformanceGate();
      assert.deepStrictEqual(divergences, []);
    }).pipe(Effect.provide(gateLayer)),
  );

  // The canary list belongs to the Web Stack contract, where a `path` or
  // `source` field in an answer would be a host-state leak. It is applied to the
  // capabilities that fixture actually governs; Greppy's canonical output
  // legitimately carries workspace-relative match paths, which is why its
  // outputSchema declares `path` and this canary does not run against it.
  const fixtureGovernedCases = conformanceCases.filter((conformanceCase) =>
    capabilityConformanceCoverage.some(
      (coverage) =>
        coverage.capabilityId === conformanceCase.capabilityId &&
        coverage.ctoxProjectionSource === "shared-fixture",
    ),
  );

  it.effect("no success projection leaks a field the shared fixture forbids", () =>
    Effect.gen(function* () {
      assert.ok(fixtureGovernedCases.length > 0);
      for (const conformanceCase of fixtureGovernedCases) {
        const projection = yield* projectCodeAdapter(conformanceCase);
        if (projection.outcome !== "success") continue;
        const serialized = canonicalCapabilityJson(projection.structuredContent).toLowerCase();
        for (const forbidden of fixture.outputCanaries.forbiddenFields) {
          assert.ok(
            !serialized.includes(`"${forbidden}":`),
            `${conformanceCase.fixtureId} projects forbidden field '${forbidden}'`,
          );
        }
      }
    }).pipe(Effect.provide(gateLayer)),
  );

  it("holds the declared response-budget difference to the real compiled-in values", () => {
    const budget = findHostPolicyDifference("web-search", "maxResponseBytes");
    assert.ok(budget !== undefined, "the response-budget host policy difference is undeclared");
    assert.strictEqual(
      Number(budget.codeValue),
      WebStackNativeProcess.WEB_STACK_RESPONSE_MAX_BYTES,
    );
    assert.deepStrictEqual(
      [Number(budget.codeValue), Number(budget.ctoxValue)],
      [...fixture.hostBudgets],
    );
  });

  it("states a reason for every tolerated host-policy difference", () => {
    for (const difference of HOST_POLICY_DIFFERENCES) {
      assert.ok(
        difference.reason.length > 80,
        `${difference.capabilityId}/${difference.property} is tolerated without stating why`,
      );
      assert.notStrictEqual(difference.codeValue, difference.ctoxValue);
    }
  });
});

describe("cross-host capability conformance gate — mutation proofs (the gate bites)", () => {
  it.effect("fails when the Code adapter renames a field in a success projection", () =>
    Effect.gen(function* () {
      const divergences = yield* runConformanceGate((conformanceCase, projection) =>
        conformanceCase.capabilityId === "web-search" && projection.outcome === "success"
          ? { outcome: "success", structuredContent: { hits: projection.structuredContent } }
          : projection,
      );

      assert.ok(divergences.length > 0, "renaming a success field did not fail the gate");
      assert.deepStrictEqual(
        [...new Set(divergences.map(({ capabilityId }) => capabilityId))],
        ["web-search"],
      );
      assert.deepStrictEqual(
        [...new Set(divergences.map(({ property }) => property))],
        ["structuredContent"],
      );
    }).pipe(Effect.provide(gateLayer)),
  );

  it.effect("fails when the Code adapter downgrades a refusal into a success", () =>
    Effect.gen(function* () {
      const divergences = yield* runConformanceGate((conformanceCase, projection) =>
        conformanceCase.capabilityId === "web-stack-browser" &&
        conformanceCase.fixtureId.startsWith("invalid/")
          ? { outcome: "success", structuredContent: { observations: [] } }
          : projection,
      );

      assert.ok(divergences.length > 0, "accepting an invalid input did not fail the gate");
      assert.deepStrictEqual(
        [...new Set(divergences.map(({ capabilityId }) => capabilityId))],
        ["web-stack-browser"],
      );
      assert.deepStrictEqual(
        [...new Set(divergences.map(({ property }) => property))],
        ["outcome"],
      );
    }).pipe(Effect.provide(gateLayer)),
  );

  it.effect("fails when the Code adapter answers an ungranted capability", () =>
    Effect.gen(function* () {
      const divergences = yield* runConformanceGate((conformanceCase, projection) =>
        conformanceCase.capabilityId === "greppy" &&
        conformanceCase.fixtureId.startsWith("ungranted/")
          ? { outcome: "success", structuredContent: CORE_SUCCESS.greppy_search }
          : projection,
      );

      assert.deepStrictEqual(
        divergences.map(({ capabilityId, fixtureId, property }) => ({
          capabilityId,
          fixtureId,
          property,
        })),
        [
          {
            capabilityId: "greppy",
            fixtureId: "ungranted/greppy_search",
            property: "outcome",
          },
        ],
      );
    }).pipe(Effect.provide(gateLayer)),
  );

  it("fails when a capability declares no host-policy reason for a real difference", () => {
    assert.deepStrictEqual(
      compareCapabilityProjections({
        capabilityId: "web-search",
        fixtureId: "synthetic",
        code: { outcome: "error", errorClass: "invalid-arguments" },
        ctox: { outcome: "error", errorClass: "execution-failed" },
      }),
      [
        {
          capabilityId: "web-search",
          fixtureId: "synthetic",
          property: "errorClass",
          codeValue: "invalid-arguments",
          ctoxValue: "execution-failed",
        },
      ],
    );
  });
});
