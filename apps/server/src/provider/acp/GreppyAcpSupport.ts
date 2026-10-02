import { type GreppySettings } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

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
  input: Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn" | "authMethodId"> & {
    readonly config: GreppySettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly model: string;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
) {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: buildGreppyAcpSpawnInput(input.config, input.cwd, input.environment, input.model),
      authMethodId: "greppy.env",
      mcpServers: [],
    }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.spawner))),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
