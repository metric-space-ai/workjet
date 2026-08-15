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

export type WebReadResult = Readonly<Record<string, unknown>>;
export type WebDeepResearchResult = Readonly<Record<string, unknown>>;

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

const parseResponse = (
  output: NativeProcess.ProcessOutput,
  operation: "read" | "deepResearch",
): Effect.Effect<Readonly<Record<string, unknown>>, WebStackResearchError> => {
  if (output.stdout.totalBytes > NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES) {
    return Effect.fail(failure("oversized-response"));
  }
  if (output.exitCode !== 0) return Effect.fail(failure("process-exit"));
  return Effect.try({
    try: () => {
      const value = JSON.parse(NativeProcess.outputText(output.stdout)) as unknown;
      if (!isRecord(value) || value.ok !== true || value.operation !== operation) {
        throw new Error("invalid response");
      }
      const { ok: _ok, ...result } = value;
      return result;
    },
    catch: () => failure("malformed-response"),
  });
};

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
