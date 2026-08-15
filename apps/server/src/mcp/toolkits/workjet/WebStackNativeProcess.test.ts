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
