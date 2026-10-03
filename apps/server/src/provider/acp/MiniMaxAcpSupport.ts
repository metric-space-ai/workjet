import type { MiniMaxSettings } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export function miniMaxEnvironment(config: MiniMaxSettings, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, ...(config.dataDirectory ? { MINIMAX_DATA_DIR: config.dataDirectory } : {}) };
}

export function buildMiniMaxAcpSpawnInput(config: MiniMaxSettings, cwd: string, environment: NodeJS.ProcessEnv): AcpSessionRuntime.AcpSpawnInput {
  return { command: config.binaryPath || "mcode", args: ["acp"], cwd, env: miniMaxEnvironment(config, environment) };
}

export const makeMiniMaxAcpRuntime = Effect.fn("makeMiniMaxAcpRuntime")(function* (
  input: Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn" | "authMethodId"> & {
    readonly config: MiniMaxSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
) {
  const context = yield* Layer.build(AcpSessionRuntime.layer({
    ...input,
    spawn: buildMiniMaxAcpSpawnInput(input.config, input.cwd, input.environment),
    // Shipped 0.6.2 validates an existing login/BYOK account with this method.
    // It does not initiate login or alter the configured provider.
    authMethodId: "minimax-code-login",
    cancelPromptMode: "await-response",
    clientCapabilities: { elicitation: { form: {} }, ...input.clientCapabilities },
  }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.spawner))));
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
