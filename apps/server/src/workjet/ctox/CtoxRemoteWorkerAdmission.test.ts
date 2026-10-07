import { assert, it } from "@effect/vitest";
import {
  EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, WorkjetComputerId,
  WorkjetConnectionId, WorkjetGatewayAccountId, WorkjetGatewayAccessError,
  WorkjetDecisionHubConnectionError, type RemoteWorkerRequest,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { CtoxMcpTransportError, type makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import {
  makeCtoxRemoteWorkerAdmissionClient, remoteWorkerRequestDigest,
  type RemoteWorkerNativeBinding, type RemoteWorkerNativeReceipt,
} from "./CtoxRemoteWorkerAdmission.ts";

const scope = { connectionId: WorkjetConnectionId.make("source-native"), instanceId: "managed:source" };
const request: RemoteWorkerRequest = {
  schemaVersion: 1,
  requestId: ThreadId.make("00000000-0000-4000-8000-000000000007"),
  targetEnvironmentId: EnvironmentId.make("gpu3"),
  computerId: WorkjetComputerId.make("connection-gpu3"),
  parent: { environmentId: EnvironmentId.make("desktop"), threadId: ThreadId.make("supervisor") },
  parentTeamRole: "supervisor", parentCapabilityIds: ["greppy"], enabledCapabilityIds: ["greppy"],
  managedInstructions: "Exactly one PR",
  project: {
    id: ProjectId.make("project"), title: "Project",
    repository: {
      canonicalKey: "github:example/project",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://github.com/example/project.git" },
    },
  },
  revision: "a".repeat(40), task: "Fix documentation", title: "Documentation",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access", interactionMode: "default",
  createdAt: "2026-10-07T10:00:00.000Z", expiresAt: "2026-10-08T10:00:00.000Z",
};
const bindingFor = Effect.gen(function* () {
  const binding: RemoteWorkerNativeBinding = {
    requestId: request.requestId, requestDigest: yield* remoteWorkerRequestDigest(request),
    sourceEnvironmentId: request.parent.environmentId,
    sourceSupervisorThreadId: request.parent.threadId, sourceInstanceId: scope.instanceId,
    projectId: request.project.id, targetEnvironmentId: request.targetEnvironmentId,
    targetConnectionId: "target-native", targetInstanceId: "managed:target",
    targetComputerId: "native-computer-gpu3", repositoryUrl: "https://github.com/example/project.git",
    repositoryHead: request.revision, workspaceKey: request.requestId,
    credentialRef: { environmentId: request.parent.environmentId, accountId: WorkjetGatewayAccountId.make("account") },
    providerRef: { environmentId: request.parent.environmentId, provider: "codex" },
    modelRef: { environmentId: request.parent.environmentId, provider: "codex", modelId: request.modelSelection.model },
    capabilities: ["repository_read", "repository_write", "run_checks", "open_pull_request"],
  };
  return binding;
});
const receiptFor = (binding: RemoteWorkerNativeBinding): RemoteWorkerNativeReceipt => ({
  contract: "ctox.workjet.remote-worker-admission.v1", permitId: "permit",
  ownerUserId: "current-owner", authorityEpoch: 3,
  authorityFingerprint: `sha256:${"b".repeat(64)}`, expiresAtMs: 1791389400000,
  binding, state: "issued", executionId: null,
});
function harness(binding: RemoteWorkerNativeBinding) {
  let granted = true;
  let connected = true;
  let loseResponse = false;
  let receipt = receiptFor(binding);
  const calls: Readonly<Record<string, unknown>>[] = [];
  const sourceTargets: unknown[] = [];
  const grantTargets: unknown[] = [];
  const transport: ReturnType<typeof makeCtoxMcpTransport> = {
    probe: (_, tools) => Effect.sync(() => {
      assert.deepEqual(tools, ["business_os.remote_worker_admission"]);
      return undefined;
    }),
    callTool: (target, name, args) => Effect.gen(function* () {
      assert.equal(name, "business_os.remote_worker_admission");
      assert.equal(target.token, "SOURCE_BEARER_CANARY");
      calls.push(args);
      if (args.action === "claim") {
        receipt = { ...receipt, state: "claimed", executionId: String(args.execution_id) };
      }
      if (args.action === "revoke") receipt = { ...receipt, state: "revoked" };
      if (loseResponse) {
        loseResponse = false;
        return yield* new CtoxMcpTransportError({ reason: "connection-unavailable" });
      }
      return { structuredContent: receipt };
    }),
  };
  const client = makeCtoxRemoteWorkerAdmissionClient({
    connections: { resolveReadyTarget: (connection, instance) => {
      sourceTargets.push({ connection, instance });
      return connected ? Effect.succeed({ endpoint: "https://source.invalid/mcp/source", token: "SOURCE_BEARER_CANARY" })
        : Effect.fail(new WorkjetDecisionHubConnectionError({ reason: "connection-unavailable" }));
    } },
    gateway: { scopedCatalog: (target, environmentId) => {
      grantTargets.push({ target, environmentId });
      return granted ? Effect.succeed({
        schemaVersion: 1, target,
        accounts: [{
          credentialRef: binding.credentialRef, providerRef: binding.providerRef,
          label: "Current account", modelRefs: [binding.modelRef],
        }],
      }) : Effect.fail(new WorkjetGatewayAccessError({ reason: "account-unavailable" }));
    } },
    transport,
  });
  return {
    client, calls, sourceTargets, grantTargets,
    revokeAccount: () => { granted = false; },
    disconnect: () => { connected = false; },
    loseNextResponse: () => { loseResponse = true; },
    setReceipt: (next: RemoteWorkerNativeReceipt) => { receipt = next; },
  };
}
it.effect("intersects the current source credential grant at issue, claim and every later usage", () =>
  Effect.gen(function* () {
    const binding = yield* bindingFor;
    const h = harness(binding);
    const issued = yield* h.client.execute(scope, request, binding, "issue");
    assert.equal(issued.permitId, "permit");
    const claimed = yield* h.client.execute(scope, request, binding, "claim", "permit", request.requestId);
    assert.equal(claimed.executionId, request.requestId);
    yield* h.client.execute(scope, request, binding, "revalidate", "permit", request.requestId);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.grantTargets[0], {
      target: { connectionId: "target-native", instanceId: "managed:target", computerId: "native-computer-gpu3" },
      environmentId: "desktop",
    });
    assert.deepEqual(h.sourceTargets[0], { connection: "source-native", instance: "managed:source" });
    assert.isFalse(JSON.stringify(issued).includes("SOURCE_BEARER_CANARY"));
    assert.isFalse(JSON.stringify(h.calls).includes("SOURCE_BEARER_CANARY"));
    h.revokeAccount();
    assert.equal((yield* Effect.flip(h.client.execute(scope, request, binding, "revalidate", "permit", request.requestId))).reason, "computer-unavailable");
    assert.equal(h.calls.length, 3); // No native or gateway usage after current grant denial.
  }),
);
it.effect("revalidates current source connection and does not reuse an offline permit", () =>
  Effect.gen(function* () {
    const binding = yield* bindingFor;
    const h = harness(binding);
    yield* h.client.execute(scope, request, binding, "claim", "permit", request.requestId);
    h.disconnect();
    assert.equal((yield* Effect.flip(h.client.execute(scope, request, binding, "revalidate", "permit", request.requestId))).reason, "source-unavailable");
    assert.equal(h.calls.length, 1);
  }),
);
it.effect("keeps the same request and claim after an accepted reply is lost", () =>
  Effect.gen(function* () {
    const binding = yield* bindingFor;
    const h = harness(binding);
    h.loseNextResponse();
    assert.equal((yield* Effect.flip(h.client.execute(scope, request, binding, "claim", "permit", request.requestId))).reason, "source-unavailable");
    assert.equal(h.calls.length, 1);
    const claimed = yield* h.client.execute(scope, request, binding, "claim", "permit", request.requestId);
    assert.equal(claimed.permitId, "permit");
    assert.equal(claimed.executionId, request.requestId);
    assert.deepEqual(h.calls[0], h.calls[1]);
  }),
);
it.effect("rejects immutable request substitutions before source credentials or native writes are used", () =>
  Effect.gen(function* () {
    const binding = yield* bindingFor;
    const h = harness(binding);
    for (const altered of [
      { ...binding, sourceSupervisorThreadId: "other-parent" },
      { ...binding, sourceInstanceId: "managed:foreign" },
      { ...binding, targetEnvironmentId: "other-target" },
      { ...binding, projectId: "other-project" },
      { ...binding, requestDigest: "c".repeat(64) },
      { ...binding, workspaceKey: "../escape" },
      { ...binding, repositoryHead: "d".repeat(40) },
      { ...binding, repositoryUrl: "https://secret@example.invalid/repo.git" },
      { ...binding, modelRef: { ...binding.modelRef, modelId: "other-model" } },
      { ...binding, credentialRef: { ...binding.credentialRef, environmentId: EnvironmentId.make("gpu3") } },
    ]) {
      assert.equal((yield* Effect.flip(h.client.execute(scope, request, altered, "issue"))).reason, "invalid-request");
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.sourceTargets.length, 0);
  }),
);
it.effect("rejects a substituted native receipt instead of starting another execution", () =>
  Effect.gen(function* () {
    const binding = yield* bindingFor;
    const h = harness(binding);
    for (const altered of [
      { ...receiptFor(binding), binding: { ...binding, targetComputerId: "other" } },
      { ...receiptFor(binding), permitId: "other", state: "claimed" as const, executionId: request.requestId },
      { ...receiptFor(binding), state: "claimed" as const, executionId: "another-execution" },
    ]) {
      h.setReceipt(altered);
      assert.equal((yield* Effect.flip(h.client.execute(scope, request, binding, "revalidate", "permit", request.requestId))).reason, "invalid-request");
    }
  }),
);
it.effect("hashes equivalent key ordering equally and changed work intent differently", () =>
  Effect.gen(function* () {
    const reordered = { ...request, parent: { threadId: request.parent.threadId, environmentId: request.parent.environmentId } };
    const digest = yield* remoteWorkerRequestDigest(request);
    assert.equal(yield* remoteWorkerRequestDigest(reordered), digest);
    assert.notEqual(yield* remoteWorkerRequestDigest({ ...request, task: "Different work" }), digest);
  }),
);

