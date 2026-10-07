import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  ThreadId,
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetGatewayAccountId,
  WorkjetLlmRouteId,
  ProviderInstanceId,
  WorkjetGatewayInferenceError,
  type WorkjetGatewayInferenceInput,
  type WorkjetGatewayScopedCatalog,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { makeSourceGatewayInference } from "./SourceGatewayInference.ts";

const environmentId = EnvironmentId.make("source");
const target = { connectionId: WorkjetConnectionId.make("target-connection"), instanceId: "target-instance",
  computerId: WorkjetComputerId.make("computer") };
const references = {
  credentialRef: { environmentId, accountId: WorkjetGatewayAccountId.make("exact-account") },
  providerRef: { environmentId, provider: "codex" as const },
  modelRef: { environmentId, provider: "codex" as const, modelId: "exact-model" },
};
const catalog: WorkjetGatewayScopedCatalog = { schemaVersion: 1, target,
  accounts: [{ credentialRef: references.credentialRef, providerRef: references.providerRef,
    label: "Actual account", modelRefs: [references.modelRef] }] };
const input: WorkjetGatewayInferenceInput = {
  sourceConnectionId: WorkjetConnectionId.make("source-native"),
  permit: {
    contract: "ctox.workjet.remote-worker-admission.v1", permitId: "permit", ownerUserId: "owner",
    authorityEpoch: 1, authorityFingerprint: `sha256:${"a".repeat(64)}`, expiresAtMs: 9000,
    state: "claimed", executionId: "execution",
    binding: {
      requestId: "request", requestDigest: "b".repeat(64), sourceEnvironmentId: environmentId,
      sourceSupervisorThreadId: ThreadId.make("supervisor"), sourceInstanceId: "source-instance",
      projectId: "project", targetEnvironmentId: EnvironmentId.make("target"),
      targetConnectionId: target.connectionId, targetInstanceId: target.instanceId,
      targetComputerId: target.computerId, repositoryUrl: "https://github.com/example/repository",
      repositoryHead: "c".repeat(40), workspaceKey: "request", ...references,
      capabilities: ["repository_read", "repository_write", "run_checks", "open_pull_request"],
    },
  },
  requestJson: JSON.stringify({ model: "exact-model", input: [{ role: "user", content: "Task" }], stream: false }),
};
const fixture = () => {
  const events: string[] = [];
  let scoped = catalog;
  let receipt: unknown = input.permit;
  let now = 1000;
  let afterForward: () => void = () => undefined;
  const consumer = makeSourceGatewayInference({
    environmentId: Effect.succeed(environmentId),
    configuration: Effect.succeed({ ...DEFAULT_WORKJET_CONFIGURATION,
      llmRoutes: [{ id: WorkjetLlmRouteId.make("route"), label: "Configured route",
        gatewayAccountId: references.credentialRef.accountId }] }),
    requireSourceInstance: (instanceId) => instanceId === "codex" ? Effect.void :
      Effect.fail(new WorkjetGatewayInferenceError({ reason: "binding-mismatch" })),
    scopedCatalog: () => Effect.sync(() => { events.push("catalog"); return scoped; }),
    revalidate: () => Effect.sync(() => { events.push("native"); return receipt; }),
    forward: (selected, request, deadline) => Effect.sync(() => {
      events.push("forward");
      expect(selected).toEqual({ target, ...references });
      expect(request).toBe(input.requestJson);
      expect(deadline).toBe(input.permit.expiresAtMs);
      afterForward();
      return JSON.stringify({ output: [{ text: "result" }] });
    }),
    now: Effect.sync(() => now),
  });
  return { consumer, events,
    scope: (value: WorkjetGatewayScopedCatalog) => { scoped = value; },
    native: (value: unknown) => { receipt = value; },
    expire: () => { now = 10000; },
    afterForward: (action: () => void) => { afterForward = action; } };
};
const reason = async (request: Effect.Effect<unknown, WorkjetGatewayInferenceError>) =>
  (await Effect.runPromise(Effect.flip(request))).reason;

describe("source gateway inference", () => {
  it("resolves a real llmRoutes account into exact source references", async () => {
    const f = fixture();
    expect(await Effect.runPromise(f.consumer.bindModel({ target,
      routeId: WorkjetLlmRouteId.make("route"), modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-model" } }))).toEqual({ target, ...references });
    expect(await reason(f.consumer.bindModel({ target,
      routeId: WorkjetLlmRouteId.make("unknown"), modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-model" } }))).toBe("binding-mismatch");
    expect(await reason(f.consumer.bindModel({ target,
      routeId: WorkjetLlmRouteId.make("route"), modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "alias" } }))).toBe("grant-unavailable");
  });
  it("intersects fresh source grants with native revalidation before and after actual forwarding", async () => {
    const f = fixture();
    expect(await Effect.runPromise(f.consumer.infer(input))).toEqual({ requestJson: JSON.stringify({ output: [{ text: "result" }] }) });
    expect(f.events).toEqual(["catalog", "native", "forward", "catalog", "native"]);
    f.scope({ ...catalog, accounts: [] });
    expect(await reason(f.consumer.infer(input))).toBe("grant-unavailable");
    expect(f.events.filter((e) => e === "forward")).toHaveLength(1);
  });
  it.each(["ownerUserId", "authorityEpoch", "executionId", "permitId", "expiresAtMs"])("rejects changed native %s before forwarding", async (field) => {
    const f = fixture();
    f.native({ ...input.permit, [field]: field === "authorityEpoch" || field === "expiresAtMs" ? 2 : "changed" });
    expect(await reason(f.consumer.infer(input))).toBe("native-admission-rejected");
    expect(f.events).not.toContain("forward");
  });
  it("refuses foreign target, provider, model and source account references", async () => {
    for (const modified of [
      { ...catalog, target: { ...target, instanceId: "foreign" } },
      { ...catalog, accounts: [{ ...catalog.accounts[0]!, providerRef: { environmentId, provider: "claude" as const } }] },
      { ...catalog, accounts: [{ ...catalog.accounts[0]!, modelRefs: [] }] },
      { ...catalog, accounts: [{ ...catalog.accounts[0]!, credentialRef: { environmentId, accountId: WorkjetGatewayAccountId.make("foreign") } }] },
    ]) {
      const f = fixture(); f.scope(modified);
      expect(await reason(f.consumer.infer(input))).toMatch(/binding-mismatch|grant-unavailable/);
      expect(f.events).not.toContain("forward");
    }
  });
  it("withholds the response when grant revocation or expiry happens during inference", async () => {
    const revoked = fixture(); revoked.afterForward(() => revoked.scope({ ...catalog, accounts: [] }));
    expect(await reason(revoked.consumer.infer(input))).toBe("grant-unavailable");
    const expired = fixture(); expired.afterForward(expired.expire);
    expect(await reason(expired.consumer.infer(input))).toBe("native-admission-rejected");
  });
  it.each([
    { model: "alias", input: [] }, { model: "exact-model", input: [], stream: true },
    { model: "exact-model", input: [], background: true },
    { model: "exact-model", input: [], previous_response_id: "foreign" },
  ])("rejects alternate model and unbounded/cross-session request shapes", async (body) => {
    const f = fixture();
    expect(await reason(f.consumer.infer({ ...input, requestJson: JSON.stringify(body) }))).toBe("invalid-request");
    expect(f.events).toEqual([]);
  });
});
