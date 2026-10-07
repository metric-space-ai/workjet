import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, WorkjetComputerId, type RemoteWorkerRequest, type RemoteWorkerResponse, type OrchestrationThread } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { layerTest as settingsLayer } from "../serverSettings.ts";
import { layer as storeLayer } from "./RemoteWorkerStore.ts";
import { make } from "./RemoteWorkerBroker.ts";

const request: RemoteWorkerRequest = {
  schemaVersion: 1, requestId: ThreadId.make("00000000-0000-4000-8000-000000000001"),
  targetEnvironmentId: EnvironmentId.make("gpu3"), computerId: WorkjetComputerId.make("computer-gpu3"),
  parent: { environmentId: EnvironmentId.make("desktop"), threadId: ThreadId.make("supervisor") },
  parentTeamRole: "supervisor", parentCapabilityIds: ["greppy"], enabledCapabilityIds: ["greppy"],
  managedInstructions: "One PR", project: { id: ProjectId.make("project"), title: "Project", repository: { canonicalKey: "github:example/project", locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://github.com/example/project.git" } } },
  revision: "a".repeat(40), task: "Fix documentation", title: "Documentation", modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access", interactionMode: "default", createdAt: "2026-10-07T10:00:00.000Z", expiresAt: "2026-10-08T10:00:00.000Z",
};
const response: RemoteWorkerResponse = { requestId: request.requestId, outcome: { status: "dispatched", result: {
  schemaVersion: 1, status: "dispatched", environmentId: request.targetEnvironmentId, workerThreadId: request.requestId, computerId: request.computerId,
  branch: `workjet/worker/${request.requestId}`, worktreePath: "/target/owned-worker", parent: request.parent, modelSelection: request.modelSelection, enabledCapabilityIds: request.enabledCapabilityIds,
} } };
function runtime(parentCapabilities = ["greppy"], computers = true) {
  const parent = { id: request.parent.threadId, projectId: request.project.id, deletedAt: null, archivedAt: null, workjetConfig: { role: "orchestrator", enabledCapabilityIds: parentCapabilities } } as unknown as OrchestrationThread;
  return Layer.mergeAll(storeLayer, settingsLayer({ workjet: { selectedComputerId: null, computers: computers ? [{ id: request.computerId, label: "gpu3", environmentId: request.targetEnvironmentId, presentationKind: "ssh", harnesses: [] }] : [] } }), Layer.succeed(ProjectionSnapshotQuery, {
    getThreadDetailById: () => Effect.succeed(Option.some(parent)),
  } as unknown as ProjectionSnapshotQuery["Service"])).pipe(Layer.provide(SqlitePersistenceMemory));
}
it.effect("replays a source response lost during desktop quit under the original worker ID", () => Effect.gen(function* () {
  const broker = yield* make;
  yield* broker.enqueue(request);
  assert.deepEqual(yield* Stream.runHead(broker.requests), Option.some([request]));
  yield* broker.respond(response);
  yield* broker.respond(response);
  assert.deepEqual(yield* broker.awaitResponse(request.requestId), response);
  assert.deepEqual(yield* Stream.runHead(broker.requests), Option.some([]));
}).pipe(Effect.provide(runtime())));
it.effect("rejects a target reply that substitutes the computer, source parent, branch, capabilities or model", () => Effect.gen(function* () {
  const broker = yield* make;
  yield* broker.enqueue(request);
  if (response.outcome.status !== "dispatched") return yield* Effect.die("fixture");
  const result = response.outcome.result;
  for (const altered of [
    { ...result, environmentId: EnvironmentId.make("other-target") },
    { ...result, computerId: WorkjetComputerId.make("other-computer") },
    { ...result, parent: { ...result.parent, threadId: ThreadId.make("other-parent") } },
    { ...result, branch: "foreign" }, { ...result, enabledCapabilityIds: [] },
    { ...result, modelSelection: { ...result.modelSelection, model: "substituted-model" } },
  ]) {
    assert.equal((yield* Effect.flip(broker.respond({ requestId: request.requestId, outcome: { status: "dispatched", result: altered } }))).reason, "invalid-request");
  }
  assert.equal(Option.getOrThrow(yield* broker.read(request.requestId)).response, null);
}).pipe(Effect.provide(runtime())));
for (const [label, capabilities, computers] of [["parent loses its capability", [], true], ["computer is removed", ["greppy"], false]] as const) {
  it.effect(`does not relay a pending request after ${label}`, () => Effect.gen(function* () {
    const broker = yield* make;
    yield* broker.enqueue(request);
    assert.deepEqual(yield* Stream.runHead(broker.requests), Option.some([]));
    assert.deepEqual(yield* broker.awaitResponse(request.requestId), { requestId: request.requestId, outcome: { status: "failed", reason: "source-unavailable" } });
  }).pipe(Effect.provide(runtime([...capabilities], computers))));
}
