import { type GreppySettings } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { captureWorkerNamespaceRuntime, WorkerNamespaceRuntimeError } from "../../workjet/WorkerNamespaceRuntime.ts";
import type { WorkerNamespaceSessionCapture } from "../../workjet/WorkerSourceNamespace.ts";

export function buildGreppyAcpSpawnInput(
  config: GreppySettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  model: string,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: config.binaryPath || "greppy",
    args: [
      "agent",
      "stdio",
      "--model",
      model,
      "--endpoint",
      environment.GREPPY_ENDPOINT || config.endpoint,
      "--max-turns",
      String(Math.max(1, Math.min(1000, config.maxTurns))),
    ],
    cwd,
    env: environment,
  };
}

export const makeGreppyAcpRuntime = Effect.fn("makeGreppyAcpRuntime")(function* (
  input: Omit<
    AcpSessionRuntime.AcpSessionRuntimeOptions,
    "spawn" | "authMethodId" | "namespaceCapture" | "namespaceAdmission"
  > & {
    readonly namespaceCapture?: WorkerNamespaceSessionCapture;
    readonly config: GreppySettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly model: string;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
) {
  const configured = buildGreppyAcpSpawnInput(
    input.config,
    input.cwd,
    input.environment,
    input.model,
  );
  const runtime =
    input.namespaceCapture === undefined
      ? undefined
      : yield* captureWorkerNamespaceRuntime(configured);
  const persistRuntime = input.namespaceCapture?.captureRuntime;
  if (runtime && persistRuntime)
    yield* Effect.tryPromise({
      try: () => persistRuntime({
        command: runtime.spawn.command,
        runtimeFiles: runtime.runtimeFiles,
      }),
      catch: (cause) => new WorkerNamespaceRuntimeError({
        issue: "Worker runtime differs from its original persisted Source custody.",
        cause,
      }),
    });
  const { namespaceCapture, ...options } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...options,
      spawn: runtime?.spawn ?? configured,
      ...(namespaceCapture && runtime
        ? {
            namespaceCapture: {
              helperPath: namespaceCapture.helperPath,
              worktree: namespaceCapture.worktree,
              profile: namespaceCapture.profile,
              modelSocket: namespaceCapture.modelSocket,
              runtimeFiles: runtime.runtimeFiles,
            },
            namespaceAdmission: namespaceCapture.revalidate,
          }
        : {}),
      authMethodId: "greppy.env",
      cancelPromptMode: "await-response",
      mcpServers: [],
    }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.spawner))),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
