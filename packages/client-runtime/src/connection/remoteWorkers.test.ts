import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, WorkjetComputerId, type RemoteWorkerRequest } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { RemoteWorkerRelayUnavailable, relayRemoteWorker, type RemoteWorkerRelayPort } from "./remoteWorkers.ts";
const source = EnvironmentId.make("desktop");
const input: RemoteWorkerRequest = {
  schemaVersion: 1, requestId: ThreadId.make("00000000-0000-4000-8000-000000000001"), targetEnvironmentId: EnvironmentId.make("gpu3"), computerId: WorkjetComputerId.make("computer-gpu3"),
  parent: { environmentId: source, threadId: ThreadId.make("supervisor") }, parentCapabilityIds: [], managedInstructions: "One PR", project: { id: ProjectId.make("project"), title: "Project", repository: { canonicalKey: "github:example/project", locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://github.com/example/project.git" } } },
  revision: "a".repeat(40), task: "Fix documentation", title: "Documentation", modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" }, enabledCapabilityIds: [], runtimeMode: "full-access", interactionMode: "default", createdAt: "2026-10-07T10:00:00.000Z", expiresAt: "2026-10-08T10:00:00.000Z",
};
it.effect("keeps the exact request when the target committed but its reply or source acknowledgement was lost", () => Effect.gen(function* () {
  const deliveries: RemoteWorkerRequest[] = [];
  const responses: unknown[] = [];
  let loseTargetAck = true;
  let loseSourceAck = true;
  const port: RemoteWorkerRelayPort = {
    receive: (request) => Effect.suspend(() => {
      deliveries.push(request);
      if (loseTargetAck) { loseTargetAck = false; return Effect.fail(new RemoteWorkerRelayUnavailable({})); }
      return Effect.succeed({ status: "dispatched" as const, result: { schemaVersion: 1 as const, status: "dispatched" as const, environmentId: request.targetEnvironmentId, workerThreadId: request.requestId, computerId: request.computerId, branch: `workjet/worker/${request.requestId}`, worktreePath: "/gpu3/worker", parent: request.parent, modelSelection: request.modelSelection, enabledCapabilityIds: request.enabledCapabilityIds } });
    }),
    respond: (environmentId, response) => Effect.suspend(() => {
      assert.equal(environmentId, source); responses.push(response);
      if (loseSourceAck) { loseSourceAck = false; return Effect.fail(new RemoteWorkerRelayUnavailable({})); }
      return Effect.void;
    }),
  };
  yield* Effect.flip(relayRemoteWorker(source, input, port));
  yield* Effect.flip(relayRemoteWorker(source, input, port));
  yield* relayRemoteWorker(source, input, port);
  assert.deepEqual(deliveries, [input, input, input]);
  assert.deepEqual(responses[0], responses[1]);
}));
it.effect("does not relay a forged source-parent pair or a same-computer selection", () => Effect.gen(function* () {
  const port: RemoteWorkerRelayPort = { receive: () => Effect.die("must not deliver"), respond: () => Effect.die("must not respond") };
  yield* relayRemoteWorker(EnvironmentId.make("foreign"), input, port);
  yield* relayRemoteWorker(source, { ...input, targetEnvironmentId: source }, port);
}));
it.effect("returns a durable explicit rejection without changing the request identity", () => Effect.gen(function* () {
  let acknowledged = false;
  const port: RemoteWorkerRelayPort = { receive: () => Effect.succeed({ status: "failed", reason: "computer-unavailable" }), respond: (environmentId, response) => Effect.sync(() => {
    assert.equal(environmentId, source); assert.deepEqual(response, { requestId: input.requestId, outcome: { status: "failed", reason: "computer-unavailable" } }); acknowledged = true;
  }) };
  yield* relayRemoteWorker(source, input, port);
  assert.equal(acknowledged, true);
}));
