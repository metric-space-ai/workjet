import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runLocalCommand } from "./LocalProvisioningCommand.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof NodeChildProcess>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

describe("local provisioning command deadlines", () => {
  let child: NodeChildProcess.ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let childClosed = false;
  let descendantPid: number | undefined;

  function processExists(pid: number) {
    try {
      NodeProcess.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  function start(script: string) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const spawn = vi.mocked(NodeChildProcess.spawn);
    spawn.mockClear();
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
      if (descendantPid !== undefined && processExists(descendantPid)) {
        NodeProcess.kill(descendantPid, "SIGKILL");
      }
    } finally {
      child = undefined;
      closed = undefined;
      childClosed = false;
      descendantPid = undefined;
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
    "stops a resistant descendant with closed pipes when its parent exits zero",
    async () => {
      const descendant =
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send(process.pid); process.disconnect();";
      const { result, ready } = start(
        `process.on('SIGTERM', () => process.exit(0)); const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); child.once('message', pid => process.stdout.write(String(pid))); setInterval(() => {}, 1000);`,
      );
      const [pidChunk] = await ready;
      descendantPid = Number(String(pidChunk));
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
      expect(processExists(descendantPid)).toBe(true);
      vi.advanceTimersByTime(30_000);
      const outcome = await result;
      expect(outcome.error).toEqual(
        new Error("Local provisioning command timed out after 30000 ms."),
      );
      expect(child?.exitCode).toBe(0);
      // Observe this fixture's captured child identity only; no process scan.
      for (let attempt = 0; attempt < 100 && processExists(descendantPid); attempt++) {
        await NodeTimersPromises.setTimeout(10);
      }
      expect(processExists(descendantPid)).toBe(false);
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
