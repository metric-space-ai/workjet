import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Session identities survive harness changes and runtime cleanup; token counts remain in UsageService. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE usage_session_bindings (
      thread_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, provider_name, session_id)
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO usage_session_bindings
    SELECT thread_id, provider_name,
      COALESCE(json_extract(CASE WHEN json_valid(resume_cursor_json) THEN resume_cursor_json ELSE NULL END, '$.resume'), json_extract(CASE WHEN json_valid(resume_cursor_json) THEN resume_cursor_json ELSE NULL END, '$.sessionId'), json_extract(CASE WHEN json_valid(resume_cursor_json) THEN resume_cursor_json ELSE NULL END, '$.threadId'),
        CASE WHEN json_type(CASE WHEN json_valid(resume_cursor_json) THEN resume_cursor_json ELSE NULL END) = 'text' THEN json_extract(CASE WHEN json_valid(resume_cursor_json) THEN resume_cursor_json ELSE NULL END, '$') END)
    FROM provider_session_runtime
    WHERE COALESCE(json_extract(CASE WHEN json_valid(resume_cursor_json) THEN resume_cursor_json ELSE NULL END, '$.resume'), json_extract(CASE WHEN json_valid(resume_cursor_json) THEN resume_cursor_json ELSE NULL END, '$.sessionId'), json_extract(CASE WHEN json_valid(resume_cursor_json) THEN resume_cursor_json ELSE NULL END, '$.threadId'),
        CASE WHEN json_type(CASE WHEN json_valid(resume_cursor_json) THEN resume_cursor_json ELSE NULL END) = 'text' THEN json_extract(CASE WHEN json_valid(resume_cursor_json) THEN resume_cursor_json ELSE NULL END, '$') END) IS NOT NULL
  `;
  yield* sql`
    INSERT OR IGNORE INTO usage_session_bindings
    SELECT thread_id, provider_name, COALESCE(provider_session_id, provider_thread_id)
    FROM projection_thread_sessions
    WHERE provider_name IS NOT NULL AND COALESCE(provider_session_id, provider_thread_id) IS NOT NULL
  `;
  yield* sql`
    CREATE TRIGGER usage_session_binding_insert AFTER INSERT ON provider_session_runtime
    BEGIN
      INSERT OR IGNORE INTO usage_session_bindings
      SELECT NEW.thread_id, NEW.provider_name,
        COALESCE(json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.resume'), json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.sessionId'), json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.threadId'),
          CASE WHEN json_type(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END) = 'text' THEN json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$') END)
      WHERE COALESCE(json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.resume'), json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.sessionId'), json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.threadId'),
          CASE WHEN json_type(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END) = 'text' THEN json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$') END) IS NOT NULL;
    END
  `;
  yield* sql`
    CREATE TRIGGER usage_session_binding_update AFTER UPDATE ON provider_session_runtime
    BEGIN
      INSERT OR IGNORE INTO usage_session_bindings
      SELECT NEW.thread_id, NEW.provider_name,
        COALESCE(json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.resume'), json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.sessionId'), json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.threadId'),
          CASE WHEN json_type(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END) = 'text' THEN json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$') END)
      WHERE COALESCE(json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.resume'), json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.sessionId'), json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$.threadId'),
          CASE WHEN json_type(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END) = 'text' THEN json_extract(CASE WHEN json_valid(NEW.resume_cursor_json) THEN NEW.resume_cursor_json ELSE NULL END, '$') END) IS NOT NULL;
    END
  `;
});
