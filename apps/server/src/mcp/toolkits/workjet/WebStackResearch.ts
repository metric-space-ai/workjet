import {
  WEB_DEEP_RESEARCH_OUTPUT_SCHEMA,
  WEB_READ_OUTPUT_SCHEMA,
} from "@metric-space-ai/workjet-capabilities";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../../config.ts";
import * as NativeProcess from "./WebStackNativeProcess.ts";

export const WEB_STACK_RESEARCH_SURFACE_VERSION = "workjet-web-stack-research-json-v1\n";
export const WEB_STACK_READ_TIMEOUT = Duration.minutes(2);
export const WEB_STACK_RESEARCH_TIMEOUTS = {
  quick: Duration.minutes(5),
  standard: Duration.minutes(15),
  exhaustive: Duration.minutes(30),
} as const;
const WEB_STACK_RESEARCH_PROBE_TIMEOUT = Duration.seconds(10);

export const researchTimeoutForDepth = (depth: WebDeepResearchDepth): Duration.Duration =>
  WEB_STACK_RESEARCH_TIMEOUTS[depth];

export const WebStackResearchFailureReason = Schema.Literals([
  "binary-unavailable",
  "version-mismatch",
  "timeout",
  "process-exit",
  "malformed-response",
  "oversized-response",
  "execution-failed",
]);
export type WebStackResearchFailureReason = typeof WebStackResearchFailureReason.Type;

export class WebStackResearchError extends Schema.TaggedErrorClass<WebStackResearchError>()(
  "WebStackResearchError",
  { reason: WebStackResearchFailureReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "binary-unavailable":
        return "Web research is unavailable on this server.";
      case "version-mismatch":
        return "The installed Web research runtime is incompatible.";
      case "timeout":
        return "Web research timed out.";
      case "malformed-response":
      case "oversized-response":
        return "Web research returned an invalid response.";
      case "process-exit":
      case "execution-failed":
        return "Web research failed.";
    }
  }
}

export type WebReadCountry = "DE" | "AT" | "CH";
export interface WebReadInput {
  readonly url: string;
  readonly query?: string;
  readonly find?: ReadonlyArray<string>;
  readonly country?: WebReadCountry;
}

export type WebDeepResearchDepth = "quick" | "standard" | "exhaustive";
export interface WebDeepResearchInput {
  readonly query: string;
  readonly focus?: string;
  readonly depth: WebDeepResearchDepth;
  readonly maxSources: number;
  readonly excludeUrls: ReadonlyArray<string>;
  readonly includePapers: boolean;
  readonly includeAnnasArchive: boolean;
}

export interface WebReadResponseMetadata {
  readonly requestedUrl?: string;
  readonly finalUrl?: string;
  readonly status?: number;
  readonly contentType?: string;
  readonly byteCount?: number;
  readonly sha256?: string;
  readonly contentKind?: string;
  readonly redirected?: boolean;
  readonly redirectChain: ReadonlyArray<string>;
  readonly lineage?: string;
  readonly admissionRejectionReason?: string;
}

export interface WebReadExtractedField {
  readonly field: string;
  readonly value: string;
  readonly confidence?: string;
  readonly note?: string;
  readonly sourceUrl?: string;
}

export interface WebReadExtractedFields {
  readonly sourceId?: string;
  readonly tier?: string;
  readonly fields: ReadonlyArray<WebReadExtractedField>;
}

export interface WebReadResult {
  readonly operation: "read";
  readonly requestedUrl: string;
  readonly canonicalUrl?: string;
  readonly finalUrl?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly pageTextExcerpt?: string;
  readonly isPdf: boolean;
  readonly pdfTotalPages?: number;
  readonly redirected?: boolean;
  readonly redirectChain: ReadonlyArray<string>;
  readonly lineage?: string;
  readonly verificationStatus?: string;
  readonly checkedAt?: number;
  readonly httpStatus?: number;
  readonly snapshotHash?: string;
  readonly contentType?: string;
  readonly byteCount?: number;
  readonly responseContentKind?: string;
  readonly responseMetadata?: WebReadResponseMetadata;
  readonly excerpts: ReadonlyArray<string>;
  readonly findMatches: ReadonlyArray<{
    readonly pattern: string;
    readonly matches: ReadonlyArray<string>;
  }>;
  readonly pageSections: ReadonlyArray<{
    readonly pageNumber?: number;
    readonly text: string;
  }>;
  readonly sourceTier?: string;
  readonly transportEvidenceEligible: boolean;
  readonly evidenceEligible: boolean;
  readonly evidenceRelevanceScore?: number;
  readonly evidenceRejectionReason?: string;
  readonly evidenceContentKind?: string;
  readonly datasetContentExtracted: boolean;
  readonly extractedFields?: WebReadExtractedFields;
}

export interface WebDeepResearchSource {
  readonly title?: string;
  readonly canonicalUrl: string;
  readonly domain?: string;
  readonly summary?: string;
  readonly sourceType?: string;
  readonly doi?: string;
  readonly verificationStatus?: string;
  readonly checkedAt?: number;
  readonly httpStatus?: number;
  readonly snapshotHash?: string;
  readonly transportVerified: boolean;
  readonly contentExtracted: boolean;
  readonly actualFullTextOrData: boolean;
  readonly evidenceEligible: boolean;
  readonly evidenceRelevanceScore?: number;
  readonly evidenceRejectionReason?: string;
  readonly responseContentKind?: string;
  readonly dataValidationStatus?: string;
  readonly pageTextExcerpt?: string;
  readonly excerpts: ReadonlyArray<string>;
}

export interface WebDeepResearchBlockedSource {
  readonly title?: string;
  readonly canonicalUrl: string;
  readonly blockedResponseUrl?: string;
  readonly reason?: string;
  readonly doi?: string;
  readonly nextAction?: string;
}

export interface WebDeepResearchResult {
  readonly operation: "deepResearch";
  readonly query: string;
  readonly focus?: string;
  readonly depth: WebDeepResearchDepth;
  readonly maxSources: number;
  readonly evidenceStatus: "no_verified_sources" | "verified_sources_available";
  readonly verifiedSources: ReadonlyArray<WebDeepResearchSource>;
  readonly blockedSources: ReadonlyArray<WebDeepResearchBlockedSource>;
  readonly systematicCoverage: {
    readonly plannedFacets: ReadonlyArray<string>;
    readonly successfulFacets: ReadonlyArray<string>;
    readonly uncoveredFacets: ReadonlyArray<string>;
    readonly excludedExistingUrlCount: number;
    readonly verifiedPrimaryDataSources: number;
    readonly verifiedScholarlyFullTextSources: number;
    readonly hashBoundVerifiedSources: number;
    readonly independentVerifiedDomains: ReadonlyArray<string>;
    readonly remainingGaps: ReadonlyArray<string>;
    readonly complete: boolean;
  };
  readonly researchCallCounts: Readonly<
    Record<
      | "planned_search_queries"
      | "executed_search_queries"
      | "database_queries"
      | "discovered_source_candidates"
      | "candidate_pool_limit"
      | "deduplicated_sources"
      | "verified_sources"
      | "rejected_source_candidates"
      | "read_budget"
      | "followup_read_budget"
      | "read_attempts"
      | "followed_data_links"
      | "sources_with_page_read_attempts"
      | "successful_page_reads"
      | "failed_page_reads"
      | "figure_candidates"
      | "estimated_external_fetches",
      number
    >
  >;
  readonly reportScaffold: {
    readonly recommendedSections: ReadonlyArray<string>;
    readonly evaluationAxes: ReadonlyArray<string>;
    readonly synthesisInstruction: string;
  };
  readonly workspacePersisted: boolean;
  readonly workspaceId?: string;
}

export interface WebStackResearchShape {
  readonly read: (input: WebReadInput) => Effect.Effect<WebReadResult, WebStackResearchError>;
  readonly deepResearch: (
    input: WebDeepResearchInput,
  ) => Effect.Effect<WebDeepResearchResult, WebStackResearchError>;
}

export class WebStackResearch extends Context.Service<WebStackResearch, WebStackResearchShape>()(
  "t3/mcp/WebStackResearch",
) {}

const failure = (reason: WebStackResearchFailureReason): WebStackResearchError =>
  new WebStackResearchError({ reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= maximum;

const boundedTextArray = (
  value: unknown,
  maximumItems: number,
  maximumChars: number,
): value is ReadonlyArray<string> =>
  Array.isArray(value) &&
  value.length <= maximumItems &&
  value.every((item) => boundedText(item, maximumChars));

export const decodeWebReadInput = (value: unknown): WebReadInput | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["url"], ["query", "find", "country"]) ||
    !boundedText(value.url, 8_000) ||
    (value.query !== undefined && !boundedText(value.query, 4_000)) ||
    (value.find !== undefined && !boundedTextArray(value.find, 32, 1_000)) ||
    (value.country !== undefined && !["DE", "AT", "CH"].includes(value.country as string))
  ) {
    return undefined;
  }
  return {
    url: value.url,
    ...(typeof value.query === "string" ? { query: value.query } : {}),
    ...(Array.isArray(value.find) ? { find: value.find as ReadonlyArray<string> } : {}),
    ...(typeof value.country === "string" ? { country: value.country as WebReadCountry } : {}),
  };
};

export const decodeWebDeepResearchInput = (value: unknown): WebDeepResearchInput | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["query"],
      ["focus", "depth", "maxSources", "excludeUrls", "includePapers", "includeAnnasArchive"],
    ) ||
    !boundedText(value.query, 4_000) ||
    (value.focus !== undefined && !boundedText(value.focus, 4_000)) ||
    (value.depth !== undefined &&
      !["quick", "standard", "exhaustive"].includes(value.depth as string)) ||
    (value.maxSources !== undefined &&
      (!Number.isInteger(value.maxSources) ||
        (value.maxSources as number) < 3 ||
        (value.maxSources as number) > 100)) ||
    (value.excludeUrls !== undefined && !boundedTextArray(value.excludeUrls, 100, 8_000)) ||
    (value.includePapers !== undefined && typeof value.includePapers !== "boolean") ||
    (value.includeAnnasArchive !== undefined && typeof value.includeAnnasArchive !== "boolean")
  ) {
    return undefined;
  }
  return {
    query: value.query,
    ...(typeof value.focus === "string" ? { focus: value.focus } : {}),
    depth: (value.depth as WebDeepResearchDepth | undefined) ?? "standard",
    maxSources: (value.maxSources as number | undefined) ?? 16,
    excludeUrls: (value.excludeUrls as ReadonlyArray<string> | undefined) ?? [],
    includePapers: (value.includePapers as boolean | undefined) ?? true,
    includeAnnasArchive: (value.includeAnnasArchive as boolean | undefined) ?? false,
  };
};

interface JsonContract {
  readonly const?: unknown;
  readonly enum?: ReadonlyArray<unknown>;
  readonly type?: "object" | "array" | "string" | "integer" | "boolean";
  readonly required?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, JsonContract>>;
  readonly items?: JsonContract;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

const INVALID_JSON_CONTRACT = Symbol("INVALID_JSON_CONTRACT");
type InvalidJsonContract = typeof INVALID_JSON_CONTRACT;

const projectJsonContract = (
  schema: JsonContract,
  value: unknown,
): unknown | InvalidJsonContract => {
  if (Object.hasOwn(schema, "const") && value !== schema.const) return INVALID_JSON_CONTRACT;
  if (schema.enum && !schema.enum.includes(value)) return INVALID_JSON_CONTRACT;

  switch (schema.type) {
    case undefined:
      return value;
    case "boolean":
      return typeof value === "boolean" ? value : INVALID_JSON_CONTRACT;
    case "integer":
      return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum)
        ? value
        : INVALID_JSON_CONTRACT;
    case "string": {
      if (typeof value !== "string") return INVALID_JSON_CONTRACT;
      const length = Array.from(value).length;
      return (schema.minLength === undefined || length >= schema.minLength) &&
        (schema.maxLength === undefined || length <= schema.maxLength) &&
        (schema.pattern === undefined || new RegExp(schema.pattern, "u").test(value))
        ? value
        : INVALID_JSON_CONTRACT;
    }
    case "array": {
      if (
        !Array.isArray(value) ||
        !schema.items ||
        (schema.minItems !== undefined && value.length < schema.minItems) ||
        (schema.maxItems !== undefined && value.length > schema.maxItems)
      ) {
        return INVALID_JSON_CONTRACT;
      }
      const projected: Array<unknown> = [];
      for (const item of value) {
        const result = projectJsonContract(schema.items, item);
        if (result === INVALID_JSON_CONTRACT) return INVALID_JSON_CONTRACT;
        projected.push(result);
      }
      return projected;
    }
    case "object": {
      if (!isRecord(value) || !schema.properties) return INVALID_JSON_CONTRACT;
      for (const required of schema.required ?? []) {
        if (!Object.hasOwn(value, required) || value[required] === null) {
          return INVALID_JSON_CONTRACT;
        }
      }
      const projected: Record<string, unknown> = {};
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        const propertyValue = value[key];
        if (propertyValue === undefined || propertyValue === null) continue;
        const result = projectJsonContract(propertySchema, propertyValue);
        if (result === INVALID_JSON_CONTRACT) return INVALID_JSON_CONTRACT;
        projected[key] = result;
      }
      return projected;
    }
  }
};

function parseResponse(
  output: NativeProcess.ProcessOutput,
  operation: "read",
): Effect.Effect<WebReadResult, WebStackResearchError>;
function parseResponse(
  output: NativeProcess.ProcessOutput,
  operation: "deepResearch",
): Effect.Effect<WebDeepResearchResult, WebStackResearchError>;
function parseResponse(
  output: NativeProcess.ProcessOutput,
  operation: "read" | "deepResearch",
): Effect.Effect<WebReadResult | WebDeepResearchResult, WebStackResearchError> {
  if (output.stdout.totalBytes > NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES) {
    return Effect.fail(failure("oversized-response"));
  }
  if (output.exitCode !== 0) return Effect.fail(failure("process-exit"));
  return Effect.try({
    try: () => {
      // @effect-diagnostics-next-line preferSchemaOverJson:off - strict projection validates this bounded native process boundary.
      const value = JSON.parse(NativeProcess.outputText(output.stdout)) as unknown;
      if (!isRecord(value) || value.ok !== true || value.operation !== operation) {
        throw new Error("invalid response");
      }
      const schema =
        operation === "read" ? WEB_READ_OUTPUT_SCHEMA : WEB_DEEP_RESEARCH_OUTPUT_SCHEMA;
      const result = projectJsonContract(schema as JsonContract, value);
      if (result === INVALID_JSON_CONTRACT) throw new Error("invalid response");
      return result as WebReadResult | WebDeepResearchResult;
    },
    catch: () => failure("malformed-response"),
  });
}

const makeWithOptions = Effect.fn("WebStackResearch.make")(function* (options: {
  readonly stateDir: string;
  readonly runtime: NativeProcess.WebStackRuntimeBoundary;
  readonly probeTimeout?: Duration.Duration;
  readonly readTimeout?: Duration.Duration;
  readonly researchTimeouts?: Partial<Record<WebDeepResearchDepth, Duration.Duration>>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stateRoot = NodePath.join(options.stateDir, "web-stack");
  const runNative = NativeProcess.makeProbedRunner({
    spawner,
    runtime: options.runtime,
    probeArgs: ["--research-surface-version"],
    expectedSurfaceVersion: WEB_STACK_RESEARCH_SURFACE_VERSION,
    probeTimeout: options.probeTimeout ?? WEB_STACK_RESEARCH_PROBE_TIMEOUT,
    failure,
  });
  const ensureRoot = Effect.tryPromise({
    try: () => options.runtime.makeDirectory(stateRoot),
    catch: () => failure("execution-failed"),
  });

  const read: WebStackResearchShape["read"] = Effect.fn("WebStackResearch.read")(function* (input) {
    yield* ensureRoot;
    const output = yield* runNative({
      args: ["read", "--root", stateRoot],
      stdin: JSON.stringify({ request: input, config: {} }),
      maximumStdoutBytes: NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES,
      timeout: options.readTimeout ?? WEB_STACK_READ_TIMEOUT,
    });
    return yield* parseResponse(output, "read");
  });

  const deepResearch: WebStackResearchShape["deepResearch"] = Effect.fn(
    "WebStackResearch.deepResearch",
  )(function* (input) {
    yield* ensureRoot;
    const output = yield* runNative({
      args: ["deep-research", "--root", stateRoot],
      stdin: JSON.stringify({ request: input, config: {} }),
      maximumStdoutBytes: NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES,
      timeout: options.researchTimeouts?.[input.depth] ?? researchTimeoutForDepth(input.depth),
    });
    return yield* parseResponse(output, "deepResearch");
  });

  return WebStackResearch.of({ read, deepResearch });
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return yield* makeWithOptions({
    stateDir: config.stateDir,
    runtime: NativeProcess.productionRuntime(),
  });
});

export const layer = Layer.effect(WebStackResearch, make);

export const __testing = {
  make: makeWithOptions,
  parseResponse,
};
