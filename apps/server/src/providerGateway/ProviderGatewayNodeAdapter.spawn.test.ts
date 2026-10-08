import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

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
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
      cwd: new URL("../../", import.meta.url),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { error += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      expect(error).toBe("");
      expect(result).toEqual({ code: 0, signal: null });
      expect(output).toBe("MISSING_PROVIDER_HOST_ALIVE");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 25_000);
});
