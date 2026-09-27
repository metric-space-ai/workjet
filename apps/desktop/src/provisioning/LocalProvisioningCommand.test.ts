import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeProcess from "node:process";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runLocalCommand } from "./LocalProvisioningCommand.ts";

describe("local provisioning command deadlines", () => {
  let child: NodeChildProcess.ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let childClosed = false;

  function start(script: string) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const spawn = vi.spyOn(NodeChildProcess, "spawn");
    const result = runLocalCommand(NodeProcess.execPath, ["-e", script]).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    const spawned = spawn.mock.results[0]?.value;
    if (spawned === undefined || spawned.stdout === null) throw new Error("Missing owned child");
    child = spawned;
    closed = new Promise<void>((resolve) =>
      spawned.once("close", () => {
        childClosed = true;
        resolve();
      }),
    );
    const output = spawned.stdout;
    return { result, output, ready: NodeEvents.once(output, "data") };
  }

  afterEach(async () => {
    try {
      if (child?.pid !== undefined && !childClosed) {
        if (NodeProcess.platform === "win32") child.kill("SIGKILL");
        else NodeProcess.kill(-child.pid, "SIGKILL");
      }
      await closed;
    } finally {
      child = undefined;
      closed = undefined;
      childClosed = false;
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("preserves successful stdout and stderr and removes its deadline", async () => {
    const { result } = start("process.stdout.write('done'); process.stderr.write('note');");
    expect(await result).toEqual({ value: { stdout: "done", stderr: "note" }, error: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.skipIf(NodeProcess.platform === "win32")(
    "rejects a timed-out command even when its SIGTERM handler exits zero",
    async () => {
      const { result, ready } = start(
        "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000);",
      );
      await ready;
      vi.advanceTimersByTime(30_000);
      const outcome = await result;
      expect(outcome.value).toBeUndefined();
      expect(outcome.error).toEqual(
        new Error("Local provisioning command timed out after 30000 ms."),
      );
      expect(child?.exitCode).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.skipIf(NodeProcess.platform === "win32")(
    "force-stops a SIGTERM-resistant child and its owned group before rejecting",
    async () => {
      const descendant =
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);";
      const { result, ready, output } = start(
        `process.on('SIGTERM', () => process.stdout.write('term')); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2] }); setInterval(() => {}, 1000);`,
      );
      await ready;
      const term = NodeEvents.once(output, "data");
      vi.advanceTimersByTime(30_000);
      await term;
      expect(child?.exitCode).toBeNull();
      expect(child?.signalCode).toBeNull();
      vi.advanceTimersByTime(1_000);
      const outcome = await result;
      expect(outcome.error).toEqual(
        new Error("Local provisioning command timed out after 30000 ms."),
      );
      expect(child?.signalCode).toBe("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
