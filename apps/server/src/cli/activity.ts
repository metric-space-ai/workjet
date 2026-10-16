// @effect-diagnostics nodeBuiltinImport:off -- reads the backend's state store read-only, without migrations, from a second process.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

export interface ServerActivity {
  readonly idle: boolean;
  /** Thread sessions starting or running a turn. */
  readonly activeSessions: number;
  /** Worker runs without a terminal time. */
  readonly openWorkerRuns: number;
  /** Inbound remote worker requests not yet answered. */
  readonly pendingRemoteWorkerRequests: number;
}

const ACTIVITY_QUERIES = {
  activeSessions: `SELECT COUNT(*) AS n FROM projection_thread_sessions
    WHERE status IN ('starting', 'running') OR active_turn_id IS NOT NULL`,
  openWorkerRuns: `SELECT COUNT(*) AS n FROM workjet_worker_runs WHERE terminal_at IS NULL`,
  pendingRemoteWorkerRequests: `SELECT COUNT(*) AS n FROM workjet_remote_worker_receipts
    WHERE direction = 'inbound' AND response_json IS NULL`,
} as const;

/**
 * Whether the backend that owns `dbPath` runs anything. A missing store is a
 * backend that never ran work; a table an older schema lacks counts as empty.
 * Any other failure throws, which the caller treats as busy.
 */
export function readServerActivity(dbPath: string): ServerActivity {
  if (!NodeFS.existsSync(dbPath))
    return { idle: true, activeSessions: 0, openWorkerRuns: 0, pendingRemoteWorkerRequests: 0 };
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    const count = (table: string, sql: string) =>
      tables.has(table) ? Number((db.prepare(sql).get() as { n: number }).n) : 0;
    const activeSessions = count("projection_thread_sessions", ACTIVITY_QUERIES.activeSessions);
    const openWorkerRuns = count("workjet_worker_runs", ACTIVITY_QUERIES.openWorkerRuns);
    const pendingRemoteWorkerRequests = count(
      "workjet_remote_worker_receipts",
      ACTIVITY_QUERIES.pendingRemoteWorkerRequests,
    );
    return {
      idle: activeSessions + openWorkerRuns + pendingRemoteWorkerRequests === 0,
      activeSessions,
      openWorkerRuns,
      pendingRemoteWorkerRequests,
    };
  } finally {
    db.close();
  }
}

/** `workjet __activity --base-dir DIR`: one JSON line; the SSH update waits while not idle. */
export const activityCommand = Command.make("__activity", {
  baseDir: Flag.string("base-dir"),
}).pipe(
  Command.withHidden,
  Command.withHandler(({ baseDir }) =>
    Effect.try(() => readServerActivity(NodePath.join(baseDir, "userdata", "state.sqlite"))).pipe(
      Effect.flatMap((activity) => Console.log(JSON.stringify(activity))),
      Effect.asVoid,
    ),
  ),
);
