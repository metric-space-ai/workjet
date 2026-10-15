// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@workjet/contracts";
import { make as makePullRequests } from "./WorkerPullRequestStore.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { layer, make, WorkerRunLedger, type WorkerRunIdentity } from "./WorkerRunLedger.ts";

const identity: WorkerRunIdentity = {
  runId: "run-a",
  parent: { threadId: "parent", sessionId: null, model: null, harness: null },
  worker: { model: null, harness: null, providerRoute: null, reasoning: null },
  briefSha256: "a".repeat(64),
  taskType: "backend",
  difficulty: "standard",
  selection: "manual",
};
const at = "2026-10-13T09:00:00.000Z";
const database = <A, E>(effect: Effect.Effect<A, E, WorkerRunLedger | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))));

describe("WorkerRunLedger", () => {
  it.effect("retains identity and first milestones across replay and service reconstruction", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const ledger = yield* WorkerRunLedger;
        yield* ledger.queue(identity, at);
        yield* ledger.queue(identity, at);
        assert.equal(
          (yield* Effect.exit(ledger.queue({ ...identity, difficulty: "hard" }, at)))._tag,
          "Failure",
        );
        yield* ledger.observe({ runId: identity.runId, startedAt: at, firstOutputAt: at });
        yield* ledger.observe({ runId: identity.runId, terminalAt: at, abortClass: "quota" });
        yield* ledger.observe({
          runId: identity.runId,
          startedAt: "2026-10-13T09:01:00.000Z",
          terminalAt: "2026-10-13T09:02:00.000Z",
          abortClass: "task",
        });
        const rebuilt = yield* make;
        const saved = Option.getOrThrow(yield* rebuilt.get(identity.runId));
        assert.equal(saved.startedAt, at);
        assert.equal(saved.terminalAt, at);
        assert.equal(saved.abortClass, "quota");
        assert.equal(saved.parent.model, null);
        assert.equal((yield* rebuilt.list()).length, 1);
      }),
    ),
  );
  it.effect("reuses native PR custody without recording a caller completion claim", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const ledger = yield* WorkerRunLedger;
        yield* ledger.queue(identity, at);
        assert.equal(Option.getOrThrow(yield* ledger.get(identity.runId)).pullRequest, null);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO workjet_worker_pull_requests
      (thread_id, worktree_path, branch_ref, provider, pr_number, pr_url, head_oid, state)
      VALUES (${identity.runId}, '/isolated', 'workjet/worker/run-a', 'github', 7, 'https://github.com/owner/repo/pull/7', ${"b".repeat(40)}, 'open')`;
        const saved = Option.getOrThrow(yield* ledger.get(identity.runId));
        assert.equal(saved.pullRequest?.number, 7);
        assert.equal(saved.resultCommit, "b".repeat(40));
      }),
    ),
  );
});
it.effect("freezes structured failure at terminal exit and clears it on a successful restart", () =>
  database(
    Effect.gen(function* () {
      yield* runMigrations();
      const ledger = yield* WorkerRunLedger;
      yield* ledger.queue(identity, at);
      yield* ledger.observe({ runId: identity.runId, abortClass: "auth" });
      yield* ledger.observe({ runId: identity.runId, terminalAt: at, abortClass: "task" });
      assert.equal(Option.getOrThrow(yield* ledger.get(identity.runId)).abortClass, "auth");
      const second = { ...identity, runId: "run-b" };
      yield* ledger.queue(second, at);
      yield* ledger.observe({ runId: second.runId, abortClass: "transport" });
      yield* ledger.observe({ runId: second.runId, startedAt: at, abortClass: "none" });
      yield* ledger.observe({ runId: second.runId, terminalAt: at });
      assert.equal(Option.getOrThrow(yield* ledger.get(second.runId)).abortClass, "none");
    }),
  ),
);
it.effect("retains the worker delivery commit when a parent later repairs the same PR", () =>
  database(
    Effect.gen(function* () {
      yield* runMigrations();
      const ledger = yield* WorkerRunLedger;
      const pullRequests = yield* makePullRequests;
      yield* ledger.queue(identity, at);
      const delivery = {
        threadId: ThreadId.make(identity.runId),
        worktreePath: "/isolated",
        branchRef: "workjet/worker/run-a",
        provider: "github" as const,
        prNumber: 7,
        prUrl: "https://github.com/owner/repo/pull/7",
        headOid: "b".repeat(40),
        state: "open" as const,
      };
      assert.isTrue(yield* pullRequests.observe(delivery));
      assert.isTrue(
        yield* pullRequests.observe({ ...delivery, headOid: "c".repeat(40), state: "merged" }),
      );
      const saved = Option.getOrThrow(yield* ledger.get(identity.runId));
      assert.equal(saved.resultCommit, delivery.headOid);
      assert.equal(saved.pullRequest?.headOid, "c".repeat(40));
    }),
  ),
);
