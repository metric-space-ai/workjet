import { assert, it } from "@effect/vitest";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
  canCoordinateWorkjet,
  WorkjetThreadConfig,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { makeWorkerOrdinal } from "../../workjet/WorkerOrdinal.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("079 one-shot lifecycle", (it) => {
  it.effect("preserves submitted PR receipts and team authority without the old role switch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      yield* sql`INSERT INTO workjet_worker_pull_requests
      (thread_id, worktree_path, branch_ref, provider, pr_number, pr_url, head_oid, state)
      VALUES ('worker', '/owned/worker', 'workjet/worker/worker', 'github', 1, 'https://github.com/metric-space-ai/workjet/pull/1', 'head', 'open')`;
      const config = {
        ...DEFAULT_WORKJET_THREAD_CONFIG,
        role: "orchestrator",
        managedInstructions: "Retain policy.",
        team: {
          role: "supervisor",
          projectId: ProjectId.make("project"),
          threadId: ThreadId.make("supervisor"),
          parentThreadId: null,
          goal: "Retain goal.",
          createdAt: "2026-10-09T21:00:00.000Z",
        },
      } as const satisfies WorkjetThreadConfig;
      const codec = Schema.fromJsonString(WorkjetThreadConfig);
      const encoded = yield* Schema.encodeEffect(codec)(config);
      yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, created_at, updated_at, workjet_config_json)
      VALUES ('supervisor', 'project', 'Supervisor', '{}', 'now', 'now', ${encoded})`;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* sql`UPDATE workjet_worker_pull_requests SET execution_stopped = 1 WHERE thread_id = 'worker'`;
      const rows = yield* sql<{
        readonly state: string;
        readonly execution_stopped: number;
      }>`SELECT state, execution_stopped FROM workjet_worker_pull_requests`;
      assert.deepEqual(rows, [{ state: "open", execution_stopped: 1 }]);
      const stored = yield* sql<{
        readonly config: string;
      }>`SELECT workjet_config_json AS config FROM projection_threads WHERE thread_id = 'supervisor'`;
      const migrated = yield* Schema.decodeUnknownEffect(codec)(stored[0]!.config);
      assert.deepEqual(migrated, { ...config, role: "standard" });
      assert.isTrue(canCoordinateWorkjet(migrated));
    }),
  );
  it.effect(
    "keeps numbers unique across concurrent starts, parent-local and stable after restart",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const reserve = yield* makeWorkerOrdinal;
        const parent = {
          environmentId: EnvironmentId.make("source"),
          threadId: ThreadId.make("parent"),
        };
        const ordinals = yield* Effect.all(
          ["worker-a", "worker-b", "worker-c"].map((id) => reserve(parent, ThreadId.make(id))),
          { concurrency: 2 },
        );
        assert.deepEqual([...ordinals].sort(), [1, 2, 3]);
        const afterRestart = yield* makeWorkerOrdinal;
        assert.equal(yield* afterRestart(parent, ThreadId.make("worker-a")), ordinals[0]);
        assert.equal(yield* afterRestart(parent, ThreadId.make("worker-d")), 4);
        assert.equal(
          yield* afterRestart(
            { ...parent, threadId: ThreadId.make("other-parent") },
            ThreadId.make("other-worker"),
          ),
          1,
        );
      }),
  );
});
