// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, it } from "@effect/vitest";
import { RemoteWorkerDispatchError, type ChangeRequest } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { RemoteWorkerStore, layer as remoteLayer } from "./RemoteWorkerStore.ts";
import { WorkerPullRequestStore, layer as prLayer } from "./WorkerPullRequestStore.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import { terminalReceiptFrom } from "./NativeWorkerOutcome.ts";
import { retainRemoteWorkerOutcome } from "./RemoteWorkerOutcome.ts";
import { persisted, startup, worker } from "./nativeWorkerOutcomeFixture.ts";
const database = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | RemoteWorkerStore | WorkerPullRequestStore>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(remoteLayer, prLayer).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))));
const pr: ChangeRequest = {
  provider: "github", number: persisted.prNumber, title: "One PR", url: persisted.prUrl,
  headRefName: startup.branch, baseRefName: "main", headCommitOid: persisted.headOid,
  state: "merged", updatedAt: Option.none(), isCrossRepository: false,
};
it.effect("retains the source receipt only after its real persisted startup and exact GitHub observation", () =>
  database(Effect.gen(function* () {
    yield* runMigrations();
    const remote = yield* RemoteWorkerStore;
    const store = yield* WorkerPullRequestStore;
    const outcome = yield* terminalReceiptFrom(persisted, startup);
    let candidates: ReadonlyArray<ChangeRequest> = [pr];
    const invoke = (payload: unknown) => retainRemoteWorkerOutcome(worker, payload).pipe(
      Effect.provideService(RemoteWorkerBroker, {
        read: (id) => remote.get("outbound", id).pipe(Effect.mapError(() => new RemoteWorkerDispatchError({ reason: "source-unavailable" }))),
      } as RemoteWorkerBroker["Service"]),
      Effect.provideService(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed({ threads: [{
          id: worker.parent.threadId, projectId: worker.project.id, deletedAt: null, archivedAt: null,
        }], projects: [{ id: worker.project.id, deletedAt: null, workspaceRoot: "/source/repo" }] }),
      } as unknown as ProjectionSnapshotQuery["Service"]),
      Effect.provideService(SourceControlProviderRegistry, {
        resolve: () => Effect.succeed({
          kind: "github", listChangeRequests: () => Effect.succeed(candidates),
        }),
      } as unknown as SourceControlProviderRegistry["Service"]),
    );
    assert.equal((yield* invoke({ outcome }).pipe(Effect.result))._tag, "Failure");
    assert.isTrue(Option.isNone(yield* store.get(worker.requestId)));
    yield* remote.put("outbound", worker);
    yield* remote.complete("outbound", { requestId: worker.requestId, outcome: { status: "dispatched", result: startup } });
    for (const wrong of [
      { ...pr, state: "open" as const }, { ...pr, headCommitOid: "b".repeat(40) },
      { ...pr, isCrossRepository: true }, { ...pr, number: 8 }, { ...pr, headRefName: "foreign" },
    ]) {
      candidates = [wrong];
      assert.equal((yield* invoke({ outcome }).pipe(Effect.result))._tag, "Failure");
      assert.isTrue(Option.isNone(yield* store.get(worker.requestId)));
    }
    candidates = [pr];
    yield* invoke({ outcome });
    const receipt = Option.getOrThrow(yield* store.get(worker.requestId));
    assert.deepEqual(receipt, persisted);
    yield* invoke({ outcome });
    assert.deepEqual(Option.getOrThrow(yield* store.get(worker.requestId)), receipt);
    assert.equal((yield* invoke({ outcome: { ...outcome, computer_id: "foreign" } }).pipe(Effect.result))._tag, "Failure");
    assert.equal((yield* invoke({ outcome: { ...outcome, execution_stopped: false } }).pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(Option.getOrThrow(yield* store.get(worker.requestId)), receipt);
  })));
