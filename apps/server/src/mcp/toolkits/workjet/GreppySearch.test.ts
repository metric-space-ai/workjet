import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import type * as GreppyRuntime from "./GreppyRuntime.ts";
import * as GreppySearch from "./GreppySearch.ts";

const encoder = new TextEncoder();

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
    command: "search",
    status: "ok",
    hits: [
      {
        file_path: "src/retry.ts",
        start_line: 17,
        end_line: 23,
        summary: ["Retries a failed request.", "Uses bounded exponential backoff."],
      },
      {
        file_path: "src/fallback.ts",
        start_line: 9,
        summary: ["Provides a fallback."],
      },
    ],
    ...overrides,
  });

const readyRuntime = (overrides?: Partial<GreppyRuntime.GreppyRuntimeShape>) =>
  ({
    storeDir: "/server/state/greppy",
    resolve: () => Effect.die("search must use readiness"),
    inspect: () => Effect.die("unused"),
    install: () => Effect.die("unused"),
    ensureWorkspace: (cwd: string) =>
      Effect.succeed({
        executable: "/managed/private/greppy",
        source: "managed" as const,
        storeDir: "/server/state/greppy",
        cwd,
        status: "ready" as const,
      }),
    ...overrides,
  }) satisfies GreppyRuntime.GreppyRuntimeShape;

function makeService(input?: {
  readonly runtime?: GreppyRuntime.GreppyRuntimeShape;
  readonly timeout?: Duration.Duration;
  readonly handler?: (command: CapturedCommand, index: number) => ReturnType<typeof makeHandle>;
}) {
  const spawner = makeSpawner(
    input?.handler ?? (() => makeHandle({ stdout: semanticSearchJson() })),
  );
  const service = GreppySearch.__testing
    .make({
      runtime: input?.runtime ?? readyRuntime(),
      ...(input?.timeout ? { timeout: input.timeout } : {}),
    })
    .pipe(Effect.provide(spawner.layer));
  return { ...spawner, service };
}

function assertCarriesNoSecret(value: unknown, secret: string): void {
  assert.notInclude(JSON.stringify(value), secret);
  if (value instanceof Error) assert.notInclude(value.message, secret);
}

describe("GreppySearch", () => {
  it.effect("uses runtime readiness and its exact executable for one bounded no-shell search", () =>
    Effect.gen(function* () {
      const readinessCalls: Array<string> = [];
      const test = makeService({
        runtime: readyRuntime({
          ensureWorkspace: (cwd) => {
            readinessCalls.push(cwd);
            return Effect.succeed({
              executable: "/sensitive/resolved/greppy",
              source: "override",
              storeDir: "/t3-state/greppy",
              cwd: "/canonical/project",
              status: "ready",
            });
          },
        }),
      });
      const greppy = yield* test.service;
      const result = yield* greppy.search({ cwd: "/workspace/project", task: "find retries" });

      assert.deepEqual(readinessCalls, ["/workspace/project"]);
      assert.deepEqual(result, {
        matches: [
          {
            path: "src/retry.ts",
            line: 17,
            excerpt: "Retries a failed request.\nUses bounded exponential backoff.",
          },
          { path: "src/fallback.ts", line: 9, excerpt: "Provides a fallback." },
        ],
      });
      assert.equal(test.commands.length, 1);
      const [command] = test.commands;
      assert.equal(command?.command, "/sensitive/resolved/greppy");
      assert.deepEqual(command?.args, [
        "search",
        "--root",
        "/canonical/project",
        "--json",
        "--limit",
        "20",
        "--max-bytes",
        "65536",
        "find retries",
      ]);
      assert.equal(command?.options.cwd, "/canonical/project");
      assert.deepEqual(command?.options.env, { GREPPY_STORE_DIR: "/t3-state/greppy" });
      assert.equal(command?.options.extendEnv, true);
      assert.equal(command?.options.shell, false);
    }),
  );

  it.effect("maps at most 20 hits, bounds excerpts, and accepts no matches", () =>
    Effect.gen(function* () {
      const hits = Array.from({ length: 25 }, (_, index) => ({
        file_path: `src/result-${index + 1}.ts`,
        start_line: index + 1,
        summary: [index === 0 ? "x".repeat(9_000) : `Result ${index + 1}`],
      }));
      const test = makeService({
        handler: () => makeHandle({ stdout: semanticSearchJson({ hits }) }),
      });
      const greppy = yield* test.service;
      const result = yield* greppy.search({ cwd: "/workspace/project", task: "results" });
      assert.equal(result.matches.length, 20);
      assert.equal(result.matches[0]?.excerpt.length, 8_000);
      assert.equal(result.matches[19]?.path, "src/result-20.ts");

      const empty = makeService({
        handler: () =>
          makeHandle({ stdout: semanticSearchJson({ status: "no_matches", hits: [] }) }),
      });
      assert.deepEqual(
        yield* (yield* empty.service).search({ cwd: "/workspace/project", task: "absent" }),
        { matches: [] },
      );
    }),
  );

  it.effect("fails closed for indexing, malformed, oversized, and nonzero search output", () =>
    Effect.gen(function* () {
      const indexing = makeService({
        runtime: readyRuntime({
          ensureWorkspace: () =>
            Effect.succeed({
              executable: "/managed/greppy",
              source: "managed",
              storeDir: "/state/greppy",
              cwd: "/workspace",
              status: "indexing",
            }),
        }),
      });
      assert.equal(
        (yield* (yield* indexing.service)
          .search({ cwd: "/workspace", task: "x" })
          .pipe(Effect.flip)).reason,
        "index-unavailable",
      );
      assert.equal(indexing.commands.length, 0);

      const cases = [
        { expected: "malformed-response", handle: makeHandle({ stdout: "not-json" }) },
        {
          expected: "oversized-response",
          handle: makeHandle({ stdout: "x".repeat(GreppySearch.GREPPY_SEARCH_MAX_BYTES + 1) }),
        },
        {
          expected: "process-exit",
          handle: makeHandle({ code: 9, stdout: semanticSearchJson() }),
        },
      ] as const;
      for (const testCase of cases) {
        const test = makeService({ handler: () => testCase.handle });
        const error = yield* (yield* test.service)
          .search({ cwd: "/workspace", task: "x" })
          .pipe(Effect.flip);
        assert.equal(error.reason, testCase.expected);
      }
    }),
  );

  it.effect("redacts sensitive process output and reports bounded timeouts", () =>
    Effect.gen(function* () {
      const secret = "SENSITIVE_FAKE_STDERR_AND_PATH";
      const failed = makeService({
        handler: () => makeHandle({ code: 7, stderr: `${secret} /private/compiler/output` }),
      });
      const error = yield* (yield* failed.service)
        .search({ cwd: "/workspace", task: "x" })
        .pipe(Effect.flip);
      assert.equal(error.reason, "process-exit");
      assertCarriesNoSecret(error, secret);

      const timed = makeService({
        timeout: Duration.millis(10),
        handler: () => makeHandle({ never: true }),
      });
      const fiber = yield* (yield* timed.service)
        .search({ cwd: "/workspace", task: "x" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(11));
      assert.equal((yield* Fiber.join(fiber)).reason, "timeout");
    }),
  );
});
