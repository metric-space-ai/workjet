// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { DecisionHubConnectionRegistry } from "./decisionHub/DecisionHubConnectionRegistry.ts";
import { makeCtoxMcpTransport } from "./ctox/CtoxMcpTransport.ts";
import { makeCtoxRemoteWorkerTargets } from "./ctox/CtoxRemoteWorkerTargets.ts";
import { RemoteWorkerComputerEnrollment, makeRemoteWorkerComputerEnrollment } from "./RemoteWorkerComputerEnrollment.ts";

export const layer = Layer.effect(RemoteWorkerComputerEnrollment, Effect.gen(function* () {
  const connections = yield* DecisionHubConnectionRegistry;
  return yield* makeRemoteWorkerComputerEnrollment({
    environmentId: yield* (yield* ServerEnvironment).getEnvironmentId,
    connections, settings: yield* ServerSettingsService, secrets: yield* ServerSecretStore,
    targets: makeCtoxRemoteWorkerTargets({ connections, transport: makeCtoxMcpTransport(yield* HttpClient.HttpClient) }),
  });
})).pipe(Layer.provide(FetchHttpClient.layer));
