import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const WORKJET_WEB_STACK_EXECUTABLE_ENV = "WORKJET_WEB_STACK_EXECUTABLE";
export const WEB_STACK_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_STACK_STDERR_MAX_BYTES = 64 * 1024;
export const WEB_STACK_PROBE_MAX_BYTES = 256;

export type WebStackNativeFailureReason =
  | "binary-unavailable"
  | "version-mismatch"
  | "timeout"
  | "process-exit"
  | "malformed-response"
  | "oversized-response"
  | "execution-failed";

export interface WebStackRuntimeBoundary {
  readonly executableCandidates: ReadonlyArray<string>;
  readonly isExecutable: (candidate: string) => Promise<boolean>;
  readonly makeDirectory: (path: string) => Promise<void>;
}

export interface BoundedOutput {
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
}

export interface ProcessOutput {
  readonly stdout: BoundedOutput;
  readonly stderrBytes: number;
  readonly exitCode: number;
}

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

export const productionRuntime = (): WebStackRuntimeBoundary => ({
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

export const outputText = (output: BoundedOutput): string => new TextDecoder().decode(output.bytes);

export const runCommand = <E>(input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly maximumStdoutBytes: number;
  readonly timeout: Duration.Duration;
  readonly failure: (reason: WebStackNativeFailureReason) => E;
}): Effect.Effect<ProcessOutput, E> =>
  Effect.gen(function* () {
    const child = yield* input.spawner
      .spawn(ChildProcess.make(input.executable, input.args, { shell: false }))
      .pipe(Effect.mapError(() => input.failure("binary-unavailable")));
    const writeStdin =
      input.stdin === undefined
        ? Effect.void
        : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
            Effect.mapError(() => input.failure("execution-failed")),
          );
    const [stdout, stderrBytes, exitCode] = yield* Effect.all(
      [
        collectBounded(child.stdout, input.maximumStdoutBytes),
        drainBounded(child.stderr, WEB_STACK_STDERR_MAX_BYTES),
        child.exitCode.pipe(Effect.map(Number)),
        writeStdin,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(() => input.failure("execution-failed")));
    return { stdout, stderrBytes, exitCode };
  }).pipe(
    Effect.scoped,
    Effect.timeout(input.timeout),
    Effect.catchTag("TimeoutError", () => Effect.fail(input.failure("timeout"))),
  );

export const makeProbedRunner = <E>(options: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly runtime: WebStackRuntimeBoundary;
  readonly probeArgs: ReadonlyArray<string>;
  readonly expectedSurfaceVersion: string;
  readonly probeTimeout: Duration.Duration;
  readonly failure: (reason: WebStackNativeFailureReason) => E;
}) => {
  let resolvedExecutable: string | undefined;
  const probeExecutable = Effect.gen(function* () {
    let lastFailure: E | undefined;
    for (const candidate of options.runtime.executableCandidates) {
      const available = yield* Effect.tryPromise({
        try: () => options.runtime.isExecutable(candidate),
        catch: () => options.failure("binary-unavailable"),
      }).pipe(Effect.orElseSucceed(() => false));
      if (!available) continue;
      const probe = yield* runCommand({
        spawner: options.spawner,
        executable: candidate,
        args: options.probeArgs,
        maximumStdoutBytes: WEB_STACK_PROBE_MAX_BYTES,
        timeout: options.probeTimeout,
        failure: options.failure,
      }).pipe(Effect.result);
      if (Result.isFailure(probe)) {
        lastFailure = probe.failure;
        continue;
      }
      if (probe.success.stdout.totalBytes > WEB_STACK_PROBE_MAX_BYTES) {
        lastFailure = options.failure("oversized-response");
        continue;
      }
      if (probe.success.exitCode !== 0) {
        lastFailure = options.failure("process-exit");
        continue;
      }
      if (outputText(probe.success.stdout) !== options.expectedSurfaceVersion) {
        lastFailure = options.failure("version-mismatch");
        continue;
      }
      return candidate;
    }
    return yield* Effect.fail(lastFailure ?? options.failure("binary-unavailable"));
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

  return (input: {
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly maximumStdoutBytes: number;
    readonly timeout: Duration.Duration;
  }): Effect.Effect<ProcessOutput, E> =>
    resolveExecutable.pipe(
      Effect.flatMap((executable) =>
        runCommand({
          ...input,
          spawner: options.spawner,
          executable,
          failure: options.failure,
        }),
      ),
    );
};
