import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/** A logical project can exist before any filesystem working copy is attached. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE projection_projects_logical (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT,
      ctox_registration_json TEXT,
      default_model_selection_json TEXT,
      default_thread_env_mode TEXT,
      favicon_path TEXT,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO projection_projects_logical (
      project_id, title, workspace_root, default_model_selection_json,
      default_thread_env_mode, favicon_path, scripts_json, created_at, updated_at, deleted_at
    )
    SELECT project_id, title, workspace_root, default_model_selection_json,
      default_thread_env_mode, favicon_path, scripts_json, created_at, updated_at, deleted_at
    FROM projection_projects
  `;
  yield* sql`DROP TABLE projection_projects`;
  yield* sql`ALTER TABLE projection_projects_logical RENAME TO projection_projects`;
  yield* sql`CREATE INDEX idx_projection_projects_updated_at ON projection_projects(updated_at)`;
  yield* sql`
    CREATE INDEX idx_projection_projects_workspace_root_deleted_at
    ON projection_projects(workspace_root, deleted_at)
  `;
});
