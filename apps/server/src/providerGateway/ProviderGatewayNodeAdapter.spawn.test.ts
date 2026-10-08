import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";

// Missing-provider cleanup must never signal the runner's own process group.
// Exercise the installed dependency in a separate session, not the test runner.
describe("missing provider process cleanup", () => {
  it("keeps the host alive and avoids pid-zero cleanup after ENOENT", async () => {
    const program = `
      import assert from 'node:assert/strict';
      import { nodeProviderGatewayPlatform } from './src/providerGateway/ProviderGatewayNodeAdapter.ts';
      import * as Effect from 'effect/Effect';
      import * as Exit from 'effect/Exit';
      import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
      import * as NodeServices from '@effect/platform-node/NodeServices';
      const signals = [];
      const originalKill = process.kill;
      process.kill = function(pid, signal) {
        signals.push({pid, signal});
        assert.ok(Number.isSafeInteger(pid) && pid !== 0, 'cleanup attempted invalid pid');
        return originalKill.call(process, pid, signal);
      };
      assert.throws(() => nodeProviderGatewayPlatform.spawn('/workjet-missing-provider-no-such-binary', []), /spawn failed/);
      for (const detached of [false, true]) {
        const result = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          return yield* spawner.spawn(ChildProcess.make('/workjet-missing-provider-no-such-binary', [], {detached}));
        })).pipe(Effect.provide(NodeServices.layer)));
        assert.ok(Exit.isFailure(result), 'missing executable must remain a spawn failure');
      }
      assert.deepEqual(signals, [], 'a never-spawned child has no process to signal');
      process.stdout.write('MISSING_PROVIDER_HOST_ALIVE');
    `;
    const [output, error, code] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const paths = yield* Path.Path;
          const cwd = yield* paths.fromFileUrl(new URL("../../", import.meta.url));
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(process.execPath, ["--input-type=module", "-e", program], {
              cwd,
              detached: process.platform !== "win32",
              stdin: "ignore",
            }),
          );
          yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore));
          return yield* Effect.all([
            Stream.runCollect(Stream.decodeText(child.stdout)).pipe(Effect.map((chunks) => chunks.join(""))),
            Stream.runCollect(Stream.decodeText(child.stderr)).pipe(Effect.map((chunks) => chunks.join(""))),
            child.exitCode,
          ], { concurrency: 3 });
        }).pipe(Effect.timeout("20 seconds")),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(output).toBe("MISSING_PROVIDER_HOST_ALIVE");
  }, 25_000);
});
