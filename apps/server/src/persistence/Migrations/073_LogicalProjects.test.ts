import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
layer("073_LogicalProjects", (it) => {
  it.effect("preserves existing project fields and accepts a project without a working copy", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          default_thread_env_mode, favicon_path, scripts_json, created_at, updated_at, deleted_at
        ) VALUES ('existing', 'Existing', '/workspace/existing', NULL, 'worktree',
          '/icon.png', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL)
      `;
      const before = yield* sql`SELECT * FROM projection_projects WHERE project_id = 'existing'`;
      yield* runMigrations({ toMigrationInclusive: 73 });
      const after = yield* sql`SELECT * FROM projection_projects WHERE project_id = 'existing'`;
      assert.deepEqual(
        after,
        before.map((row) => ({ ...row, ctox_registration_json: null })),
      );
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('logical', 'Greppy', NULL, '[]',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
      `;
      const logical = yield* sql`
        SELECT workspace_root FROM projection_projects WHERE project_id = 'logical'
      `;
      assert.deepEqual(logical, [{ workspace_root: null }]);
      const repeated = yield* runMigrations({ toMigrationInclusive: 73 });
      assert.deepEqual(repeated, []);
    }),
  );
});
