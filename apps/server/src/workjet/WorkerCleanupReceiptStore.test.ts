// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { ThreadId } from "@workjet/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { WorkerCleanupReceiptStore, layer } from "./WorkerCleanupReceiptStore.ts";

const evidence = {
  threadId: ThreadId.make("00000000-0000-4000-8000-00000000000a"),
  worktreePath: "/safe/worktrees/worker-a",
  branchRef: "workjet/worker/00000000-0000-4000-8000-00000000000a",
  mergedHeadOid: "a".repeat(40),
  mergedChangeRequestUrl: "https://example.test/pull/7",
};

const withDatabase = <A, E>(
  effect: Effect.Effect<A, E, WorkerCleanupReceiptStore | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))));

describe("WorkerCleanupReceiptStore", () => {
  it.effect("requires a recorded native removal before persisting completion", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* runMigrations();
        const store = yield* WorkerCleanupReceiptStore;
        assert.equal(yield* store.recordVerified(evidence), true);
        const verified = yield* store.get(evidence.threadId);
        assert.equal(Option.isSome(verified) && verified.value.status, "verified");
        assert.equal((yield* Effect.result(store.markComplete(evidence)))._tag, "Failure");
        yield* store.markRemoved(evidence);
        yield* store.markRemoved(evidence);
        const removed = yield* store.get(evidence.threadId);
        assert.equal(Option.isSome(removed) && removed.value.status, "removed");
        yield* store.markComplete(evidence);
        const complete = yield* store.get(evidence.threadId);
        assert.equal(Option.isSome(complete) && complete.value.status, "complete");
        assert.equal(yield* store.recordVerified(evidence), true);
      }),
    ),
  );

  it.effect("refuses to overwrite a different merged head", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* runMigrations();
        const store = yield* WorkerCleanupReceiptStore;
        assert.equal(yield* store.recordVerified(evidence), true);
        assert.equal(
          yield* store.recordVerified({ ...evidence, mergedHeadOid: "b".repeat(40) }),
          false,
        );
        const row = yield* store.get(evidence.threadId);
        assert.equal(Option.isSome(row) && row.value.mergedHeadOid, evidence.mergedHeadOid);
      }),
    ),
  );
});
