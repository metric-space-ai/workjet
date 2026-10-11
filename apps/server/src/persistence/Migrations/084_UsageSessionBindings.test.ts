import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect(
  "upgrades an autonomy database through 084, preserves decisions and retains session identities",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(migrationManifest.slice(-4), [
        [81, "WorkerSourceCustody"],
        [82, "WorkerAutonomyDefaults"],
        [83, "WorkerSupervisorDecisions"],
        [84, "UsageSessionBindings"],
      ]);
      yield* runMigrations({ toMigrationInclusive: 83 });
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_session_bindings'`,
        [],
      );
      yield* sql`INSERT INTO workjet_worker_supervisor_decisions
      (decision_id, worker_thread_id, project_id, request_id, kind, request_json, created_at)
      VALUES ('retained-decision', 'worker', 'project', 'request', 'approval', '{}', '2026-10-11T00:00:00Z')`;
      yield* sql`INSERT INTO provider_session_runtime
      (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json)
      VALUES ('worker', 'claudeAgent', 'claudeAgent', 'idle', '2026-10-11T00:00:00Z', '{"resume":"session-one"}')`;
      yield* sql`INSERT INTO projection_thread_sessions
      (thread_id, status, provider_name, provider_session_id, updated_at)
      VALUES ('worker', 'idle', 'claudeAgent', 'session-one', '2026-10-11T00:00:00Z')`;
      yield* sql`INSERT INTO projection_thread_sessions
      (thread_id, status, provider_name, provider_thread_id, updated_at)
      VALUES ('supervisor', 'idle', 'codex', 'session-two', '2026-10-11T00:00:00Z')`;
      assert.deepEqual(yield* runMigrations(), [[84, "UsageSessionBindings"]]);
      assert.deepEqual(
        yield* sql`SELECT thread_id, provider_name, session_id FROM usage_session_bindings ORDER BY thread_id`,
        [
          { thread_id: "supervisor", provider_name: "codex", session_id: "session-two" },
          { thread_id: "worker", provider_name: "claudeAgent", session_id: "session-one" },
        ],
      );
      // An outer UPSERT must not override the trigger's duplicate handling.
      yield* sql`INSERT INTO provider_session_runtime
      (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json)
      VALUES ('worker', 'claudeAgent', 'claudeAgent', 'idle', '2026-10-11T00:01:00Z', '{"resume":"session-one"}')
      ON CONFLICT(thread_id) DO UPDATE SET resume_cursor_json = excluded.resume_cursor_json`;
      yield* sql`UPDATE provider_session_runtime SET resume_cursor_json = '{"resume":"session-three"}' WHERE thread_id = 'worker'`;
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql`SELECT session_id FROM usage_session_bindings WHERE thread_id = 'worker' ORDER BY session_id`,
        [{ session_id: "session-one" }, { session_id: "session-three" }],
      );
      assert.deepEqual(
        yield* sql`SELECT decision_id, status FROM workjet_worker_supervisor_decisions`,
        [{ decision_id: "retained-decision", status: "pending" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
