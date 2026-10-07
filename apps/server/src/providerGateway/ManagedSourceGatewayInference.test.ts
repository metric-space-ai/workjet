import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetGatewayAccountId,
  WorkjetLlmRouteId,
  type ServerSettings,
  type WorkjetGatewayInferenceError,
  type WorkjetGatewayScopedCatalog,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { makeManagedSourceGatewayInference } from "./ManagedSourceGatewayInference.ts";

const environmentId = EnvironmentId.make("source");
const sourceInstanceId = ProviderInstanceId.make("ctox-native");
const target = {
  connectionId: WorkjetConnectionId.make("target-connection"),
  instanceId: "target-native-instance",
  computerId: WorkjetComputerId.make("target-native-computer"),
};
const workerProfile = { modelId: "worker-model", llmRouteId: WorkjetLlmRouteId.make("worker-route") };
const references = {
  credentialRef: { environmentId, accountId: WorkjetGatewayAccountId.make("worker-account") },
  providerRef: { environmentId, provider: "codex" as const },
  modelRef: { environmentId, provider: "codex" as const, modelId: workerProfile.modelId },
};
const bindInput = {
  target,
  modelSelection: { instanceId: sourceInstanceId, model: workerProfile.modelId },
  routeId: workerProfile.llmRouteId,
};
const fixture = () => {
  let settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    // A native Supervisor and a different explicit worker model/profile.
    textGenerationModelSelection: { instanceId: sourceInstanceId, model: "supervisor-native-model" },
    providerInstances: {
      [sourceInstanceId]: {
        driver: ProviderDriverKind.make("ctox-native"),
        displayName: "Native source",
        accentColor: "#123456",
        enabled: true,
        routeViaGateway: false,
        config: {},
      },
    },
    workjet: {
      ...DEFAULT_SERVER_SETTINGS.workjet,
      llmRoutes: [
        { id: workerProfile.llmRouteId, label: "Worker route", gatewayAccountId: references.credentialRef.accountId },
        { id: WorkjetLlmRouteId.make("other-route"), label: "Other route", gatewayAccountId: WorkjetGatewayAccountId.make("other-account") },
      ],
    },
  };
  let catalog: WorkjetGatewayScopedCatalog = {
    schemaVersion: 1,
    target,
    accounts: [{ credentialRef: references.credentialRef, providerRef: references.providerRef,
      label: "Worker account", modelRefs: [references.modelRef] }],
  };
  const consumer = makeManagedSourceGatewayInference({
    environmentId: Effect.succeed(environmentId),
    settings: { getSettings: Effect.sync(() => settings) },
    gateway: {
      scopedCatalog: (requestedTarget, source) => Effect.sync(() => {
        expect(requestedTarget).toEqual(target);
        expect(source).toBe(environmentId);
        return catalog;
      }),
      status: () => Effect.die("Binding must not start or inspect a source Code harness"),
    },
    connections: undefined,
  });
  return {
    consumer,
    disable: () => { settings = { ...settings, providerInstances: {
      [sourceInstanceId]: { ...settings.providerInstances[sourceInstanceId]!, enabled: false },
    } }; },
    remove: () => { settings = { ...settings, providerInstances: {} }; },
    revokeGrant: () => { catalog = { ...catalog, accounts: [] }; },
  };
};
const reason = async (effect: Effect.Effect<unknown, WorkjetGatewayInferenceError>) =>
  (await Effect.runPromise(Effect.flip(effect))).reason;

describe("managed source gateway binding", () => {
  it("binds an enabled native source to the explicit worker route/model without source CLI routing", async () => {
    const f = fixture();
    expect(await Effect.runPromise(f.consumer.bindModel(bindInput))).toEqual({ target, ...references });
  });
  it.each(["disable", "remove"] as const)("refuses a currently %s source instance", async (action) => {
    const f = fixture();
    await Effect.runPromise(f.consumer.bindModel(bindInput));
    f[action]();
    expect(await reason(f.consumer.bindModel(bindInput))).toBe("binding-mismatch");
  });
  it.each([
    { input: { ...bindInput, modelSelection: { instanceId: sourceInstanceId, model: "supervisor-native-model" } }, reason: "grant-unavailable" },
    { input: { ...bindInput, routeId: WorkjetLlmRouteId.make("other-route") }, reason: "grant-unavailable" },
    { input: { ...bindInput, routeId: WorkjetLlmRouteId.make("missing-route") }, reason: "binding-mismatch" },
  ])("refuses a mismatched explicit worker model or route", async (test) => {
    expect(await reason(fixture().consumer.bindModel(test.input))).toBe(test.reason);
  });
  it("requires the current exact target grant even when the profile route remains configured", async () => {
    const f = fixture();
    f.revokeGrant();
    expect(await reason(f.consumer.bindModel(bindInput))).toBe("grant-unavailable");
  });
});
