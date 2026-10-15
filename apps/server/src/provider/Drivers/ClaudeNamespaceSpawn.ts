// @effect-diagnostics nodeBuiltinImport:off -- The SDK requires a synchronous process handle while Source admission is asynchronous.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import type * as NodeChildProcess from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import {
  captureWorkerNamespaceRuntime,
  WorkerNamespaceRuntimeError,
} from "../../workjet/WorkerNamespaceRuntime.ts";
import { workerNamespaceSpawnInput } from "../../workjet/WorkerNamespaceSpawn.ts";
import type { WorkerNamespaceSessionCapture } from "../../workjet/WorkerSourceNamespace.ts";

type NamespaceSpawn = ReturnType<typeof workerNamespaceSpawnInput> & {
  readonly env: SpawnOptions["env"];
};

export const prepareClaudeNamespaceSpawn = Effect.fn("prepareClaudeNamespaceSpawn")(function* (
  spawn: SpawnOptions,
  capture: WorkerNamespaceSessionCapture,
) {
  const failure = (issue: string, cause?: unknown) =>
    new WorkerNamespaceRuntimeError({ issue, cause });
  if (!capture.captureRuntime)
    return yield* failure("Claude namespace requires the original persisted Source runtime.");
  const admit = () =>
    Effect.tryPromise({
      try: async () => {
        spawn.signal.throwIfAborted();
        await capture.revalidate(spawn.signal);
        spawn.signal.throwIfAborted();
      },
      catch: (cause) => failure("Claude namespace Source admission failed or expired.", cause),
    });
  yield* admit();
  const runtime = yield* captureWorkerNamespaceRuntime(spawn);
  yield* Effect.tryPromise({
    try: () =>
      capture.captureRuntime!({
        command: runtime.spawn.command,
        runtimeFiles: runtime.runtimeFiles,
      }),
    catch: (cause) =>
      failure("Claude runtime differs from its original persisted Source custody.", cause),
  });
  yield* admit();
  return yield* Effect.try({
    try: () => ({
      ...workerNamespaceSpawnInput(runtime.spawn, {
        ...capture,
        runtimeFiles: runtime.runtimeFiles,
      }),
      env: spawn.env,
    }),
    catch: (cause) => failure("Claude SDK process differs from its private namespace.", cause),
  });
});

/** Return the SDK's process interface immediately, but start no child until the
 * original Source and runtime journal have admitted this exact invocation. */
export function spawnAdmittedClaudeProcess(
  options: SpawnOptions,
  prepare: (options: SpawnOptions) => Promise<NamespaceSpawn>,
  start: (
    spawn: NamespaceSpawn & { readonly signal: AbortSignal },
  ) => NodeChildProcess.ChildProcessWithoutNullStreams,
): SpawnedProcess & { readonly stderr: NodeStream.Readable } {
  const stdin = new NodeStream.PassThrough();
  const stdout = new NodeStream.PassThrough();
  const stderr = new NodeStream.PassThrough();
  const events = new NodeEvents.EventEmitter();
  const controller = new AbortController();
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let finished = false;
  let killed = false;
  let exitCode: number | null = null;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true;
    exitCode = code;
    options.signal.removeEventListener("abort", abort);
    if (!child) {
      stdin.destroy();
      stdout.end();
      stderr.end();
    }
    events.emit("exit", code, signal);
  };
  const kill = (signal: NodeJS.Signals) => {
    if (finished) return false;
    killed = true;
    controller.abort();
    if (child) return child.kill(signal);
    finish(null, signal);
    return true;
  };
  const abort = () => kill("SIGTERM");
  options.signal.addEventListener("abort", abort, { once: true });
  const result: SpawnedProcess & { readonly stderr: NodeStream.Readable } = {
    stdin,
    stdout,
    stderr,
    get killed() {
      return killed || child?.killed === true;
    },
    get exitCode() {
      return exitCode;
    },
    kill,
    on: (event, listener) => {
      events.on(event, listener);
    },
    once: (event, listener) => {
      events.once(event, listener);
    },
    off: (event, listener) => {
      events.off(event, listener);
    },
  };
  if (options.signal.aborted) {
    queueMicrotask(abort);
    return result;
  }
  void Promise.resolve()
    .then(() => {
      if (finished || controller.signal.aborted) return undefined;
      return prepare({ ...options, signal: controller.signal });
    })
    .then(
      (spawn) => {
        if (!spawn || finished || controller.signal.aborted) return;
        try {
          child = start({ ...spawn, signal: controller.signal });
          child.on("exit", finish);
          child.on("close", (code, signal) => {
            finish(code ?? 1, signal);
            stdin.unpipe();
            stdin.destroy();
          });
          child.on("error", (cause) => events.emit("error", cause));
          child.stdin.on("error", (cause) => {
            if (!finished) events.emit("error", cause);
          });
          stdin.pipe(child.stdin);
          child.stdout.pipe(stdout);
          child.stderr.pipe(stderr);
        } catch (cause) {
          events.emit("error", cause instanceof Error ? cause : new Error(String(cause)));
          finish(1, null);
        }
      },
      (cause) => {
        if (finished) return;
        events.emit("error", cause instanceof Error ? cause : new Error(String(cause)));
        finish(1, null);
      },
    );
  return result;
}
