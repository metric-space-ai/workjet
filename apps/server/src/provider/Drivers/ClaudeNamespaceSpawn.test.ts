// @effect-diagnostics nodeBuiltinImport:off -- Exercise the synchronous SDK handle against owned subprocesses.
import * as NodeChildProcess from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import { spawnAdmittedClaudeProcess } from "./ClaudeNamespaceSpawn.ts";

const options = (signal = new AbortController().signal): SpawnOptions => ({
  command: process.execPath,
  args: ["-e", "process.stdin.pipe(process.stdout); process.stderr.write('diagnostic');"],
  env: {},
  signal,
});
const plan = (input: SpawnOptions) => ({
  command: input.command,
  args: input.args,
  cwd: input.cwd ?? process.cwd(),
  env: input.env,
});
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const read = async (stream: AsyncIterable<Buffer | string>) => {
  let text = "";
  for await (const value of stream) text += value.toString();
  return text;
};
const exited = (child: SpawnedProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
const failures = (child: SpawnedProcess) => {
  const errors: Error[] = [];
  child.on("error", (error) => errors.push(error));
  return errors;
};
const start = (spawn: ReturnType<typeof plan> & { readonly signal: AbortSignal }) =>
  NodeChildProcess.spawn(spawn.command, spawn.args, {
    env: spawn.env,
    cwd: spawn.cwd,
    signal: spawn.signal,
    stdio: ["pipe", "pipe", "pipe"],
  });

describe("Claude SDK admitted process handle", () => {
  it("buffers SDK stdin until admission, preserving stdout, stderr and EOF", async () => {
    const input = options();
    const admission = deferred<ReturnType<typeof plan>>();
    let starts = 0;
    const child = spawnAdmittedClaudeProcess(
      input,
      () => admission.promise,
      (spawn) => {
        starts++;
        return start(spawn);
      },
    );
    const errors = failures(child);
    const exit = exited(child);
    const output = read(child.stdout);
    const diagnostics = read(child.stderr);
    child.stdin.end("first\nsecond\n");
    expect(starts).toBe(0);
    admission.resolve(plan(input));
    expect(await exit).toEqual({ code: 0, signal: null });
    expect(await output).toBe("first\nsecond\n");
    expect(await diagnostics).toBe("diagnostic");
    expect(errors).toEqual([]);
    expect(starts).toBe(1);
    expect(child.exitCode).toBe(0);
    expect(child.kill("SIGTERM")).toBe(false);
  });

  it("reports denied admission without starting a child", async () => {
    let starts = 0;
    const child = spawnAdmittedClaudeProcess(
      options(),
      async () => {
        throw new Error("Source revoked");
      },
      (spawn) => {
        starts++;
        return start(spawn);
      },
    );
    const errors = failures(child);
    const exit = exited(child);
    expect(await exit).toEqual({ code: 1, signal: null });
    expect(errors.map((error) => error.message)).toEqual(["Source revoked"]);
    expect(starts).toBe(0);
  });

  it("turns synchronous preparation errors into SDK error and exit events", async () => {
    const child = spawnAdmittedClaudeProcess(
      options(),
      () => {
        throw new Error("Runtime replaced");
      },
      start,
    );
    const errors = failures(child);
    expect(await exited(child)).toEqual({ code: 1, signal: null });
    expect(errors.map((error) => error.message)).toEqual(["Runtime replaced"]);
  });

  it("does not admit an already aborted SDK signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let prepares = 0;
    const child = spawnAdmittedClaudeProcess(
      options(controller.signal),
      async (input) => {
        prepares++;
        return plan(input);
      },
      start,
    );
    failures(child);
    expect(await exited(child)).toEqual({ code: null, signal: "SIGTERM" });
    expect(prepares).toBe(0);
    expect(child.killed).toBe(true);
  });

  it("aborts pending admission and cannot start after a late grant", async () => {
    const controller = new AbortController();
    const entered = deferred<AbortSignal>();
    const admission = deferred<ReturnType<typeof plan>>();
    let starts = 0;
    const input = options(controller.signal);
    const child = spawnAdmittedClaudeProcess(
      input,
      (spawn) => {
        entered.resolve(spawn.signal);
        return admission.promise;
      },
      (spawn) => {
        starts++;
        return start(spawn);
      },
    );
    failures(child);
    const exit = exited(child);
    const pendingSignal = await entered.promise;
    controller.abort();
    expect(await exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(pendingSignal.aborted).toBe(true);
    admission.resolve(plan(input));
    await admission.promise;
    expect(starts).toBe(0);
  });

  it("honors SDK kill while preparation is pending", async () => {
    const entered = deferred<void>();
    const admission = deferred<ReturnType<typeof plan>>();
    const child = spawnAdmittedClaudeProcess(
      options(),
      () => {
        entered.resolve();
        return admission.promise;
      },
      start,
    );
    failures(child);
    const exit = exited(child);
    await entered.promise;
    expect(child.kill("SIGINT")).toBe(true);
    expect(await exit).toEqual({ code: null, signal: "SIGINT" });
    admission.reject(new Error("Cancelled Source"));
    await admission.promise.catch(() => undefined);
    expect(child.killed).toBe(true);
  });

  it("forwards cancellation to the actual running child", async () => {
    const controller = new AbortController();
    const input = {
      ...options(controller.signal),
      args: ["-e", "process.stdout.write('ready'); process.stdin.resume();"],
    };
    const child = spawnAdmittedClaudeProcess(input, async (spawn) => plan(spawn), start);
    const errors = failures(child);
    const exit = exited(child);
    const ready = await new Promise<Buffer>((resolve) => child.stdout.once("data", resolve));
    expect(ready.toString()).toBe("ready");
    controller.abort();
    expect((await exit).signal).toBe("SIGTERM");
    expect(child.killed).toBe(true);
    expect(errors.every((error) => error.name === "AbortError")).toBe(true);
  });

  it("preserves a child failure exit code", async () => {
    const input = { ...options(), args: ["-e", "process.exit(7)"] };
    const child = spawnAdmittedClaudeProcess(input, async (spawn) => plan(spawn), start);
    failures(child);
    expect(await exited(child)).toEqual({ code: 7, signal: null });
    expect(child.exitCode).toBe(7);
  });

  it("finishes a failed OS spawn without waiting for a nonexistent child's exit", async () => {
    const input = { ...options(), command: "/workjet-missing-claude-runtime" };
    const child = spawnAdmittedClaudeProcess(input, async (spawn) => plan(spawn), start);
    const errors = failures(child);
    expect(await exited(child)).toEqual({ code: expect.any(Number), signal: null });
    expect(child.exitCode).not.toBe(0);
    expect(child.exitCode).not.toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("ENOENT");
  });
});
