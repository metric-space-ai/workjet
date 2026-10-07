// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  ThreadId,
  retainWorkjetWorkerPullRequest,
  type OrchestrationThread,
} from "@workjet/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  WorkerPullRequestStore,
  layer,
  make,
  receiptMatchesThread,
} from "./WorkerPullRequestStore.ts";

const threadId = ThreadId.make("leaf-a");
const observation = {
  threadId,
  worktreePath: "/safe/worktrees/leaf-a",
  branchRef: "workjet/worker/leaf-a",
  provider: "github" as const,
  prNumber: 7,
  prUrl: "https://github.com/owner/repo/pull/7",
  headOid: "a".repeat(40),
  state: "open" as const,
};
const pr = {
  provider: observation.provider,
  number: 7,
  url: observation.prUrl,
  branch: observation.branchRef,
};
const config = {
  schemaVersion: 2,
  role: "worker",
  parent: { environmentId: "local", threadId: "parent" },
  managedInstructions: "",
  enabledCapabilityIds: [],
  capabilityBindings: [],
  ctoxSession: null,
  pullRequest: pr,
} as const;
const database = <A, E>(
  effect: Effect.Effect<A, E, WorkerPullRequestStore | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))));

describe("native worker PR receipts", () => {
  it.effect("binds one PR, survives reconstruction and never reopens a terminal run", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const store = yield* WorkerPullRequestStore;
        assert.equal(yield* store.observe(observation), true);
        assert.equal(yield* store.observe({ ...observation, prNumber: 8 }), false);
        assert.equal(yield* store.observe({ ...observation, worktreePath: "/foreign" }), false);
        yield* store.markExecutionStopped(threadId);
        assert.equal(Option.getOrThrow(yield* store.get(threadId)).executionStopped, 0);
        assert.equal(yield* store.observe({ ...observation, state: "closed" }), true);
        assert.equal(yield* store.observe(observation), false);
        assert.equal(yield* store.observe({ ...observation, state: "merged" }), false);
        yield* store.markExecutionStopped(threadId);
        const row = Option.getOrThrow(yield* store.get(threadId));
        assert.equal(row.state, "closed");
        assert.equal(row.executionStopped, 1);
        // The stored receipt, not a renderer config, is reconstructed by another native service.
        const reconstructed = yield* make;
        assert.deepEqual(Option.getOrThrow(yield* reconstructed.get(threadId)), row);
      }),
    ),
  );
  it("requires the exact native checkout, ref and projected PR to archive", () => {
    const thread = {
      id: threadId,
      worktreePath: observation.worktreePath,
      branch: observation.branchRef,
      workjetConfig: config,
    } as unknown as OrchestrationThread;
    const receipt = { ...observation, state: "closed" as const, executionStopped: 1 };
    assert.equal(receiptMatchesThread(receipt, thread), true);
    assert.equal(receiptMatchesThread({ ...receipt, branchRef: "foreign" }, thread), false);
    assert.equal(
      receiptMatchesThread({ ...receipt, prUrl: "https://github.com/owner/repo/pull/8" }, thread),
      false,
    );
    assert.equal(receiptMatchesThread(receipt, { ...thread, worktreePath: "/foreign" }), false);
  });
  it("retains the original PR through unrelated config changes and rejects another PR", () => {
    const previous = config as unknown as OrchestrationThread["workjetConfig"];
    const omitted = {
      ...config,
      pullRequest: undefined,
      managedInstructions: "Updated",
    } as unknown as OrchestrationThread["workjetConfig"];
    const retained = retainWorkjetWorkerPullRequest(previous, omitted);
    assert.equal(retained.error, null);
    assert.equal(
      retained.config.schemaVersion === 2 &&
        retained.config.role === "worker" &&
        retained.config.pullRequest?.number,
      7,
    );
    assert.notEqual(
      retainWorkjetWorkerPullRequest(previous, {
        ...config,
        pullRequest: { ...pr, number: 8 },
      } as unknown as OrchestrationThread["workjetConfig"]).error,
      null,
    );
  });
});
