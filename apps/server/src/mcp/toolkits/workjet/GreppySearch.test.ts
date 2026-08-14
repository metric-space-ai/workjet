import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GreppySearch from "./GreppySearch.ts";

const encoder = new TextEncoder();
const versionOutput = `greppy ${GreppySearch.GREPPY_VERSION}\n`;
const searchHelpOutput = "--root --json --limit --max-bytes";

interface CapturedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly extendEnv?: boolean;
    readonly shell?: boolean | string;
  };
}

function makeHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly never?: boolean;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: result.never
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(result.never === true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: result.never ? Stream.empty : Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: result.never ? Stream.empty : Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeSpawner(
  handler: (command: CapturedCommand, index: number) => ReturnType<typeof makeHandle>,
) {
  const commands: Array<CapturedCommand> = [];
  const service = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const captured = command as unknown as CapturedCommand;
      commands.push(captured);
      return handler(captured, commands.length - 1);
    }),
  );
  return { commands, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service) };
}

const semanticSearchJson = (overrides?: Record<string, unknown>) =>
  JSON.stringify({
    schema_version: "greppy.semantic-search.v1",
    status: "ok",
    hits: [
      {
        file: "src/retry.ts",
        line: 17,
        summary: ["Retries a failed request.", "Uses bounded exponential backoff."],
      },
      {
        file: "src/fallback.ts",
        summary: ["Provides a fallback without a source line."],
      },
    ],
    ...overrides,
  });

const successfulHandler = (command: CapturedCommand, _index: number) =>
  makeHandle({
    stdout:
      command.args[0] === "--version"
        ? versionOutput
        : command.args[0] === "search" && command.args[1] === "--help"
          ? searchHelpOutput
          : semanticSearchJson(),
  });

function makeService(input: {
  readonly storeDir?: string;
  readonly timeout?: Duration.Duration;
  readonly handler?: (command: CapturedCommand, index: number) => ReturnType<typeof makeHandle>;
}) {
  const spawner = makeSpawner(input.handler ?? successfulHandler);
  const service = GreppySearch.__testing
    .make({
      storeDir: input.storeDir ?? "/server/state/greppy",
      ...(input.timeout ? { timeout: input.timeout } : {}),
    })
    .pipe(Effect.provide(spawner.layer));
  return { ...spawner, service };
}

function assertCarriesNoSecret(value: unknown, secret: string): void {
  const seen = new WeakSet<object>();
  const walk = (current: unknown): void => {
    if (typeof current === "string") {
      assert.notInclude(current, secret);
      return;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) return;
    seen.add(current);
    walk((current as { message?: unknown }).message);
    walk((current as { cause?: unknown }).cause);
    for (const nested of Object.values(current)) walk(nested);
  };
  walk(value);
}

describe("GreppySearch", () => {
  it.effect("verifies 0.3.1 and the search surface, then runs bounded no-shell search", () =>
    Effect.gen(function* () {
      const test = makeService({});
      const greppy = yield* test.service;
      const result = yield* greppy.search({
        cwd: "/workspace/project",
        task: "find retry handling",
      });

      assert.deepEqual(result, {
        matches: [
          {
            path: "src/retry.ts",
            line: 17,
            excerpt: "Retries a failed request.\nUses bounded exponential backoff.",
          },
          {
            path: "src/fallback.ts",
            excerpt: "Provides a fallback without a source line.",
          },
        ],
      });
      assert.equal(test.commands.length, 3);
      assert.deepEqual(
        test.commands.map(({ command, args }) => ({ command, args })),
        [
          { command: "greppy", args: ["--version"] },
          { command: "greppy", args: ["search", "--help"] },
          {
            command: "greppy",
            args: [
              "search",
              "--root",
              "/workspace/project",
              "--json",
              "--limit",
              "20",
              "--max-bytes",
              "65536",
              "find retry handling",
            ],
          },
        ],
      );
      for (const command of test.commands) {
        assert.deepEqual(command.options.env, { GREPPY_STORE_DIR: "/server/state/greppy" });
        assert.equal(command.options.extendEnv, true);
        assert.equal(command.options.shell, false);
      }
      assert.equal(test.commands[2]?.options.cwd, "/workspace/project");
    }),
  );

  it.effect("maps at most 20 stable-schema hits", () =>
    Effect.gen(function* () {
      const hits = Array.from({ length: 25 }, (_, index) => ({
        file: `src/result-${index + 1}.ts`,
        line: index + 1,
        summary: [index === 0 ? "x".repeat(9_000) : `Result ${index + 1}`],
      }));
      const test = makeService({
        handler: (command) =>
          makeHandle({
            stdout:
              command.args[0] === "--version"
                ? versionOutput
                : command.args[0] === "search" && command.args[1] === "--help"
                  ? searchHelpOutput
                  : semanticSearchJson({ hits }),
          }),
      });
      const greppy = yield* test.service;
      const result = yield* greppy.search({ cwd: "/workspace/project", task: "find results" });

      assert.equal(result.matches.length, GreppySearch.GREPPY_SEARCH_LIMIT);
      assert.equal(result.matches[0]?.path, "src/result-1.ts");
      assert.equal(result.matches[0]?.excerpt.length, GreppySearch.GREPPY_EXCERPT_MAX_CHARS);
      assert.equal(result.matches[19]?.path, "src/result-20.ts");
    }),
  );

  it.effect("uses one server store across different thread and harness working directories", () =>
    Effect.gen(function* () {
      const test = makeService({ storeDir: "/t3-state/greppy" });
      const greppy = yield* test.service;
      yield* greppy.search({ cwd: "/worktrees/codex-thread", task: "first" });
      yield* greppy.search({ cwd: "/worktrees/claude-thread", task: "second" });

      const stores = new Set(test.commands.map((command) => command.options.env?.GREPPY_STORE_DIR));
      assert.deepEqual([...stores], ["/t3-state/greppy"]);
      assert.notInclude([...stores][0] ?? "", "thread");
      assert.notInclude([...stores][0] ?? "", "codex");
      assert.notInclude([...stores][0] ?? "", "claude");
    }),
  );

  it.effect("redacts sensitive stderr from nonzero process failures", () =>
    Effect.gen(function* () {
      const secret = "SENSITIVE_FAKE_STDERR_TOKEN";
      const test = makeService({
        handler: (_command, index) =>
          index < 2
            ? successfulHandler(_command, index)
            : makeHandle({ code: 9, stderr: `${secret} /private/store/path` }),
      });
      const greppy = yield* test.service;
      const error = yield* greppy
        .search({ cwd: "/workspace/project", task: "find retry handling" })
        .pipe(Effect.flip);

      assert.equal(error.reason, "process-exit");
      assertCarriesNoSecret(error, secret);
      assert.notInclude(JSON.stringify(error), secret);
    }),
  );

  it.effect("fails closed for version, surface, index, malformed, and oversized output", () =>
    Effect.gen(function* () {
      const cases = [
        {
          expected: "version-mismatch",
          handler: (_command: CapturedCommand, index: number) =>
            makeHandle({ stdout: index === 0 ? "greppy 0.4.0" : searchHelpOutput }),
        },
        {
          expected: "surface-mismatch",
          handler: (_command: CapturedCommand, index: number) =>
            makeHandle({ stdout: index === 0 ? versionOutput : "search without required flags" }),
        },
        {
          expected: "index-unavailable",
          handler: (_command: CapturedCommand, index: number) =>
            makeHandle({
              code: index === 2 ? 1 : 0,
              stdout:
                index === 0
                  ? versionOutput
                  : index === 1
                    ? searchHelpOutput
                    : semanticSearchJson({ status: "no_index", hits: [] }),
            }),
        },
        {
          expected: "malformed-response",
          handler: (_command: CapturedCommand, index: number) =>
            makeHandle({
              stdout: index === 0 ? versionOutput : index === 1 ? searchHelpOutput : "not-json",
            }),
        },
        {
          expected: "oversized-response",
          handler: (_command: CapturedCommand, index: number) =>
            makeHandle({
              stdout:
                index === 0
                  ? versionOutput
                  : index === 1
                    ? searchHelpOutput
                    : "x".repeat(GreppySearch.GREPPY_SEARCH_MAX_BYTES + 1),
            }),
        },
      ] as const;

      for (const testCase of cases) {
        const test = makeService({ handler: testCase.handler });
        const greppy = yield* test.service;
        const error = yield* greppy
          .search({ cwd: "/workspace/project", task: "find retry handling" })
          .pipe(Effect.flip);
        assert.equal(error.reason, testCase.expected);
      }
    }),
  );

  it.effect("reports missing binaries and bounded timeouts as typed failures", () =>
    Effect.gen(function* () {
      const missingSpawner = ChildProcessSpawner.make(() => Effect.fail({} as never));
      const missing = yield* GreppySearch.__testing
        .make({ storeDir: "/server/state/greppy" })
        .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, missingSpawner));
      const missingError = yield* missing
        .search({ cwd: "/workspace/project", task: "find retry handling" })
        .pipe(Effect.flip);
      assert.equal(missingError.reason, "binary-unavailable");

      const timeoutTest = makeService({
        timeout: Duration.millis(10),
        handler: () => makeHandle({ never: true }),
      });
      const timed = yield* timeoutTest.service;
      const fiber = yield* timed
        .search({ cwd: "/workspace/project", task: "find retry handling" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(11));
      const timeoutError = yield* Fiber.join(fiber);
      assert.equal(timeoutError.reason, "timeout");
    }),
  );
});
