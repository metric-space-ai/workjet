import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("migrates all project roles once, records old modes and retains later choices", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 81 });
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Autonomy', NULL, '[]', '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z')`;
    for (const [id, mode] of [
      ["supervisor", "approval-required"],
      ["specialist", "auto-accept-edits"],
      ["worker", "approval-required"],
      ["manual", "auto"],
      ["import", "auto-accept-edits"],
    ]) {
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
        VALUES (${id}, 'project', ${id}, '{}', ${mode}, '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z')`;
      yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES (${id}, 'thread', ${id}, 1, 'thread.created', '2026-10-11T00:00:00Z', 'user', ${(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ runtimeMode: mode }))}, '{}')`;
    }
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 82 }), [
      [82, "WorkerAutonomyDefaults"],
    ]);
    const threads = yield* sql`SELECT runtime_mode FROM projection_threads`;
    assert.equal(threads.length, 5);
    assert.ok(threads.every((row) => row.runtime_mode === "full-access"));
    const receipts =
      yield* sql`SELECT previous_runtime_mode FROM workjet_worker_autonomy_migration`;
    assert.equal(receipts.length, 5);
    assert.ok(receipts.some((row) => row.previous_runtime_mode === "approval-required"));
    const events =
      yield* sql`SELECT json_extract(payload_json, '$.runtimeMode') AS mode FROM orchestration_events`;
    assert.ok(events.every((row) => row.mode === "full-access"));
    yield* sql`UPDATE projection_threads SET runtime_mode = 'approval-required' WHERE thread_id = 'manual'`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 82 }), []);
    const manual =
      yield* sql`SELECT runtime_mode FROM projection_threads WHERE thread_id = 'manual'`;
    assert.equal(manual[0]?.runtime_mode, "approval-required");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
