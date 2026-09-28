import { describe, expect, it } from "@effect/vitest";
import { WorkjetConnectionId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  bindCtoxConnectionInstance,
  requireCtoxConnectionInstance,
} from "../../workjet/ctox/CtoxConnectionBinding.ts";

describe("059_WorkjetCtoxConnectionBindings", () => {
  it.effect(
    "pins existing connection identities and preserves them when connection rows are removed",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 58 });
        yield* sql`
        INSERT INTO workjet_decision_hub_connections
          (connection_id, instance_id, display_name, source, status, created_at_ms, updated_at_ms)
        VALUES ('existing', 'instance-a', 'A', 'ctox_dev', 'ready', 100, 200)
      `;
        yield* runMigrations({ toMigrationInclusive: 59 });
        const id = WorkjetConnectionId.make("existing");
        yield* requireCtoxConnectionInstance(id, "instance-a");
        yield* sql`DELETE FROM workjet_decision_hub_connections WHERE connection_id = 'existing'`;
        expect(yield* Effect.flip(bindCtoxConnectionInstance(id, "instance-b"))).toMatchObject({
          reason: "connection-instance-mismatch",
        });
        yield* bindCtoxConnectionInstance(id, "instance-a");
        const rows = yield* sql`SELECT * FROM workjet_ctox_connection_bindings`;
        expect(rows).toEqual([
          { connection_id: "existing", instance_id: "instance-a", created_at_ms: 100 },
        ]);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
