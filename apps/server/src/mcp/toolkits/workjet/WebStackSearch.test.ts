import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as WebStackSearch from "./WebStackSearch.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

interface HandleResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly never?: boolean;
}

function makeHandle(result: HandleResult, stdin: Array<string>) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: result.never
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(result.never === true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => {
        stdin.push(decoder.decode(chunk, { stream: true }));
      }),
    ),
    stdout: result.never ? Stream.empty : Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: result.never ? Stream.empty : Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeSpawner(handler: (command: CapturedCommand, index: number) => HandleResult) {
  const commands: Array<CapturedCommand> = [];
  const stdin: Array<Array<string>> = [];
  const service = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const captured = command as unknown as CapturedCommand;
      const index = commands.length;
      commands.push(captured);
      const written: Array<string> = [];
      stdin.push(written);
      return makeHandle(handler(captured, index), written);
    }),
  );
  return {
    commands,
    stdin,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service),
  };
}

const nativeResponse = (results: ReadonlyArray<Record<string, unknown>> = []) =>
  jsonText({ ok: true, tool: "ctox_web_search", results });

function makeService(input?: {
  readonly stateDir?: string;
  readonly candidates?: ReadonlyArray<string>;
  readonly isExecutable?: (candidate: string) => Promise<boolean>;
  readonly makeDirectory?: (path: string) => Promise<void>;
  readonly timeout?: Duration.Duration;
  readonly probeTimeout?: Duration.Duration;
  readonly handler?: (command: CapturedCommand, index: number) => HandleResult;
}) {
  const directories: Array<string> = [];
  const spawner = makeSpawner(
    input?.handler ??
      ((_command, index) =>
        index === 0
          ? { stdout: WebStackSearch.WEB_STACK_SURFACE_VERSION }
          : { stdout: nativeResponse() }),
  );
  const service = WebStackSearch.__testing
    .make({
      stateDir: input?.stateDir ?? "/server/state",
      runtime: {
        executableCandidates: input?.candidates ?? ["/opt/workjet-web-stack"],
        isExecutable: input?.isExecutable ?? (async () => true),
        makeDirectory:
          input?.makeDirectory ??
          (async (path) => {
            directories.push(path);
          }),
      },
      ...(input?.timeout ? { timeout: input.timeout } : {}),
      ...(input?.probeTimeout ? { probeTimeout: input.probeTimeout } : {}),
    })
    .pipe(Effect.provide(spawner.layer));
  return { ...spawner, directories, service };
}

function assertCarriesNoSecret(value: unknown, secret: string): void {
  assert.notInclude(jsonText(value), secret);
  if (value instanceof Error) assert.notInclude(value.message, secret);
}

const search = (service: Effect.Effect<WebStackSearch.WebStackSearchShape>) =>
  Effect.gen(function* () {
    return yield* service;
  });

describe("WebStackSearch", () => {
  it("orders executable overrides, PATH entries, and source/package candidates", () => {
    const candidates = WebStackSearch.executableCandidates({
      environment: {
        WORKJET_WEB_STACK_EXECUTABLE: " /admin/workjet-web-stack ",
        PATH: "/first/bin:/second/bin",
      },
      platform: "darwin",
      cwd: "/checkout",
      moduleDirectory: "/checkout/apps/server/src/mcp/toolkits/workjet",
    });

    assert.deepEqual(candidates.slice(0, 3), [
      "/admin/workjet-web-stack",
      "/first/bin/workjet-web-stack",
      "/second/bin/workjet-web-stack",
    ]);
    assert.include(candidates, "/checkout/native/web-stack/target/release/workjet-web-stack");
    assert.include(candidates, "/checkout/native/web-stack/target/debug/workjet-web-stack");
  });

  it.effect("probes lazily, then uses exact executable, argv, stdin, root, and no shell", () =>
    Effect.gen(function* () {
      const test = makeService({
        stateDir: "/server-owned/state",
        handler: (_command, index) =>
          index === 0
            ? { stdout: WebStackSearch.WEB_STACK_SURFACE_VERSION }
            : {
                stdout: nativeResponse([
                  {
                    title: "Rust",
                    url: "https://www.rust-lang.org/",
                    snippet: "A language empowering everyone.",
                  },
                ]),
                stderr: "bounded native diagnostic",
              },
      });
      assert.equal(test.commands.length, 0);

      const webSearch = yield* search(test.service);
      const result = yield* webSearch.search({ query: "rust language" });

      assert.deepEqual(result, {
        results: [
          {
            title: "Rust",
            url: "https://www.rust-lang.org/",
            snippet: "A language empowering everyone.",
          },
        ],
      });
      assert.deepEqual(test.directories, ["/server-owned/state/web-stack"]);
      assert.equal(test.commands.length, 2);
      assert.equal(test.commands[0]?.command, "/opt/workjet-web-stack");
      assert.deepEqual(test.commands[0]?.args, ["--surface-version"]);
      assert.equal(test.commands[0]?.options.shell, false);
      assert.equal(test.stdin[0]?.join(""), "");
      assert.equal(test.commands[1]?.command, "/opt/workjet-web-stack");
      assert.deepEqual(test.commands[1]?.args, [
        "search",
        "--root",
        "/server-owned/state/web-stack",
      ]);
      assert.equal(test.commands[1]?.options.shell, false);
      assert.equal(test.stdin[1]?.join(""), '{"request":{"query":"rust language"},"config":{}}');
    }),
  );

  it.effect("enforces the exact surface version before any search", () =>
    Effect.gen(function* () {
      for (const output of [
        "workjet-web-stack-json-v1",
        "workjet-web-stack-json-v2\n",
        `${WebStackSearch.WEB_STACK_SURFACE_VERSION}extra`,
      ]) {
        const test = makeService({ handler: () => ({ stdout: output }) });
        const error = yield* (yield* search(test.service))
          .search({ query: "version" })
          .pipe(Effect.flip);
        assert.equal(error.reason, "version-mismatch");
        assert.equal(test.commands.length, 1);
        assert.deepEqual(test.commands[0]?.args, ["--surface-version"]);
      }
    }),
  );

  it.effect("retries an unavailable runtime and caches only a successful resolution", () =>
    Effect.gen(function* () {
      let available = false;
      const test = makeService({
        candidates: ["/late/workjet-web-stack"],
        isExecutable: async () => available,
      });
      const webSearch = yield* search(test.service);

      const unavailable = yield* webSearch.search({ query: "before install" }).pipe(Effect.flip);
      assert.equal(unavailable.reason, "binary-unavailable");
      assert.equal(test.commands.length, 0);

      available = true;
      assert.deepEqual(yield* webSearch.search({ query: "after install" }), { results: [] });
      assert.deepEqual(yield* webSearch.search({ query: "cached success" }), { results: [] });
      assert.equal(test.commands.length, 3);
      assert.deepEqual(test.commands[0]?.args, ["--surface-version"]);
      assert.deepEqual(test.commands[1]?.args, ["search", "--root", "/server/state/web-stack"]);
      assert.deepEqual(test.commands[2]?.args, ["search", "--root", "/server/state/web-stack"]);
    }),
  );

  it.effect("maps every typed failure reason without leaking process or request data", () =>
    Effect.gen(function* () {
      const secret = "SENSITIVE_QUERY_STDOUT_STDERR_PATH";
      const cases: ReadonlyArray<{
        readonly expected: WebStackSearch.WebStackSearchFailureReason;
        readonly make: () => ReturnType<typeof makeService>;
      }> = [
        {
          expected: "binary-unavailable",
          make: () =>
            makeService({
              candidates: ["/private/missing-workjet-web-stack"],
              isExecutable: async () => false,
            }),
        },
        {
          expected: "version-mismatch",
          make: () => makeService({ handler: () => ({ stdout: `${secret}-wrong-version` }) }),
        },
        {
          expected: "process-exit",
          make: () =>
            makeService({
              handler: (_command, index) =>
                index === 0
                  ? { stdout: WebStackSearch.WEB_STACK_SURFACE_VERSION }
                  : { code: 7, stdout: secret, stderr: `${secret}/stderr` },
            }),
        },
        {
          expected: "malformed-response",
          make: () =>
            makeService({
              handler: (_command, index) =>
                index === 0
                  ? { stdout: WebStackSearch.WEB_STACK_SURFACE_VERSION }
                  : { stdout: `${secret}-not-json`, stderr: secret },
            }),
        },
        {
          expected: "oversized-response",
          make: () =>
            makeService({
              handler: (_command, index) =>
                index === 0
                  ? { stdout: WebStackSearch.WEB_STACK_SURFACE_VERSION }
                  : { stdout: "x".repeat(WebStackSearch.WEB_STACK_RESPONSE_MAX_BYTES + 1) },
            }),
        },
        {
          expected: "execution-failed",
          make: () =>
            makeService({
              makeDirectory: async () => {
                throw new Error(`${secret}/mkdir`);
              },
            }),
        },
      ];

      for (const testCase of cases) {
        const test = testCase.make();
        const error = yield* (yield* search(test.service))
          .search({ query: secret })
          .pipe(Effect.flip);
        assert.equal(error.reason, testCase.expected);
        assertCarriesNoSecret(error, secret);
      }

      const timed = makeService({
        timeout: Duration.millis(10),
        handler: (_command, index) =>
          index === 0 ? { stdout: WebStackSearch.WEB_STACK_SURFACE_VERSION } : { never: true },
      });
      const fiber = yield* (yield* search(timed.service))
        .search({ query: secret })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(11));
      const timeout = yield* Fiber.join(fiber);
      assert.equal(timeout.reason, "timeout");
      assertCarriesNoSecret(timeout, secret);
    }),
  );

  it.effect("rejects malformed native result structures rather than partially trusting them", () =>
    Effect.gen(function* () {
      const malformed = [
        "null",
        "[]",
        jsonText({ ok: false, results: [] }),
        jsonText({ ok: true }),
        jsonText({ ok: true, results: [null] }),
        jsonText({ ok: true, results: [{ title: 7, url: "https://x", snippet: "x" }] }),
        jsonText({ ok: true, results: [{ title: "x", url: "", snippet: "x" }] }),
        jsonText({ ok: true, results: [{ title: "x", url: "https://x", snippet: null }] }),
      ];

      for (const stdout of malformed) {
        const test = makeService({
          handler: (_command, index) =>
            index === 0 ? { stdout: WebStackSearch.WEB_STACK_SURFACE_VERSION } : { stdout },
        });
        const error = yield* (yield* search(test.service))
          .search({ query: "malformed" })
          .pipe(Effect.flip);
        assert.equal(error.reason, "malformed-response");
      }
    }),
  );

  it.effect("normalizes to manifest fields, character maxima, and 100 results", () =>
    Effect.gen(function* () {
      const entries = Array.from({ length: 105 }, (_, index) => ({
        title:
          index === 0
            ? "😀".repeat(WebStackSearch.WEB_STACK_TITLE_MAX_CHARS + 1)
            : `Title ${index}`,
        url:
          index === 0
            ? `https://example.test/${"u".repeat(WebStackSearch.WEB_STACK_URL_MAX_CHARS)}`
            : `https://example.test/${index}`,
        snippet:
          index === 0
            ? "s".repeat(WebStackSearch.WEB_STACK_SNIPPET_MAX_CHARS + 1)
            : `Snippet ${index}`,
        source: "must-not-cross-manifest-boundary",
      }));
      const test = makeService({
        handler: (_command, index) =>
          index === 0
            ? { stdout: WebStackSearch.WEB_STACK_SURFACE_VERSION }
            : { stdout: nativeResponse(entries) },
      });
      const result = yield* (yield* search(test.service)).search({ query: "normalize" });

      assert.equal(result.results.length, WebStackSearch.WEB_STACK_RESULT_LIMIT);
      assert.equal(
        Array.from(result.results[0]?.title ?? "").length,
        WebStackSearch.WEB_STACK_TITLE_MAX_CHARS,
      );
      assert.equal(
        Array.from(result.results[0]?.url ?? "").length,
        WebStackSearch.WEB_STACK_URL_MAX_CHARS,
      );
      assert.equal(
        Array.from(result.results[0]?.snippet ?? "").length,
        WebStackSearch.WEB_STACK_SNIPPET_MAX_CHARS,
      );
      assert.deepEqual(Object.keys(result.results[0] ?? {}).sort(), ["snippet", "title", "url"]);
      assert.equal(result.results[99]?.title, "Title 99");
    }),
  );

  it.effect("uses one cached binary and the same shared server root for every search", () =>
    Effect.gen(function* () {
      const identifiers = [
        "thread-private-123",
        "harness-private-456",
        "provider-session-private-789",
        "environment-private-012",
        "provider-instance-private-345",
      ];
      const test = makeService({ stateDir: "/srv/t3/userdata" });
      const webSearch = yield* search(test.service);
      for (const query of identifiers) yield* webSearch.search({ query });

      assert.equal(test.commands.length, identifiers.length + 1);
      assert.deepEqual(test.commands[0]?.args, ["--surface-version"]);
      const roots = test.commands.slice(1).map((command) => command.args[2]);
      assert.deepEqual(
        roots,
        identifiers.map(() => "/srv/t3/userdata/web-stack"),
      );
      assert.deepEqual(
        test.directories,
        identifiers.map(() => "/srv/t3/userdata/web-stack"),
      );
      for (const root of roots) {
        for (const identifier of identifiers) assert.notInclude(root ?? "", identifier);
      }
    }),
  );
  // The 2 MiB stdout budget is a security control, not a tuning knob: it is what
  // stops a hostile or runaway native process from streaming unbounded bytes
  // into the server and onward into the model context.
  //
  // Both fixtures below are WELL-FORMED and contract-VALID search envelopes,
  // padded to an exact byte count with JSON whitespace so the only thing under
  // test is the byte budget. That matters: if the
  // `totalBytes > WEB_STACK_RESPONSE_MAX_BYTES` guard is deleted, the
  // over-budget document parses cleanly and its contents are returned to the
  // caller — the test then fails on the real security regression, not on an
  // incidental change of error code.
  //
  // The over-budget size is written as a literal instead of being derived from
  // the constant, so RAISING the constant fails this test rather than silently
  // moving the goalposts with it.
  it.effect("refuses native search stdout over the declared byte budget", () =>
    Effect.gen(function* () {
      const DECLARED_BUDGET_BYTES = 2 * 1024 * 1024;
      assert.equal(WebStackSearch.WEB_STACK_RESPONSE_MAX_BYTES, DECLARED_BUDGET_BYTES);
      const canary = "OVER_BUDGET_NATIVE_SEARCH_PAYLOAD";

      const paddedTo = (totalBytes: number, marker: string) => {
        const body = jsonText({
          ok: true,
          tool: "ctox_web_search",
          results: [{ title: marker, url: "https://example.test/", snippet: marker }],
        });
        const deficit = totalBytes - encoder.encode(body).length;
        assert.isAtLeast(deficit, 0, "fixture skeleton already exceeds the target size");
        const padded = `${body}${" ".repeat(deficit)}`;
        assert.equal(encoder.encode(padded).length, totalBytes);
        return padded;
      };

      const serviceWith = (stdout: string) =>
        makeService({
          handler: (_command, index) =>
            index === 0 ? { stdout: WebStackSearch.WEB_STACK_SURFACE_VERSION } : { stdout },
        });

      // Exactly at the budget is still served: the guard is `>`, not `>=`.
      const served = yield* (yield* search(
        serviceWith(paddedTo(DECLARED_BUDGET_BYTES, "at-budget")).service,
      )).search({ query: "budget" });
      assert.equal(served.results.length, 1);
      assert.equal(served.results[0]?.title, "at-budget");

      // One byte over is refused, and no part of the payload is forwarded.
      const error = yield* (yield* search(
        serviceWith(paddedTo(DECLARED_BUDGET_BYTES + 1, canary)).service,
      ))
        .search({ query: "budget" })
        .pipe(Effect.flip);
      assert.equal(error.reason, "oversized-response");
      assertCarriesNoSecret(error, canary);
      assert.equal(error.message, "Web Search returned an invalid response.");
    }),
  );
});
