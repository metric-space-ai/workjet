import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as NativeProcess from "./WebStackNativeProcess.ts";
import * as WebStackBrowser from "./WebStackBrowser.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface CapturedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: { readonly shell?: boolean | string };
}

interface HandleResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

const makeSpawner = (handler: (command: CapturedCommand, index: number) => HandleResult) => {
  const commands: Array<CapturedCommand> = [];
  const stdin: Array<Array<string>> = [];
  const service = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const captured = command as unknown as CapturedCommand;
      const index = commands.length;
      commands.push(captured);
      const written: Array<string> = [];
      stdin.push(written);
      const result = handler(captured, index);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(index + 1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => written.push(decoder.decode(chunk, { stream: true }))),
        ),
        stdout: Stream.make(encoder.encode(result.stdout ?? "")),
        stderr: Stream.make(encoder.encode(result.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return {
    commands,
    stdin,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service),
  };
};

const nativePrepare = jsonText({
  ok: true,
  ready: false,
  dependencyInstalled: true,
  browserInstalled: false,
  installAttempted: false,
  dependencyInstallRan: false,
  browserInstallRan: false,
  reason: "browser-missing",
  referenceDir: "/must/not/cross",
});

const nativeAutomation = jsonText({
  ok: true,
  observations: [{ description: "Observed Example", url: "https://example.test/" }],
  logs: ["must not cross"],
});

const makeService = (input?: {
  readonly stateDir?: string;
  readonly handler?: (command: CapturedCommand, index: number) => HandleResult;
}) => {
  const directories: Array<string> = [];
  const spawner = makeSpawner(
    input?.handler ??
      ((_command, index) => ({
        stdout:
          index === 0
            ? WebStackBrowser.WEB_STACK_BROWSER_SURFACE_VERSION
            : index === 1
              ? nativePrepare
              : nativeAutomation,
      })),
  );
  const service = WebStackBrowser.__testing
    .make({
      stateDir: input?.stateDir ?? "/server/state",
      runtime: {
        executableCandidates: ["/opt/workjet-web-stack"],
        isExecutable: async () => true,
        makeDirectory: async (path) => {
          directories.push(path);
        },
      },
      probeTimeout: Duration.seconds(1),
      prepareTimeout: Duration.seconds(1),
    })
    .pipe(Effect.provide(spawner.layer));
  return { ...spawner, directories, service };
};

describe("WebStackBrowser", () => {
  it("strictly decodes the finite action AST and exactly one target form", () => {
    const valid = WebStackBrowser.decodeBrowserAutomationInput({
      actions: [
        { action: "navigate", url: "https://example.test/" },
        { action: "observe" },
        { action: "click", target: { testId: "submit" } },
        { action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.test" },
        { action: "press", target: { label: "Search" }, key: "Enter" },
      ],
      timeoutMs: 1_000,
    });
    assert.isDefined(valid);

    for (const invalid of [
      { source: "return process.env" },
      { actions: [{ action: "evaluate", source: "1+1" }] },
      { actions: [{ action: "observe", root: "/tmp" }] },
      { actions: [{ action: "navigate", url: "   " }] },
      { actions: [{ action: "click", target: { role: "button" } }] },
      { actions: [{ action: "click", target: { selector: "   " } }] },
      { actions: [{ action: "click", target: { selector: "#x", text: "x" } }] },
      { actions: [{ action: "press", target: { text: "x" }, key: "" }] },
      { actions: [{ action: "press", target: { text: "x" }, key: "   " }] },
      { actions: Array.from({ length: 33 }, () => ({ action: "observe" })) },
      { actions: [{ action: "observe" }], timeoutMs: 999 },
    ]) {
      assert.isUndefined(WebStackBrowser.decodeBrowserAutomationInput(invalid));
    }
  });

  it.effect("uses the browser probe, absolute shared root, strict envelopes, and no cwd", () => {
    const test = makeService({ stateDir: "/server-owned/state" });
    return Effect.gen(function* () {
      const browser = yield* test.service;
      const prepared = yield* browser.prepare({});
      const automated = yield* browser.automate({
        actions: [{ action: "observe" }],
        timeoutMs: 1_000,
      });

      assert.deepEqual(prepared, {
        ready: false,
        dependencyInstalled: true,
        browserInstalled: false,
        installAttempted: false,
        dependencyInstallRan: false,
        browserInstallRan: false,
        reason: "browser-missing",
      });
      assert.deepEqual(automated, {
        observations: [{ description: "Observed Example", url: "https://example.test/" }],
      });
      assert.deepEqual(test.directories, [
        "/server-owned/state/web-stack",
        "/server-owned/state/web-stack",
      ]);
      assert.deepEqual(
        test.commands.map(({ args }) => args),
        [
          ["--browser-surface-version"],
          ["browser-prepare", "--root", "/server-owned/state/web-stack"],
          ["browser-automate", "--root", "/server-owned/state/web-stack"],
        ],
      );
      assert.isTrue(test.commands.every(({ options }) => options.shell === false));
      assert.equal(test.stdin[1]?.join(""), '{"request":{},"config":{}}');
      assert.equal(
        test.stdin[2]?.join(""),
        '{"request":{"actions":[{"action":"observe"}],"timeoutMs":1000},"config":{}}',
      );
    });
  });

  it.effect("requires the exact browser surface and returns only stable redacted failures", () => {
    const secret = "SENSITIVE_STDERR_PATH_CONFIG";
    const mismatch = makeService({ handler: () => ({ stdout: `${secret}-wrong` }) });
    const exited = makeService({
      handler: (_command, index) =>
        index === 0
          ? { stdout: WebStackBrowser.WEB_STACK_BROWSER_SURFACE_VERSION }
          : { code: 7, stdout: secret, stderr: `/private/${secret}` },
    });
    return Effect.gen(function* () {
      const mismatchError = yield* (yield* mismatch.service).prepare({}).pipe(Effect.flip);
      assert.equal(mismatchError.reason, "version-mismatch");
      assert.notInclude(jsonText(mismatchError), secret);

      const exitError = yield* (yield* exited.service).prepare({}).pipe(Effect.flip);
      assert.equal(exitError.reason, "process-exit");
      assert.notInclude(jsonText(exitError), secret);
    });
  });

  it.effect("bounds observations and rejects malformed native output", () => {
    const entries = Array.from({ length: 205 }, (_, index) => ({
      description:
        index === 0
          ? "😀".repeat(WebStackBrowser.WEB_STACK_BROWSER_DESCRIPTION_MAX_CHARS + 1)
          : `Observed ${index}`,
      url: `https://example.test/${index}`,
      path: "/private/profile",
    }));
    const normalized = makeService({
      handler: (_command, index) => ({
        stdout:
          index === 0
            ? WebStackBrowser.WEB_STACK_BROWSER_SURFACE_VERSION
            : jsonText({ ok: true, observations: entries, logs: ["secret"] }),
      }),
    });
    const malformed = makeService({
      handler: (_command, index) => ({
        stdout:
          index === 0
            ? WebStackBrowser.WEB_STACK_BROWSER_SURFACE_VERSION
            : jsonText({ ok: true, observations: [{ description: 7 }] }),
      }),
    });
    return Effect.gen(function* () {
      const result = yield* (yield* normalized.service).automate({
        actions: [{ action: "observe" }],
      });
      assert.equal(result.observations.length, WebStackBrowser.WEB_STACK_BROWSER_OBSERVATION_LIMIT);
      assert.equal(
        Array.from(result.observations[0]?.description ?? "").length,
        WebStackBrowser.WEB_STACK_BROWSER_DESCRIPTION_MAX_CHARS,
      );
      assert.notInclude(jsonText(result), "/private/profile");
      assert.notInclude(jsonText(result), "secret");

      const error = yield* (yield* malformed.service)
        .automate({ actions: [{ action: "observe" }] })
        .pipe(Effect.flip);
      assert.equal(error.reason, "malformed-response");
    });
  });
  // The 2 MiB stdout budget is a security control, not a tuning knob: it is what
  // stops a hostile or runaway native process from streaming unbounded bytes
  // into the server and onward into the model context.
  //
  // Both fixtures below are WELL-FORMED and contract-VALID browser envelopes,
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
  it.effect("refuses native browser stdout over the declared byte budget", () => {
    const DECLARED_BUDGET_BYTES = 2 * 1024 * 1024;
    const canary = "OVER_BUDGET_NATIVE_BROWSER_PAYLOAD";

    const paddedTo = (totalBytes: number, marker: string) => {
      const body = jsonText({
        ok: true,
        observations: [{ description: marker, url: "https://example.test/" }],
      });
      const deficit = totalBytes - encoder.encode(body).length;
      assert.isAtLeast(deficit, 0, "fixture skeleton already exceeds the target size");
      const padded = `${body}${" ".repeat(deficit)}`;
      assert.equal(encoder.encode(padded).length, totalBytes);
      return padded;
    };

    const serviceWith = (stdout: string) =>
      makeService({
        handler: (_command, index) => ({
          stdout: index === 0 ? WebStackBrowser.WEB_STACK_BROWSER_SURFACE_VERSION : stdout,
        }),
      }).service;

    return Effect.gen(function* () {
      assert.equal(
        NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES,
        DECLARED_BUDGET_BYTES,
        "the browser toolkit shares the native response budget",
      );

      // Exactly at the budget is still served: the guard is `>`, not `>=`.
      const served = yield* (yield* serviceWith(
        paddedTo(DECLARED_BUDGET_BYTES, "at-budget"),
      )).automate({ actions: [{ action: "observe" }] });
      assert.deepEqual(served.observations, [
        { description: "at-budget", url: "https://example.test/" },
      ]);

      // One byte over is refused, and no part of the payload is forwarded.
      const automateError = yield* (yield* serviceWith(paddedTo(DECLARED_BUDGET_BYTES + 1, canary)))
        .automate({ actions: [{ action: "observe" }] })
        .pipe(Effect.flip);
      assert.equal(automateError.reason, "oversized-response");
      assert.notInclude(jsonText(automateError), canary);
      assert.equal(automateError.message, "Web Browser returned an invalid response.");

      // `prepare` shares parseJsonResponse, so hold it to the same budget.
      const prepareError = yield* (yield* serviceWith(paddedTo(DECLARED_BUDGET_BYTES + 1, canary)))
        .prepare({})
        .pipe(Effect.flip);
      assert.equal(prepareError.reason, "oversized-response");
      assert.notInclude(jsonText(prepareError), canary);
    });
  });
});
