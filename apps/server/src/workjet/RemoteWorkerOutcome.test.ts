// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, it } from "@effect/vitest";
import { RemoteWorkerDispatchError, type ChangeRequest, type ThreadId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { RemoteWorkerStore, layer as remoteLayer } from "./RemoteWorkerStore.ts";
import { WorkerPullRequestStore, layer as prLayer, make as makePullRequestStore, type WorkerPullRequestReceipt } from "./WorkerPullRequestStore.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import { retainRemoteWorkerOutcome, refreshRemoteWorkerOutcome } from "./RemoteWorkerOutcome.ts";
import { persisted, startup, worker } from "./nativeWorkerOutcomeFixture.ts";
const database = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | RemoteWorkerStore | WorkerPullRequestStore>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(remoteLayer, prLayer).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))));
const pr: ChangeRequest = {
  provider: "github", number: persisted.prNumber, title: "One PR", url: persisted.prUrl,
  headRefName: startup.branch, baseRefName: "main", headCommitOid: persisted.headOid,
  state: "open", updatedAt: Option.none(), isCrossRepository: false,
};
const notice = { pullRequest: {
  provider: "github", number: pr.number, url: pr.url, branch: startup.branch,
}, headOid: persisted.headOid };
it.effect("persists stopped submission on source and observes merge after target archival and source restart", () =>
  database(Effect.gen(function* () {
    yield* runMigrations();
    const remote = yield* RemoteWorkerStore;
    const store = yield* WorkerPullRequestStore;
    let candidates: ReadonlyArray<ChangeRequest> = [pr];
    // The source snapshot has no target worker thread. Its archived target can be offline.
    const query = {
      getCommandReadModel: () => Effect.succeed({ threads: [{
        id: worker.parent.threadId, projectId: worker.project.id, deletedAt: null, archivedAt: null,
      }], projects: [{ id: worker.project.id, deletedAt: null, workspaceRoot: "/source/repo" }] }),
    } as unknown as ProjectionSnapshotQuery["Service"];
    const registry = {
      resolve: ({ cwd }: { cwd: string }) => {
        assert.equal(cwd, "/source/repo");
        return Effect.succeed({
          kind: "github", listChangeRequests: () => Effect.succeed(candidates),
        });
      },
    } as unknown as SourceControlProviderRegistry["Service"];
    const invoke = (payload: unknown) => retainRemoteWorkerOutcome(worker, payload).pipe(
      Effect.provideService(RemoteWorkerBroker, {
        read: (id: ThreadId) => remote.get("outbound", id).pipe(Effect.mapError(() => new RemoteWorkerDispatchError({ reason: "source-unavailable" }))),
      } as unknown as RemoteWorkerBroker["Service"]),
      Effect.provideService(ProjectionSnapshotQuery, query),
      Effect.provideService(SourceControlProviderRegistry, registry),
    );
    assert.equal((yield* invoke(notice).pipe(Effect.result))._tag, "Failure");
    assert.isTrue(Option.isNone(yield* store.get(worker.requestId)));
    yield* remote.put("outbound", worker);
    yield* remote.complete("outbound", { requestId: worker.requestId, outcome: { status: "dispatched", result: startup } });
    for (const wrong of [
      { ...pr, headCommitOid: "b".repeat(40) }, { ...pr, isCrossRepository: true },
      { ...pr, number: 8 }, { ...pr, headRefName: "foreign" },
    ]) {
      candidates = [wrong];
      assert.equal((yield* invoke(notice).pipe(Effect.result))._tag, "Failure");
      assert.isTrue(Option.isNone(yield* store.get(worker.requestId)));
    }
    candidates = [pr];
    yield* invoke(notice);
    const submission = Option.getOrThrow(yield* store.get(worker.requestId));
    assert.deepEqual(submission, { ...persisted, state: "open" });
    candidates = [{ ...pr, headCommitOid: "b".repeat(40) }];
    assert.equal((yield* invoke({ ...notice, headOid: "b".repeat(40) }).pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(Option.getOrThrow(yield* store.get(worker.requestId)), submission);
    candidates = [pr];
    yield* invoke(notice); // Lost source acknowledgement retries the same durable identity.
    assert.deepEqual(Option.getOrThrow(yield* store.get(worker.requestId)), submission);
    const restarted = yield* makePullRequestStore; // Fresh service uses the persisted database.
    const refresh = (receipt: WorkerPullRequestReceipt) =>
      refreshRemoteWorkerOutcome(receipt, startup, worker).pipe(
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(SourceControlProviderRegistry, registry),
        Effect.provideService(WorkerPullRequestStore, restarted),
      );
    candidates = [{ ...pr, state: "merged", headCommitOid: "b".repeat(40) }];
    assert.equal((yield* refresh(submission).pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(Option.getOrThrow(yield* store.get(worker.requestId)), submission);
    candidates = [{ ...pr, state: "merged" }];
    assert.deepEqual(yield* refresh(submission), persisted);
    assert.deepEqual(Option.getOrThrow(yield* store.get(worker.requestId)), persisted);
    assert.equal((yield* invoke({ ...notice, pullRequest: { ...notice.pullRequest, branch: "foreign" } }).pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(Option.getOrThrow(yield* store.get(worker.requestId)), persisted);
  })));
