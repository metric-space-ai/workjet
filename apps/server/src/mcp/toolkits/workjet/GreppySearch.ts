import {
  decodeGreppySemanticSearchV1,
  GREPPY_RUNTIME_PIN,
} from "@metric-space-ai/workjet-capabilities";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as GreppyRuntime from "./GreppyRuntime.ts";

export const GREPPY_BINARY = "greppy";
export const GREPPY_VERSION = GREPPY_RUNTIME_PIN.version;
export const GREPPY_SEARCH_LIMIT = 20;
export const GREPPY_SEARCH_MAX_BYTES = 65_536;
export const GREPPY_EXCERPT_MAX_CHARS = 8_000;
const GREPPY_TIMEOUT = Duration.seconds(30);

export const GreppySearchFailureReason = Schema.Literals([
  "binary-unavailable",
  "version-mismatch",
  "surface-mismatch",
  "index-unavailable",
  "timeout",
  "process-exit",
  "malformed-response",
  "oversized-response",
  "execution-failed",
]);
export type GreppySearchFailureReason = typeof GreppySearchFailureReason.Type;

export class GreppySearchError extends Schema.TaggedErrorClass<GreppySearchError>()(
  "GreppySearchError",
  { reason: GreppySearchFailureReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "binary-unavailable":
        return "Greppy search is unavailable on this server.";
      case "version-mismatch":
      case "surface-mismatch":
        return "The installed Greppy search runtime is incompatible.";
      case "index-unavailable":
        return "Greppy search is not ready for this working directory.";
      case "timeout":
        return "Greppy search timed out.";
      case "process-exit":
      case "execution-failed":
        return "Greppy search failed.";
      case "malformed-response":
      case "oversized-response":
        return "Greppy returned an invalid search response.";
    }
  }
}

export interface GreppySearchMatch {
  readonly path: string;
  readonly line?: number;
  readonly excerpt: string;
}

export interface GreppySearchResult {
  readonly matches: ReadonlyArray<GreppySearchMatch>;
}

export interface GreppySearchShape {
  readonly search: (input: {
    readonly cwd: string;
    readonly task: string;
  }) => Effect.Effect<GreppySearchResult, GreppySearchError>;
}

export class GreppySearch extends Context.Service<GreppySearch, GreppySearchShape>()(
  "t3/mcp/GreppySearch",
) {}

interface BoundedOutput {
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
}

interface ProcessOutput {
  readonly stdout: BoundedOutput;
  readonly stderrBytes: number;
  readonly exitCode: number;
}

const collectBounded = (
  stream: Stream.Stream<Uint8Array, unknown>,
  maximumBytes: number,
): Effect.Effect<BoundedOutput, unknown> =>
  Stream.runFold(
    stream,
    () => ({ chunks: [] as Array<Uint8Array>, storedBytes: 0, totalBytes: 0 }),
    (state, chunk) => {
      const remaining = Math.max(0, maximumBytes + 1 - state.storedBytes);
      const storedChunk = remaining === 0 ? undefined : chunk.slice(0, remaining);
      return {
        chunks: storedChunk ? [...state.chunks, storedChunk] : state.chunks,
        storedBytes: state.storedBytes + (storedChunk?.length ?? 0),
        totalBytes: state.totalBytes + chunk.length,
      };
    },
  ).pipe(
    Effect.map(({ chunks, storedBytes, totalBytes }) => {
      const bytes = new Uint8Array(storedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { bytes, totalBytes };
    }),
  );

const countBytes = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<number, unknown> =>
  Stream.runFold(
    stream,
    () => 0,
    (total, chunk) => total + chunk.length,
  );

const outputText = (output: BoundedOutput): string => new TextDecoder().decode(output.bytes);

const processError = (reason: GreppySearchFailureReason): GreppySearchError =>
  new GreppySearchError({ reason });

const runCommand = Effect.fn("GreppySearch.runCommand")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.Command,
  maximumStdoutBytes: number,
  timeout: Duration.Duration,
) {
  return yield* Effect.gen(function* () {
    const child = yield* spawner
      .spawn(command)
      .pipe(Effect.mapError(() => processError("binary-unavailable")));
    const [stdout, stderrBytes, exitCode] = yield* Effect.all(
      [
        collectBounded(child.stdout, maximumStdoutBytes),
        countBytes(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(() => processError("execution-failed")));
    return { stdout, stderrBytes, exitCode } satisfies ProcessOutput;
  }).pipe(
    Effect.scoped,
    Effect.timeout(timeout),
    Effect.catchTag("TimeoutError", () => Effect.fail(processError("timeout"))),
  );
});

const makeCommand = (
  executable: string,
  storeDir: string,
  args: ReadonlyArray<string>,
  cwd?: string,
): ChildProcess.Command =>
  ChildProcess.make(executable, args, {
    ...(cwd ? { cwd } : {}),
    env: { GREPPY_STORE_DIR: storeDir },
    extendEnv: true,
    shell: false,
  });

const excerptOf = (summary: ReadonlyArray<string>): string =>
  summary.join("\n").slice(0, GREPPY_EXCERPT_MAX_CHARS);

const parseSearchOutput = (
  output: ProcessOutput,
): Effect.Effect<GreppySearchResult, GreppySearchError> => {
  if (output.stdout.totalBytes > GREPPY_SEARCH_MAX_BYTES) {
    return Effect.fail(processError("oversized-response"));
  }
  return Effect.gen(function* () {
    const invalidResponseReason = output.exitCode === 0 ? "malformed-response" : "process-exit";
    const parsed = yield* Effect.try({
      try: () => JSON.parse(outputText(output.stdout)) as unknown,
      catch: () => processError(invalidResponseReason),
    });
    const response = yield* decodeGreppySemanticSearchV1(parsed).pipe(
      Effect.mapError(() => processError(invalidResponseReason)),
    );
    if (response.status !== "ok" && response.status !== "no_matches") {
      return yield* processError(
        response.status === "indexing" || response.status === "no_index"
          ? "index-unavailable"
          : "execution-failed",
      );
    }
    if (output.exitCode !== 0) {
      return yield* processError("process-exit");
    }
    return {
      matches: response.hits.slice(0, GREPPY_SEARCH_LIMIT).map((hit) => ({
        path: hit.file_path,
        line: hit.start_line,
        excerpt: excerptOf(hit.summary),
      })),
    };
  });
};

const makeWithOptions = Effect.fn("GreppySearch.make")(function* (options: {
  readonly runtime: GreppyRuntime.GreppyRuntimeShape;
  readonly timeout?: Duration.Duration;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const timeout = options.timeout ?? GREPPY_TIMEOUT;
  const search: GreppySearchShape["search"] = Effect.fn("GreppySearch.search")(function* (input) {
    const readiness = yield* options.runtime
      .ensureWorkspace(input.cwd)
      .pipe(
        Effect.mapError((error) =>
          processError(
            error.reason === "timeout"
              ? "timeout"
              : error.reason === "oversized-response"
                ? "oversized-response"
                : error.reason === "malformed-response"
                  ? "malformed-response"
                  : error.reason === "version-mismatch"
                    ? "version-mismatch"
                    : error.reason === "surface-mismatch"
                      ? "surface-mismatch"
                      : error.reason === "binary-unavailable" ||
                          error.reason === "path-unavailable" ||
                          error.reason === "override-invalid"
                        ? "binary-unavailable"
                        : "index-unavailable",
          ),
        ),
      );
    if (readiness.status !== "ready") {
      return yield* processError("index-unavailable");
    }
    const output = yield* runCommand(
      spawner,
      makeCommand(
        readiness.executable,
        readiness.storeDir,
        [
          "search",
          "--root",
          readiness.cwd,
          "--json",
          "--limit",
          String(GREPPY_SEARCH_LIMIT),
          "--max-bytes",
          String(GREPPY_SEARCH_MAX_BYTES),
          input.task,
        ],
        readiness.cwd,
      ),
      GREPPY_SEARCH_MAX_BYTES,
      timeout,
    );
    return yield* parseSearchOutput(output);
  });
  return GreppySearch.of({ search });
});

const make = Effect.gen(function* () {
  const runtime = yield* GreppyRuntime.GreppyRuntime;
  return yield* makeWithOptions({ runtime });
});

export const layer = Layer.effect(GreppySearch, make);

export const __testing = {
  make: makeWithOptions,
};
