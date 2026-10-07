import { expect, it } from "vite-plus/test";
import { EnvironmentId, WorkjetGatewayModelBinding, type RemoteWorkerRequest } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { targetWorkerBindingMatches } from "./RemoteWorkerTargetHarnessSetupLive.ts";

const binding = Schema.decodeUnknownSync(WorkjetGatewayModelBinding)({
  target: { connectionId: "target-connection", instanceId: "target-native", computerId: "target-computer" },
  credentialRef: { environmentId: "source", accountId: "source-account" },
  providerRef: { environmentId: "source", provider: "codex" },
  modelRef: { environmentId: "source", provider: "codex", modelId: "gpt-6.1-sol" },
});
const request = {
  computerId: binding.target.computerId,
  parent: { environmentId: binding.providerRef.environmentId },
  modelSelection: { model: binding.modelRef.modelId },
} as Pick<RemoteWorkerRequest, "computerId" | "parent" | "modelSelection">;
it("accepts only source-owned binding for the exact target computer and selected model", () => {
  expect(targetWorkerBindingMatches(binding, request)).toBe(true);
  expect(targetWorkerBindingMatches({ ...binding, credentialRef: { ...binding.credentialRef, environmentId: EnvironmentId.make("foreign") } }, request)).toBe(false);
  expect(targetWorkerBindingMatches({ ...binding, modelRef: { ...binding.modelRef, modelId: "another-model" } }, request)).toBe(false);
  expect(targetWorkerBindingMatches({ ...binding, target: { ...binding.target, computerId: "another-computer" as typeof binding.target.computerId } }, request)).toBe(false);
  expect(targetWorkerBindingMatches({ ...binding, providerRef: { ...binding.providerRef, environmentId: EnvironmentId.make("foreign") } }, request)).toBe(false);
});
