import { assert, it } from "@effect/vitest";
import {
  EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, WorkjetComputerId,
  WorkjetConnectionId, WorkjetGatewayAccountId, RemoteWorkerDispatchError, type RemoteWorkerRequest,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RemoteWorkerAuthorityStore, layer, type RemoteWorkerAuthorityIntent } from "./RemoteWorkerAuthorityStore.ts";
import { makeRemoteWorkerSourceAuthority } from "./RemoteWorkerSourceAuthority.ts";
import {
  remoteWorkerRequestDigest, type RemoteWorkerNativeBinding, type RemoteWorkerNativeReceipt,
  type makeCtoxRemoteWorkerAdmissionClient,
} from "./ctox/CtoxRemoteWorkerAdmission.ts";

const request: RemoteWorkerRequest = {
  schemaVersion: 1, requestId: ThreadId.make("00000000-0000-4000-8000-000000000007"),
  targetEnvironmentId: EnvironmentId.make("gpu3"), computerId: WorkjetComputerId.make("connection-gpu3"),
  parent: { environmentId: EnvironmentId.make("desktop"), threadId: ThreadId.make("supervisor") },
  parentTeamRole: "supervisor", parentCapabilityIds: [], enabledCapabilityIds: [],
  managedInstructions: "Exactly one PR", project: {
    id: ProjectId.make("project"), title: "Project", repository: {
      canonicalKey: "github:example/project",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://github.com/example/project.git" },
    },
  },
  revision: "a".repeat(40), task: "Fix documentation", title: "Documentation",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access", interactionMode: "default",
  createdAt: "2026-10-07T10:00:00.000Z", expiresAt: "2026-10-08T10:00:00.000Z",
};
const intentFor = Effect.gen(function* () {
  const binding: RemoteWorkerNativeBinding = {
    requestId: request.requestId, requestDigest: yield* remoteWorkerRequestDigest(request),
    sourceEnvironmentId: request.parent.environmentId, sourceSupervisorThreadId: request.parent.threadId,
    sourceInstanceId: "managed:source", projectId: request.project.id,
    targetEnvironmentId: request.targetEnvironmentId, targetConnectionId: "native-target",
    targetInstanceId: "managed:target", targetComputerId: "native-computer",
    repositoryUrl: "https://github.com/example/project.git", repositoryHead: request.revision,
    workspaceKey: request.requestId,
    credentialRef: { environmentId: request.parent.environmentId, accountId: WorkjetGatewayAccountId.make("account") },
    providerRef: { environmentId: request.parent.environmentId, provider: "codex" },
    modelRef: { environmentId: request.parent.environmentId, provider: "codex", modelId: request.modelSelection.model },
    capabilities: ["repository_read", "repository_write", "run_checks", "open_pull_request"],
  };
  return { request, scope: { connectionId: WorkjetConnectionId.make("source"), instanceId: "managed:source" }, binding } satisfies RemoteWorkerAuthorityIntent;
});
const testLayer = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const receiptFor = (intent: RemoteWorkerAuthorityIntent): RemoteWorkerNativeReceipt => ({
  contract: "ctox.workjet.remote-worker-admission.v1", permitId: "permit", ownerUserId: "owner",
  authorityEpoch: 3, authorityFingerprint: `sha256:${"b".repeat(64)}`, expiresAtMs: 300_000,
  binding: intent.binding, state: "issued", executionId: null, renewalSequence: 0,
});

it.effect("persists immutable native intent before issuance and fences receipt replacement", () =>
  Effect.gen(function* () {
    const store = yield* RemoteWorkerAuthorityStore;
    const intent = yield* intentFor;
    yield* store.prepare(intent);
    assert.equal(Option.getOrThrow(yield* store.get(request.requestId)).receipt, null);
    yield* store.prepare(intent);
    const changed = yield* Effect.flip(store.prepare({ ...intent, scope: { ...intent.scope, connectionId: WorkjetConnectionId.make("different-source") } }));
    assert.equal(changed._tag, "RemoteWorkerDispatchError");
    const issued = receiptFor(intent);
    yield* store.saveReceipt(request.requestId, null, issued);
    const claimed = { ...issued, state: "claimed" as const, executionId: "one-execution" };
    yield* store.saveReceipt(request.requestId, issued, claimed);
    const substituted = yield* Effect.flip(store.saveReceipt(request.requestId, claimed, { ...claimed, executionId: "second-execution" }));
    assert.equal(substituted._tag, "RemoteWorkerDispatchError");
    const skipped = yield* Effect.flip(store.saveReceipt(request.requestId, claimed, { ...claimed, renewalSequence: 2, expiresAtMs: 500_000 }));
    assert.equal(skipped._tag, "RemoteWorkerDispatchError");
    const renewed = { ...claimed, renewalSequence: 1, expiresAtMs: 500_000 };
    yield* store.saveReceipt(request.requestId, claimed, renewed);
    yield* store.saveReceipt(request.requestId, claimed, renewed);
    const revoked = { ...renewed, state: "revoked" as const };
    yield* store.saveReceipt(request.requestId, renewed, revoked);
    const revived = yield* Effect.flip(store.saveReceipt(request.requestId, revoked, renewed));
    assert.equal(revived._tag, "RemoteWorkerDispatchError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lost native ACK retries the same saved request, execution and renewal sequence", () =>
  Effect.gen(function* () {
    const store = yield* RemoteWorkerAuthorityStore;
    const intent = yield* intentFor;
    let receipt = receiptFor(intent);
    let now = 0;
    let loseClaimAck = true;
    let loseRenewAck = true;
    let granted = true;
    const calls: Array<{ action: string; execution?: string; sequence?: number }> = [];
    const native: ReturnType<typeof makeCtoxRemoteWorkerAdmissionClient> = {
      execute: (_scope, actual, binding, action, permitId, execution, sequence) => Effect.gen(function* () {
        assert.deepEqual(actual, intent.request);
        assert.deepEqual(binding, intent.binding);
        assert.ok(Option.isSome(yield* store.get(request.requestId).pipe(Effect.mapError(() => new RemoteWorkerDispatchError({ reason: "source-unavailable" })))), "intent must precede native side effects");
        calls.push({ action, ...(execution === undefined ? {} : { execution }), ...(sequence === undefined ? {} : { sequence }) });
        if (!granted && action !== "revoke") return yield* new RemoteWorkerDispatchError({ reason: "computer-unavailable" });
        if (permitId !== undefined) assert.equal(permitId, "permit");
        if (action === "claim") {
          receipt = { ...receipt, state: "claimed", executionId: execution ?? null };
          if (loseClaimAck) { loseClaimAck = false; return yield* new RemoteWorkerDispatchError({ reason: "source-unavailable" }); }
        }
        if (action === "renew") {
          assert.equal(sequence, 1);
          if (sequence === undefined) return yield* new RemoteWorkerDispatchError({ reason: "invalid-request" });
          receipt = { ...receipt, renewalSequence: sequence, expiresAtMs: 550_000 };
          if (loseRenewAck) { loseRenewAck = false; return yield* new RemoteWorkerDispatchError({ reason: "source-unavailable" }); }
        }
        if (action === "revoke") receipt = { ...receipt, state: "revoked" };
        return receipt;
      }),
    };
    const authority = yield* makeRemoteWorkerSourceAuthority(store, native, () => now);
    yield* Effect.flip(authority.prepare(intent));
    const first = yield* authority.admit(request);
    assert.equal(first.permit.state, "claimed");
    assert.deepEqual(calls.filter((call) => call.action === "claim").map((call) => call.execution), [
      "workjet:gpu3:00000000-0000-4000-8000-000000000007",
      "workjet:gpu3:00000000-0000-4000-8000-000000000007",
    ]);
    now = 250_000;
    yield* Effect.flip(authority.admit(request));
    const renewed = yield* authority.admit(request);
    assert.equal(renewed.permit.renewalSequence, 1);
    assert.deepEqual(calls.filter((call) => call.action === "renew").map((call) => call.sequence), [1, 1]);
    granted = false;
    const denial = yield* Effect.flip(authority.admit(request));
    assert.equal(denial.reason, "computer-unavailable");
    yield* authority.revoke(request);
    assert.equal(Option.getOrThrow(yield* store.get(request.requestId)).receipt?.state, "revoked");
    const callCount = calls.length;
    yield* Effect.flip(authority.admit(request));
    assert.equal(calls.length, callCount, "revoked persisted lease never reaches native again");
  }).pipe(Effect.provide(testLayer)),
);
