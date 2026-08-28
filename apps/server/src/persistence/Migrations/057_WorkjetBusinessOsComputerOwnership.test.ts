// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057_WorkjetBusinessOsComputerOwnership", (it) => {
  it.effect("creates the ownership table only at migration 57 without backfilling rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 56 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'workjet_business_os_computer_owners'
      `;
      assert.deepEqual([...before], []);

      yield* runMigrations({ toMigrationInclusive: 57 });
      const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
        PRAGMA table_info(workjet_business_os_computer_owners)
      `;
      assert.deepEqual(columns.map((column) => column.name).sort(), [
        "assigned_at_ms",
        "business_os_instance_id",
        "colocation_risk_accepted_at_ms",
        "colocation_risk_policy_version",
        "environment_id",
      ]);
      assert.deepEqual(
        columns.filter((column) => column.pk > 0).map((column) => column.name),
        ["environment_id"],
      );

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM workjet_business_os_computer_owners
      `;
      assert.equal(rows[0]?.count, 0);
    }),
  );

  it.effect("enforces one owner per environment and valid risk evidence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });

      yield* sql`
        INSERT INTO workjet_business_os_computer_owners (
          environment_id, business_os_instance_id, assigned_at_ms,
          colocation_risk_policy_version, colocation_risk_accepted_at_ms
        ) VALUES ('gpu-1', 'business-os-a', 10, NULL, NULL)
      `;

      const duplicate = yield* sql`
        INSERT INTO workjet_business_os_computer_owners (
          environment_id, business_os_instance_id, assigned_at_ms,
          colocation_risk_policy_version, colocation_risk_accepted_at_ms
        ) VALUES ('gpu-1', 'business-os-b', 20, NULL, NULL)
      `.pipe(Effect.result);
      assert.equal(duplicate._tag, "Failure");

      const incompleteRiskEvidence = yield* sql`
        INSERT INTO workjet_business_os_computer_owners (
          environment_id, business_os_instance_id, assigned_at_ms,
          colocation_risk_policy_version, colocation_risk_accepted_at_ms
        ) VALUES ('mac', 'business-os-a', 30, 1, NULL)
      `.pipe(Effect.result);
      assert.equal(incompleteRiskEvidence._tag, "Failure");

      const wrongPolicyVersion = yield* sql`
        INSERT INTO workjet_business_os_computer_owners (
          environment_id, business_os_instance_id, assigned_at_ms,
          colocation_risk_policy_version, colocation_risk_accepted_at_ms
        ) VALUES ('mac', 'business-os-a', 30, 2, 30)
      `.pipe(Effect.result);
      assert.equal(wrongPolicyVersion._tag, "Failure");
    }),
  );
});
