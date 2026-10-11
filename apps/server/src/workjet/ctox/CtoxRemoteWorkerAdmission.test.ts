import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetGatewayAccountId,
  WorkjetGatewayAccessError,
  WorkjetDecisionHubConnectionError,
  type RemoteWorkerRequest,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import { CtoxMcpTransportError, type makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import {
  makeCtoxRemoteWorkerAdmissionClient,
  remoteWorkerRequestDigest,
  type RemoteWorkerNativeBinding,
  type RemoteWorkerNativeReceipt,
} from "./CtoxRemoteWorkerAdmission.ts";

const scope = {
  connectionId: WorkjetConnectionId.make("source-native"),
  instanceId: "managed:source",
};
const request: RemoteWorkerRequest = {
  schemaVersion: 1,
  requestId: ThreadId.make("00000000-0000-4000-8000-000000000007"),
  targetEnvironmentId: EnvironmentId.make("gpu3"),
  computerId: WorkjetComputerId.make("connection-gpu3"),
  parent: { environmentId: EnvironmentId.make("desktop"), threadId: ThreadId.make("supervisor") },
  parentTeamRole: "supervisor",
  parentCapabilityIds: ["greppy"],
  enabledCapabilityIds: ["greppy"],
  managedInstructions: "Exactly one PR",
  project: {
    id: ProjectId.make("project"),
    title: "Project",
    repository: {
      canonicalKey: "github:example/project",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/project.git",
      },
    },
  },
  revision: "a".repeat(40),
  task: "Fix documentation",
  title: "Documentation",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-10-07T10:00:00.000Z",
  expiresAt: "2026-10-08T10:00:00.000Z",
};
const bindingFor = Effect.gen(function* () {
  const binding: RemoteWorkerNativeBinding = {
    requestId: request.requestId,
    requestDigest: yield* remoteWorkerRequestDigest(request),
    sourceEnvironmentId: request.parent.environmentId,
    sourceSupervisorThreadId: request.parent.threadId,
    sourceInstanceId: scope.instanceId,
    projectId: request.project.id,
    targetEnvironmentId: request.targetEnvironmentId,
    targetConnectionId: "target-native",
    targetInstanceId: "managed:target",
    targetComputerId: "native-computer-gpu3",
    repositoryUrl: "https://github.com/example/project.git",
    repositoryHead: request.revision,
    workspaceKey: request.requestId,
    credentialRef: {
      environmentId: request.parent.environmentId,
      accountId: WorkjetGatewayAccountId.make("account"),
    },
    providerRef: { environmentId: request.parent.environmentId, provider: "codex" },
    modelRef: {
      environmentId: request.parent.environmentId,
      provider: "codex",
      modelId: request.modelSelection.model,
    },
    capabilities: ["repository_read", "repository_write", "run_checks", "open_pull_request"],
  };
  return binding;
});
const receiptFor = (binding: RemoteWorkerNativeBinding): RemoteWorkerNativeReceipt => ({
  contract: "ctox.workjet.remote-worker-admission.v1",
  permitId: "permit",
  ownerUserId: "current-owner",
  authorityEpoch: 3,
  authorityFingerprint: `sha256:${"b".repeat(64)}`,
  expiresAtMs: 1791389400000,
  binding,
  state: "issued",
  executionId: null,
  renewalSequence: 0,
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
    probe: (_, tools) =>
      Effect.sync(() => {
        assert.deepEqual(tools, ["business_os.remote_worker_admission"]);
        return undefined;
      }),
    callTool: (target, name, args) =>
      Effect.gen(function* () {
        assert.equal(name, "business_os.remote_worker_admission");
        assert.equal(target.token, "SOURCE_BEARER_CANARY");
        calls.push(args);
        if (args.action === "claim") {
          receipt = { ...receipt, state: "claimed", executionId: String(args.execution_id) };
        }
        if (args.action === "renew")
          receipt = { ...receipt, renewalSequence: Number(args.renewal_sequence) };
        if (args.action === "revoke") receipt = { ...receipt, state: "revoked" };
        if (loseResponse) {
          loseResponse = false;
          return yield* new CtoxMcpTransportError({ reason: "connection-unavailable" });
        }
        return { structuredContent: receipt };
      }),
  };
  const client = makeCtoxRemoteWorkerAdmissionClient({
    connections: {
      resolveReadyTarget: (connection, instance) => {
        sourceTargets.push({ connection, instance });
        return connected
          ? Effect.succeed({
              endpoint: "https://source.invalid/mcp/source",
              token: "SOURCE_BEARER_CANARY",
            })
          : Effect.fail(
              new WorkjetDecisionHubConnectionError({ reason: "connection-unavailable" }),
            );
      },
    },
    gateway: {
      scopedCatalog: (target, environmentId) => {
        grantTargets.push({ target, environmentId });
        return granted
          ? Effect.succeed({
              schemaVersion: 1,
              target,
              accounts: [
                {
                  credentialRef: binding.credentialRef,
                  providerRef: binding.providerRef,
                  label: "Current account",
                  modelRefs: [binding.modelRef],
                },
              ],
            })
          : Effect.fail(new WorkjetGatewayAccessError({ reason: "account-unavailable" }));
      },
    },
    transport,
  });
  return {
    client,
    calls,
    sourceTargets,
    grantTargets,
    revokeAccount: () => {
      granted = false;
    },
    disconnect: () => {
      connected = false;
    },
    loseNextResponse: () => {
      loseResponse = true;
    },
    setReceipt: (next: RemoteWorkerNativeReceipt) => {
      receipt = next;
    },
  };
}
const nativeParentReference = {
  contract: "ctox.workjet.persistent-worker-binding.v1",
  owner_user_id: "current-owner",
  project_id: request.project.id,
  supervisor_thread_id: "b2cd2661-181e-41fd-a54e-ea5642ccf0dc",
  thread_id: "21a77758-8723-431b-bbeb-3aa9f0507c4d",
  role: "persistent_worker",
  revision: 1,
  state: "active",
} as const;
const parentRequest: RemoteWorkerRequest = {
  ...request,
  parent: { ...request.parent, threadId: ThreadId.make(nativeParentReference.thread_id) },
  parentTeamRole: "specialist",
  parentTeamBinding: nativeParentReference,
};

it.effect("keeps the actual Parent UUID and complete reference at every native phase and lost ACK retry", () =>
  Effect.gen(function* () {
    const binding = {
      ...(yield* bindingFor),
      sourceSupervisorThreadId: parentRequest.parent.threadId,
      requestDigest: yield* remoteWorkerRequestDigest(parentRequest),
      parentTeamBinding: nativeParentReference,
    };
    const h = harness(binding);
    yield* h.client.execute(scope, parentRequest, binding, "issue");
    h.loseNextResponse();
    yield* Effect.flip(h.client.execute(scope, parentRequest, binding, "claim", "permit", "execution"));
    for (const action of ["claim", "revalidate", "renew"] as const)
      yield* h.client.execute(scope, parentRequest, binding, action, "permit", "execution", action === "renew" ? 1 : undefined);
    h.revokeAccount();
    yield* h.client.execute(scope, parentRequest, binding, "revoke", "permit", "execution");
    for (const call of h.calls) {
      assert.deepEqual(call.binding, binding);
      assert.equal(binding.sourceSupervisorThreadId, nativeParentReference.thread_id);
    }
    assert.notEqual(
      yield* remoteWorkerRequestDigest(parentRequest),
      yield* remoteWorkerRequestDigest({ ...parentRequest, parentTeamBinding: { ...nativeParentReference, revision: 2 } }),
    );
  }),
);

it.effect("denies dropped Parent references, substituted Root UUIDs and role before native side effects", () =>
  Effect.gen(function* () {
    const binding = {
      ...(yield* bindingFor),
      sourceSupervisorThreadId: parentRequest.parent.threadId,
      requestDigest: yield* remoteWorkerRequestDigest(parentRequest),
      parentTeamBinding: nativeParentReference,
    };
    const { parentTeamBinding: _reference, ...withoutReference } = binding;
    for (const changed of [
      withoutReference,
      { ...binding, sourceSupervisorThreadId: nativeParentReference.supervisor_thread_id },
      { ...binding, parentTeamBinding: { ...nativeParentReference, revision: 2 } },
      { ...binding, parentTeamBinding: { ...nativeParentReference, project_id: "foreign-project" } },
    ]) {
      const h = harness(binding);
      for (const action of ["issue", "claim", "revalidate", "renew", "revoke"] as const) {
        const error = yield* Effect.flip(h.client.execute(scope, parentRequest, changed, action, "permit", "execution", 1));
        assert.equal(error.reason, "invalid-request");
      }
      assert.deepEqual(h.calls, []);
    }
    const h = harness(binding);
    const wrongRole = { ...parentRequest, parentTeamRole: "supervisor" as const };
    assert.equal(
      (yield* Effect.flip(h.client.execute(scope, wrongRole, { ...binding, requestDigest: yield* remoteWorkerRequestDigest(wrongRole) }, "issue"))).reason,
      "invalid-request",
    );
    assert.deepEqual(h.calls, []);
  }),
);

it.effect("rejects a substituted native Owner or complete Parent receipt at all phases", () =>
  Effect.gen(function* () {
    const binding = {
      ...(yield* bindingFor),
      sourceSupervisorThreadId: parentRequest.parent.threadId,
      requestDigest: yield* remoteWorkerRequestDigest(parentRequest),
      parentTeamBinding: nativeParentReference,
    };
    for (const action of ["issue", "claim", "revalidate", "renew", "revoke"] as const) {
      const h = harness(binding);
      h.setReceipt({ ...receiptFor(binding), ownerUserId: "foreign-owner" });
      assert.equal((yield* Effect.flip(h.client.execute(scope, parentRequest, binding, action, "permit", "execution", 1))).reason, "invalid-request");
      h.setReceipt({ ...receiptFor(binding), binding: { ...binding, parentTeamBinding: { ...nativeParentReference, revision: 2 } } });
      assert.equal((yield* Effect.flip(h.client.execute(scope, parentRequest, binding, action, "permit", "execution", 1))).reason, "invalid-request");
    }
  }),
);

it.effect(
  "intersects the current source credential grant at issue, claim and every later usage",
  () =>
    Effect.gen(function* () {
      const binding = yield* bindingFor;
      const h = harness(binding);
      const issued = yield* h.client.execute(scope, request, binding, "issue");
      assert.equal(issued.permitId, "permit");
      const claimed = yield* h.client.execute(
        scope,
        request,
        binding,
        "claim",
        "permit",
        request.requestId,
      );
      assert.equal(claimed.executionId, request.requestId);
      yield* h.client.execute(scope, request, binding, "revalidate", "permit", request.requestId);
      assert.equal(h.calls.length, 3);
      assert.deepEqual(h.grantTargets[0], {
        target: {
          connectionId: "target-native",
          instanceId: "managed:target",
          computerId: "native-computer-gpu3",
        },
        environmentId: "desktop",
      });
      assert.deepEqual(h.sourceTargets[0], {
        connection: "source-native",
        instance: "managed:source",
      });
      assert.isFalse(encodeJson(issued).includes("SOURCE_BEARER_CANARY"));
      assert.isFalse(encodeJson(h.calls).includes("SOURCE_BEARER_CANARY"));
      h.revokeAccount();
      assert.equal(
        (yield* Effect.flip(
          h.client.execute(scope, request, binding, "revalidate", "permit", request.requestId),
        )).reason,
        "computer-unavailable",
      );
      assert.equal(h.calls.length, 3); // No native or gateway usage after current grant denial.
    }),
);
it.effect("revalidates current source connection and does not reuse an offline permit", () =>
  Effect.gen(function* () {
    const binding = yield* bindingFor;
    const h = harness(binding);
    yield* h.client.execute(scope, request, binding, "claim", "permit", request.requestId);
    h.disconnect();
    assert.equal(
      (yield* Effect.flip(
        h.client.execute(scope, request, binding, "revalidate", "permit", request.requestId),
      )).reason,
      "source-unavailable",
    );
    assert.equal(h.calls.length, 1);
  }),
);
it.effect("keeps the same request and claim after an accepted reply is lost", () =>
  Effect.gen(function* () {
    const binding = yield* bindingFor;
    const h = harness(binding);
    h.loseNextResponse();
    assert.equal(
      (yield* Effect.flip(
        h.client.execute(scope, request, binding, "claim", "permit", request.requestId),
      )).reason,
      "source-unavailable",
    );
    assert.equal(h.calls.length, 1);
    const claimed = yield* h.client.execute(
      scope,
      request,
      binding,
      "claim",
      "permit",
      request.requestId,
    );
    assert.equal(claimed.permitId, "permit");
    assert.equal(claimed.executionId, request.requestId);
    assert.deepEqual(h.calls[0], h.calls[1]);
  }),
);
it.effect(
  "rejects immutable request substitutions before source credentials or native writes are used",
  () =>
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
        {
          ...binding,
          credentialRef: { ...binding.credentialRef, environmentId: EnvironmentId.make("gpu3") },
        },
      ]) {
        assert.equal(
          (yield* Effect.flip(h.client.execute(scope, request, altered, "issue"))).reason,
          "invalid-request",
        );
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
      {
        ...receiptFor(binding),
        permitId: "other",
        state: "claimed" as const,
        executionId: request.requestId,
      },
      { ...receiptFor(binding), state: "claimed" as const, executionId: "another-execution" },
    ]) {
      h.setReceipt(altered);
      assert.equal(
        (yield* Effect.flip(
          h.client.execute(scope, request, binding, "revalidate", "permit", request.requestId),
        )).reason,
        "invalid-request",
      );
    }
  }),
);
it.effect("hashes equivalent key ordering equally and changed work intent differently", () =>
  Effect.gen(function* () {
    const reordered = {
      ...request,
      parent: { threadId: request.parent.threadId, environmentId: request.parent.environmentId },
    };
    const digest = yield* remoteWorkerRequestDigest(request);
    assert.equal(yield* remoteWorkerRequestDigest(reordered), digest);
    assert.notEqual(
      yield* remoteWorkerRequestDigest({ ...request, task: "Different work" }),
      digest,
    );
  }),
);

it.effect("renews the same claimed execution with a stable sequence after a lost reply", () =>
  Effect.gen(function* () {
    const binding = yield* bindingFor;
    const h = harness(binding);
    yield* h.client.execute(scope, request, binding, "claim", "permit", request.requestId);
    h.loseNextResponse();
    assert.equal(
      (yield* Effect.flip(
        h.client.execute(scope, request, binding, "renew", "permit", request.requestId, 1),
      )).reason,
      "source-unavailable",
    );
    const renewed = yield* h.client.execute(
      scope,
      request,
      binding,
      "renew",
      "permit",
      request.requestId,
      1,
    );
    assert.equal(renewed.executionId, request.requestId);
    assert.equal(renewed.renewalSequence, 1);
    assert.deepEqual(h.calls[1], h.calls[2]);
    assert.equal(
      (yield* Effect.flip(
        h.client.execute(scope, request, binding, "renew", "permit", request.requestId, 0),
      )).reason,
      "invalid-request",
    );
    assert.equal(h.calls.length, 3);
  }),
);
it.effect(
  "allows native cancellation after a model grant is removed without authorizing another usage",
  () =>
    Effect.gen(function* () {
      const binding = yield* bindingFor;
      const h = harness(binding);
      yield* h.client.execute(scope, request, binding, "claim", "permit", request.requestId);
      h.revokeAccount();
      const revoked = yield* h.client.execute(scope, request, binding, "revoke", "permit");
      assert.equal(revoked.state, "revoked");
      assert.equal(h.calls.length, 2);
      assert.equal(
        (yield* Effect.flip(
          h.client.execute(scope, request, binding, "renew", "permit", request.requestId, 1),
        )).reason,
        "computer-unavailable",
      );
      assert.equal(h.calls.length, 2);
    }),
);

it.effect(
  "retains the exact project policy throughout native issue, claim, renewal and revocation",
  () =>
    Effect.gen(function* () {
      const policy = {
        mode: "autonomous-worktree" as const,
        projectId: request.project.id,
        revision: 4,
      };
      const scopedRequest = { ...request, executionPolicy: policy };
      const binding = {
        ...(yield* bindingFor),
        requestDigest: yield* remoteWorkerRequestDigest(scopedRequest),
        executionPolicy: policy,
      };
      const h = harness(binding);
      const issued = yield* h.client.execute(scope, scopedRequest, binding, "issue");
      const claimed = yield* h.client.execute(
        scope,
        scopedRequest,
        binding,
        "claim",
        issued.permitId,
        request.requestId,
      );
      yield* h.client.execute(
        scope,
        scopedRequest,
        binding,
        "revalidate",
        claimed.permitId,
        request.requestId,
      );
      const renewed = yield* h.client.execute(
        scope,
        scopedRequest,
        binding,
        "renew",
        claimed.permitId,
        request.requestId,
        1,
      );
      h.revokeAccount();
      const revoked = yield* h.client.execute(
        scope,
        scopedRequest,
        binding,
        "revoke",
        renewed.permitId,
        request.requestId,
      );
      assert.equal(revoked.state, "revoked");
      assert.deepEqual(revoked.binding.executionPolicy, policy);
      assert.equal(h.calls.length, 5);
      for (const call of h.calls) assert.deepEqual(call.binding, binding);
    }),
);
it.effect(
  "rejects policy stripping, substitution and unsolicited policy before native or account access",
  () =>
    Effect.gen(function* () {
      const policy = {
        mode: "autonomous-worktree" as const,
        projectId: request.project.id,
        revision: 4,
      };
      const scopedRequest = { ...request, executionPolicy: policy };
      const original = yield* bindingFor;
      const binding = {
        ...original,
        requestDigest: yield* remoteWorkerRequestDigest(scopedRequest),
        executionPolicy: policy,
      };
      const { executionPolicy: _policy, ...unscoped } = binding;
      const h = harness(binding);
      for (const actual of [
        unscoped,
        { ...binding, executionPolicy: { ...policy, revision: 5 } },
        {
          ...binding,
          executionPolicy: { ...policy, projectId: ProjectId.make("foreign-project") },
        },
      ]) {
        assert.equal(
          (yield* Effect.flip(h.client.execute(scope, scopedRequest, actual, "issue"))).reason,
          "invalid-request",
        );
      }
      const unsolicited = { ...original, executionPolicy: policy };
      assert.equal(
        (yield* Effect.flip(h.client.execute(scope, request, unsolicited, "issue"))).reason,
        "invalid-request",
      );
      assert.equal(h.calls.length, 0);
      assert.equal(h.sourceTargets.length, 0);
      assert.equal(h.grantTargets.length, 0);
    }),
);
it.effect(
  "rejects a downgraded or changed native policy receipt without losing its comparison field",
  () =>
    Effect.gen(function* () {
      const policy = {
        mode: "autonomous-worktree" as const,
        projectId: request.project.id,
        revision: 4,
      };
      const scopedRequest = { ...request, executionPolicy: policy };
      const binding = {
        ...(yield* bindingFor),
        requestDigest: yield* remoteWorkerRequestDigest(scopedRequest),
        executionPolicy: policy,
      };
      const h = harness(binding);
      const { executionPolicy: _policy, ...unscoped } = binding;
      for (const actual of [
        unscoped,
        { ...binding, executionPolicy: { ...policy, revision: 5 } },
        {
          ...binding,
          executionPolicy: { ...policy, projectId: ProjectId.make("foreign-project") },
        },
      ]) {
        h.setReceipt(receiptFor(actual));
        assert.equal(
          (yield* Effect.flip(h.client.execute(scope, scopedRequest, binding, "issue"))).reason,
          "invalid-request",
        );
      }
      h.setReceipt(receiptFor(binding));
      assert.deepEqual(
        (yield* h.client.execute(scope, scopedRequest, binding, "issue")).binding.executionPolicy,
        policy,
      );
    }),
);
it.effect("keeps the policy and execution identity after a lost native claim reply", () =>
  Effect.gen(function* () {
    const policy = {
      mode: "autonomous-worktree" as const,
      projectId: request.project.id,
      revision: 4,
    };
    const scopedRequest = { ...request, executionPolicy: policy };
    const binding = {
      ...(yield* bindingFor),
      requestDigest: yield* remoteWorkerRequestDigest(scopedRequest),
      executionPolicy: policy,
    };
    const h = harness(binding);
    h.loseNextResponse();
    assert.equal(
      (yield* Effect.flip(
        h.client.execute(scope, scopedRequest, binding, "claim", "permit", request.requestId),
      )).reason,
      "source-unavailable",
    );
    const claimed = yield* h.client.execute(
      scope,
      scopedRequest,
      binding,
      "claim",
      "permit",
      request.requestId,
    );
    assert.equal(claimed.executionId, request.requestId);
    assert.deepEqual(claimed.binding.executionPolicy, policy);
    assert.deepEqual(h.calls[0], h.calls[1]);
  }),
);
