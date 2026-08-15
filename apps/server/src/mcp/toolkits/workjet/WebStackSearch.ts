import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../../config.ts";

export const WORKJET_WEB_STACK_EXECUTABLE_ENV = "WORKJET_WEB_STACK_EXECUTABLE";
export const WEB_STACK_SURFACE_VERSION = "workjet-web-stack-json-v1\n";
export const WEB_STACK_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_STACK_RESULT_LIMIT = 100;
export const WEB_STACK_TITLE_MAX_CHARS = 2_000;
export const WEB_STACK_URL_MAX_CHARS = 8_000;
export const WEB_STACK_SNIPPET_MAX_CHARS = 8_000;
const WEB_STACK_STDERR_MAX_BYTES = 64 * 1024;
const WEB_STACK_PROBE_MAX_BYTES = 256;
const WEB_STACK_TIMEOUT = Duration.seconds(60);
const WEB_STACK_PROBE_TIMEOUT = Duration.seconds(10);

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

export interface WebStackRuntimeBoundary {
  readonly executableCandidates: ReadonlyArray<string>;
  readonly isExecutable: (candidate: string) => Promise<boolean>;
  readonly makeDirectory: (path: string) => Promise<void>;
}

interface BoundedOutput {
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
}

interface ProcessOutput {
  readonly stdout: BoundedOutput;
  readonly stderrBytes: number;
  readonly exitCode: number;
}

const failure = (reason: WebStackSearchFailureReason): WebStackSearchError =>
  new WebStackSearchError({ reason });

const unique = (values: ReadonlyArray<string | undefined>): ReadonlyArray<string> => [
  ...new Set(values.filter((value): value is string => value !== undefined && value.length > 0)),
];

export const executableCandidates = (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly cwd: string;
  readonly moduleDirectory: string;
}): ReadonlyArray<string> => {
  const executableName = input.platform === "win32" ? "workjet-web-stack.exe" : "workjet-web-stack";
  const override = input.environment[WORKJET_WEB_STACK_EXECUTABLE_ENV]?.trim();
  const pathCandidates = (input.environment.PATH ?? "")
    .split(NodePath.delimiter)
    .filter((directory) => directory.length > 0)
    .map((directory) => NodePath.join(directory, executableName));
  return unique([
    override || undefined,
    ...pathCandidates,
    NodePath.resolve(input.moduleDirectory, "web-stack", executableName),
    NodePath.resolve(input.moduleDirectory, executableName),
    NodePath.resolve(input.moduleDirectory, "../web-stack", executableName),
    NodePath.resolve(
      input.moduleDirectory,
      "../../../../../../native/web-stack/target/release",
      executableName,
    ),
    NodePath.resolve(
      input.moduleDirectory,
      "../../../../../../native/web-stack/target/debug",
      executableName,
    ),
    NodePath.resolve(input.cwd, "native/web-stack/target/release", executableName),
    NodePath.resolve(input.cwd, "native/web-stack/target/debug", executableName),
  ]);
};

const productionRuntime = (): WebStackRuntimeBoundary => ({
  executableCandidates: executableCandidates({
    environment: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    moduleDirectory: import.meta.dirname,
  }),
  isExecutable: async (candidate) => {
    try {
      const stat = await NodeFs.stat(candidate);
      if (!stat.isFile()) return false;
      if (process.platform !== "win32") await NodeFs.access(candidate, NodeFs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  makeDirectory: async (path) => {
    await NodeFs.mkdir(path, { recursive: true });
  },
});

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

const drainBounded = (
  stream: Stream.Stream<Uint8Array, unknown>,
  maximumBytes: number,
): Effect.Effect<number, unknown> =>
  Stream.runFold(
    stream,
    () => 0,
    (total, chunk) => Math.min(maximumBytes + 1, total + chunk.length),
  );

const outputText = (output: BoundedOutput): string => new TextDecoder().decode(output.bytes);

const runCommand = Effect.fn("WebStackSearch.runCommand")(function* (input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly maximumStdoutBytes: number;
  readonly timeout: Duration.Duration;
}) {
  return yield* Effect.gen(function* () {
    const child = yield* input.spawner
      .spawn(ChildProcess.make(input.executable, input.args, { shell: false }))
      .pipe(Effect.mapError(() => failure("binary-unavailable")));
    const writeStdin =
      input.stdin === undefined
        ? Effect.void
        : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
            Effect.mapError(() => failure("execution-failed")),
          );
    const [stdout, stderrBytes, exitCode] = yield* Effect.all(
      [
        collectBounded(child.stdout, input.maximumStdoutBytes),
        drainBounded(child.stderr, WEB_STACK_STDERR_MAX_BYTES),
        child.exitCode.pipe(Effect.map(Number)),
        writeStdin,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(() => failure("execution-failed")));
    return { stdout, stderrBytes, exitCode } satisfies ProcessOutput;
  }).pipe(
    Effect.scoped,
    Effect.timeout(input.timeout),
    Effect.catchTag("TimeoutError", () => Effect.fail(failure("timeout"))),
  );
});

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

  let resolvedExecutable: string | undefined;
  const probeExecutable = Effect.gen(function* () {
    let lastFailure: WebStackSearchError | undefined;
    for (const candidate of options.runtime.executableCandidates) {
      const available = yield* Effect.tryPromise({
        try: () => options.runtime.isExecutable(candidate),
        catch: () => failure("binary-unavailable"),
      }).pipe(Effect.orElseSucceed(() => false));
      if (!available) continue;
      const probe = yield* runCommand({
        spawner,
        executable: candidate,
        args: ["--surface-version"],
        maximumStdoutBytes: WEB_STACK_PROBE_MAX_BYTES,
        timeout: probeTimeout,
      }).pipe(Effect.result);
      if (Result.isFailure(probe)) {
        lastFailure = probe.failure;
        continue;
      }
      if (probe.success.stdout.totalBytes > WEB_STACK_PROBE_MAX_BYTES) {
        lastFailure = failure("oversized-response");
        continue;
      }
      if (probe.success.exitCode !== 0) {
        lastFailure = failure("process-exit");
        continue;
      }
      if (outputText(probe.success.stdout) !== WEB_STACK_SURFACE_VERSION) {
        lastFailure = failure("version-mismatch");
        continue;
      }
      return candidate;
    }
    return yield* Effect.fail(lastFailure ?? failure("binary-unavailable"));
  });
  const resolveExecutable = Effect.suspend(() =>
    resolvedExecutable === undefined
      ? probeExecutable.pipe(
          Effect.tap((executable) =>
            Effect.sync(() => {
              resolvedExecutable = executable;
            }),
          ),
        )
      : Effect.succeed(resolvedExecutable),
  );

  const search: WebStackSearchShape["search"] = Effect.fn("WebStackSearch.search")(
    function* (input) {
      yield* Effect.tryPromise({
        try: () => options.runtime.makeDirectory(stateRoot),
        catch: () => failure("execution-failed"),
      });
      const executable = yield* resolveExecutable;
      const request = JSON.stringify({ request: { query: input.query }, config: {} });
      const output = yield* runCommand({
        spawner,
        executable,
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
  return yield* makeWithOptions({ stateDir: config.stateDir, runtime: productionRuntime() });
});

export const layer = Layer.effect(WebStackSearch, make);

export const __testing = {
  make: makeWithOptions,
  parseResponse,
};
