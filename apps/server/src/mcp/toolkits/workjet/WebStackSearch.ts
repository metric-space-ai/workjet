import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../../config.ts";
import * as NativeProcess from "./WebStackNativeProcess.ts";

export const WORKJET_WEB_STACK_EXECUTABLE_ENV = NativeProcess.WORKJET_WEB_STACK_EXECUTABLE_ENV;
export const WEB_STACK_SURFACE_VERSION = "workjet-web-stack-json-v1\n";
export const WEB_STACK_RESPONSE_MAX_BYTES = NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES;
export const WEB_STACK_RESULT_LIMIT = 100;
export const WEB_STACK_TITLE_MAX_CHARS = 2_000;
export const WEB_STACK_URL_MAX_CHARS = 8_000;
export const WEB_STACK_SNIPPET_MAX_CHARS = 8_000;
const WEB_STACK_TIMEOUT = Duration.seconds(60);
const WEB_STACK_PROBE_TIMEOUT = Duration.seconds(10);

type ProcessOutput = NativeProcess.ProcessOutput;
const outputText = NativeProcess.outputText;

export const WebStackSearchFailureReason = Schema.Literals([
  "binary-unavailable",
  "version-mismatch",
  "timeout",
  "process-exit",
  "malformed-response",
  "oversized-response",
  "execution-failed",
]);
export type WebStackSearchFailureReason = typeof WebStackSearchFailureReason.Type;

export class WebStackSearchError extends Schema.TaggedErrorClass<WebStackSearchError>()(
  "WebStackSearchError",
  { reason: WebStackSearchFailureReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "binary-unavailable":
        return "Web Search is unavailable on this server.";
      case "version-mismatch":
        return "The installed Web Search runtime is incompatible.";
      case "timeout":
        return "Web Search timed out.";
      case "process-exit":
      case "execution-failed":
        return "Web Search failed.";
      case "malformed-response":
      case "oversized-response":
        return "Web Search returned an invalid response.";
    }
  }
}

export interface WebStackSearchResultEntry {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebStackSearchResult {
  readonly results: ReadonlyArray<WebStackSearchResultEntry>;
}

export interface WebStackSearchShape {
  readonly search: (input: {
    readonly query: string;
  }) => Effect.Effect<WebStackSearchResult, WebStackSearchError>;
}

export class WebStackSearch extends Context.Service<WebStackSearch, WebStackSearchShape>()(
  "t3/mcp/WebStackSearch",
) {}

export type WebStackRuntimeBoundary = NativeProcess.WebStackRuntimeBoundary;
export const executableCandidates = NativeProcess.executableCandidates;

const failure = (reason: WebStackSearchFailureReason): WebStackSearchError =>
  new WebStackSearchError({ reason });

const truncateChars = (value: string, maximum: number): string =>
  Array.from(value).slice(0, maximum).join("");

const parseResponse = (
  output: ProcessOutput,
): Effect.Effect<WebStackSearchResult, WebStackSearchError> => {
  if (output.stdout.totalBytes > WEB_STACK_RESPONSE_MAX_BYTES) {
    return Effect.fail(failure("oversized-response"));
  }
  if (output.exitCode !== 0) return Effect.fail(failure("process-exit"));
  return Effect.gen(function* () {
    const value = yield* Effect.try({
      try: () => JSON.parse(outputText(output.stdout)) as unknown,
      catch: () => failure("malformed-response"),
    });
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return yield* failure("malformed-response");
    }
    const record = value as Record<string, unknown>;
    if (record.ok !== true || !Array.isArray(record.results)) {
      return yield* failure("malformed-response");
    }
    const results: Array<WebStackSearchResultEntry> = [];
    for (const entry of record.results.slice(0, WEB_STACK_RESULT_LIMIT)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return yield* failure("malformed-response");
      }
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.title !== "string" ||
        typeof candidate.url !== "string" ||
        candidate.url.length === 0 ||
        typeof candidate.snippet !== "string"
      ) {
        return yield* failure("malformed-response");
      }
      results.push({
        title: truncateChars(candidate.title, WEB_STACK_TITLE_MAX_CHARS),
        url: truncateChars(candidate.url, WEB_STACK_URL_MAX_CHARS),
        snippet: truncateChars(candidate.snippet, WEB_STACK_SNIPPET_MAX_CHARS),
      });
    }
    return { results };
  });
};

const makeWithOptions = Effect.fn("WebStackSearch.make")(function* (options: {
  readonly stateDir: string;
  readonly runtime: WebStackRuntimeBoundary;
  readonly timeout?: Duration.Duration;
  readonly probeTimeout?: Duration.Duration;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stateRoot = NodePath.join(options.stateDir, "web-stack");
  const timeout = options.timeout ?? WEB_STACK_TIMEOUT;
  const probeTimeout = options.probeTimeout ?? WEB_STACK_PROBE_TIMEOUT;

  const runNative = NativeProcess.makeProbedRunner({
    spawner,
    runtime: options.runtime,
    probeArgs: ["--surface-version"],
    expectedSurfaceVersion: WEB_STACK_SURFACE_VERSION,
    probeTimeout,
    failure,
  });

  const search: WebStackSearchShape["search"] = Effect.fn("WebStackSearch.search")(
    function* (input) {
      yield* Effect.tryPromise({
        try: () => options.runtime.makeDirectory(stateRoot),
        catch: () => failure("execution-failed"),
      });
      const request = JSON.stringify({ request: { query: input.query }, config: {} });
      const output = yield* runNative({
        args: ["search", "--root", stateRoot],
        stdin: request,
        maximumStdoutBytes: WEB_STACK_RESPONSE_MAX_BYTES,
        timeout,
      });
      return yield* parseResponse(output);
    },
  );
  return WebStackSearch.of({ search });
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return yield* makeWithOptions({
    stateDir: config.stateDir,
    runtime: NativeProcess.productionRuntime(),
  });
});

export const layer = Layer.effect(WebStackSearch, make);

export const __testing = {
  make: makeWithOptions,
  parseResponse,
};
