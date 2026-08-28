import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as NativeProcess from "./WebStackNativeProcess.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface CapturedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: { readonly shell?: boolean | string };
}

const makeSpawner = (handler: (command: CapturedCommand, index: number) => string) => {
  const commands: Array<CapturedCommand> = [];
  const stdin: Array<Array<string>> = [];
  const service = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const captured = command as unknown as CapturedCommand;
      const index = commands.length;
      commands.push(captured);
      const written: Array<string> = [];
      stdin.push(written);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(index + 1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => written.push(decoder.decode(chunk, { stream: true }))),
        ),
        stdout: Stream.make(encoder.encode(handler(captured, index))),
        stderr: Stream.empty,
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

/**
 * Spawns a child whose stdout is `chunkCount` chunks of `chunkBytes` each, so
 * the bounded fold sees a stream it must stop accumulating part-way through
 * rather than one already-materialized string.
 */
const makeStreamingSpawner = (chunkBytes: number, chunkCount: number) => {
  const chunk = new Uint8Array(chunkBytes).fill(0x61);
  const service = ChildProcessSpawner.make(() =>
    Effect.sync(() =>
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.fromIterable(Array.from({ length: chunkCount }, () => chunk)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  return { layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service) };
};

describe("WebStackNativeProcess stdout byte budget", () => {
  // The budget is a security control, not a tuning knob: it is what keeps a
  // hostile or runaway native process from streaming unbounded bytes into the
  // server and onward into the model context. Pinning the literal makes raising
  // it a deliberate, reviewed act rather than a one-character edit.
  it("declares a 2 MiB response budget", () => {
    assert.equal(NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES, 2 * 1024 * 1024);
    assert.equal(NativeProcess.WEB_STACK_STDERR_MAX_BYTES, 64 * 1024);
    assert.equal(NativeProcess.WEB_STACK_PROBE_MAX_BYTES, 256);
  });

  it.effect(
    "stops buffering native stdout at the budget while still reporting its true size",
    () => {
      // 64 chunks of 1 MiB = 64 MiB offered against a 2 MiB budget.
      const chunkBytes = 1024 * 1024;
      const chunkCount = 64;
      const spawner = makeStreamingSpawner(chunkBytes, chunkCount);
      return Effect.gen(function* () {
        const service = yield* ChildProcessSpawner.ChildProcessSpawner;
        const output = yield* NativeProcess.runCommand({
          spawner: service,
          executable: "/opt/workjet-web-stack",
          args: ["search"],
          maximumStdoutBytes: NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES,
          timeout: Duration.seconds(5),
          failure: (reason) => ({ reason }),
        });

        // Retained bytes are capped at budget + 1 — the single extra byte is what
        // lets the caller notice the overflow at all. 64 MiB never lands in heap.
        assert.equal(
          output.stdout.bytes.length,
          NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES + 1,
          "the bounded collector must not accumulate past the budget",
        );
        // The reported size stays truthful, which is what the per-surface
        // `oversized-response` checks compare against.
        assert.equal(output.stdout.totalBytes, chunkBytes * chunkCount);
        assert.isAbove(output.stdout.totalBytes, NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES);
        // outputText only ever decodes the retained window.
        assert.equal(
          NativeProcess.outputText(output.stdout).length,
          NativeProcess.WEB_STACK_RESPONSE_MAX_BYTES + 1,
        );
      }).pipe(Effect.provide(spawner.layer));
    },
  );
});

describe("WebStackNativeProcess", () => {
  it("orders cross-platform executable candidates without invoking a shell", () => {
    const candidates = NativeProcess.executableCandidates({
      environment: {
        WORKJET_WEB_STACK_EXECUTABLE: " C:\\managed\\workjet-web-stack.exe ",
        PATH: "C:\\first;C:\\second",
      },
      platform: "win32",
      cwd: "C:\\checkout",
      moduleDirectory: "C:\\checkout\\apps\\server",
    });
    assert.equal(candidates[0], "C:\\managed\\workjet-web-stack.exe");
    assert.isTrue(candidates.some((candidate) => candidate.endsWith("workjet-web-stack.exe")));
  });

  it.effect("uses an exact lazy probe, retries failures, and caches only success", () => {
    let available = false;
    const spawner = makeSpawner((_command, index) =>
      index === 0 ? "browser-v1\n" : JSON.stringify({ ok: true }),
    );
    return Effect.gen(function* () {
      const service = yield* ChildProcessSpawner.ChildProcessSpawner;
      const run = NativeProcess.makeProbedRunner({
        spawner: service,
        runtime: {
          executableCandidates: ["/late/workjet-web-stack"],
          isExecutable: async () => available,
          makeDirectory: async () => {},
        },
        probeArgs: ["--browser-surface-version"],
        expectedSurfaceVersion: "browser-v1\n",
        probeTimeout: Duration.seconds(1),
        failure: (reason) => ({ reason }),
      });

      const missing = yield* run({
        args: ["browser-prepare"],
        maximumStdoutBytes: 100,
        timeout: Duration.seconds(1),
      }).pipe(Effect.flip);
      assert.equal(missing.reason, "binary-unavailable");
      assert.equal(spawner.commands.length, 0);

      available = true;
      yield* run({
        args: ["browser-prepare"],
        stdin: "{}",
        maximumStdoutBytes: 100,
        timeout: Duration.seconds(1),
      });
      yield* run({
        args: ["browser-automate"],
        stdin: "{}",
        maximumStdoutBytes: 100,
        timeout: Duration.seconds(1),
      });

      assert.deepEqual(
        spawner.commands.map(({ args }) => args),
        [["--browser-surface-version"], ["browser-prepare"], ["browser-automate"]],
      );
      assert.isTrue(spawner.commands.every(({ options }) => options.shell === false));
      assert.equal(spawner.stdin[1]?.join(""), "{}");
    }).pipe(Effect.provide(spawner.layer));
  });
});
