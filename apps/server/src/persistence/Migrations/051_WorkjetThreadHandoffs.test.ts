import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
  rows.map((row) => row.name).sort();

const insertHandoff = (input: {
  readonly handoffId: string;
  readonly envelopeId: string;
  readonly acceptedThreadId?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO workjet_thread_handoffs (
        handoff_id,
        envelope_id,
        source_workspace_id,
        source_environment_id,
        source_thread_id,
        handoff_json,
        snapshot_digest,
        created_at_ms,
        expires_at_ms,
        received_at_ms,
        accepted_thread_id,
        accepted_at_ms
      ) VALUES (
        ${input.handoffId},
        ${input.envelopeId},
        ${"ctox:mesh-alpha"},
        ${"environment-a"},
        ${"thread-source"},
        ${"{}"},
        ${"a".repeat(64)},
        ${1},
        ${2},
        ${3},
        ${input.acceptedThreadId ?? null},
        ${input.acceptedThreadId === undefined ? null : 4}
      )
    `;
  });

layer("051_WorkjetThreadHandoffs", (it) => {
  it.effect("creates the received-handoff table only at migration 51", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 50 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workjet_thread_handoffs'
      `;
      assert.lengthOf(before, 0);

      yield* runMigrations({ toMigrationInclusive: 51 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(workjet_thread_handoffs)`;

      assert.deepEqual(columnNames(columns), [
        "accepted_at_ms",
        "accepted_thread_id",
        "created_at_ms",
        "envelope_id",
        "expires_at_ms",
        "handoff_id",
        "handoff_json",
        "received_at_ms",
        "snapshot_digest",
        "source_environment_id",
        "source_thread_id",
        "source_workspace_id",
      ]);

      // The sender-chosen handoff id is the primary key: that is what makes the
      // receiving upsert idempotent under at-least-once transport.
      const primaryKey = columns.filter((column) => column.pk === 1).map((column) => column.name);
      assert.deepEqual(primaryKey, ["handoff_id"]);

      // The acceptance columns are the only nullable ones: everything a handoff
      // arrives with is known at insert time, and acceptance is not.
      const nullable = columns
        .filter((column) => column.notnull === 0 && column.pk === 0)
        .map((column) => column.name)
        .sort();
      assert.deepEqual(nullable, ["accepted_at_ms", "accepted_thread_id"]);
    }),
  );

  it.effect("keeps a handoff, an envelope, and a continuing thread unique", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 51 });

      yield* insertHandoff({ handoffId: "hnd-1", envelopeId: "wjm-1" });

      // Same handoff id: the deduplication key of the receiving upsert.
      const duplicateHandoff = yield* insertHandoff({
        handoffId: "hnd-1",
        envelopeId: "wjm-2",
      }).pipe(Effect.result);
      assert.strictEqual(duplicateHandoff._tag, "Failure");

      // Two handoff ids may never claim one envelope.
      const duplicateEnvelope = yield* insertHandoff({
        handoffId: "hnd-2",
        envelopeId: "wjm-1",
      }).pipe(Effect.result);
      assert.strictEqual(duplicateEnvelope._tag, "Failure");

      // A thread continues AT MOST ONE handoff, enforced by the database and
      // not merely by request ordering.
      yield* insertHandoff({
        handoffId: "hnd-3",
        envelopeId: "wjm-3",
        acceptedThreadId: "thread-continued",
      });
      const duplicateThread = yield* insertHandoff({
        handoffId: "hnd-4",
        envelopeId: "wjm-4",
        acceptedThreadId: "thread-continued",
      }).pipe(Effect.result);
      assert.strictEqual(duplicateThread._tag, "Failure");
    }),
  );

  it.effect("leaves an unaccepted handoff's backlink NULL", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* insertHandoff({ handoffId: "hnd-9", envelopeId: "wjm-9" });

      const rows = yield* sql<{
        readonly acceptedThreadId: string | null;
        readonly acceptedAtMillis: number | null;
      }>`
        SELECT accepted_thread_id AS "acceptedThreadId", accepted_at_ms AS "acceptedAtMillis"
        FROM workjet_thread_handoffs
        WHERE handoff_id = ${"hnd-9"}
      `;
      assert.lengthOf(rows, 1);
      assert.isNull(rows[0]?.acceptedThreadId ?? null);
      assert.isNull(rows[0]?.acceptedAtMillis ?? null);
    }),
  );
});
