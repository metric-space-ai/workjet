// @effect-diagnostics nodeBuiltinImport:off -- builds a throwaway state store on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

import { readServerActivity } from "./activity.ts";

const withStore = (
  setup: (db: NodeSqlite.DatabaseSync) => void,
  check: (dbPath: string) => void,
) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-activity-"));
  const dbPath = NodePath.join(dir, "state.sqlite");
  try {
    const db = new NodeSqlite.DatabaseSync(dbPath);
    setup(db);
    db.close();
    check(dbPath);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

const schema = (db: NodeSqlite.DatabaseSync) => {
  db.exec(`CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, active_turn_id TEXT);
    CREATE TABLE workjet_worker_runs (run_id TEXT PRIMARY KEY, terminal_at TEXT);
    CREATE TABLE workjet_remote_worker_receipts (direction TEXT, request_id TEXT, response_json TEXT)`);
};

describe("readServerActivity", () => {
  it("is idle without a store and with only settled sessions and finished runs", () => {
    expect(readServerActivity("/nonexistent/workjet/state.sqlite").idle).toBe(true);
    withStore(
      (db) => {
        schema(db);
        db.exec(`INSERT INTO projection_thread_sessions VALUES ('t1', 'ready', NULL), ('t2', 'stopped', NULL);
          INSERT INTO workjet_worker_runs VALUES ('r1', '2026-10-16T00:00:00Z');
          INSERT INTO workjet_remote_worker_receipts VALUES ('inbound', 'q1', '{}')`);
      },
      (dbPath) =>
        expect(readServerActivity(dbPath)).toEqual({
          idle: true,
          activeSessions: 0,
          openWorkerRuns: 0,
          pendingRemoteWorkerRequests: 0,
        }),
    );
  });

  it("is busy while a turn runs, a worker run is open or an inbound request is unanswered", () => {
    withStore(
      (db) => {
        schema(db);
        db.exec(`INSERT INTO projection_thread_sessions VALUES ('t1', 'running', 'turn-1'), ('t2', 'ready', NULL);
          INSERT INTO workjet_worker_runs VALUES ('r1', NULL);
          INSERT INTO workjet_remote_worker_receipts VALUES ('inbound', 'q1', NULL), ('outbound', 'q2', NULL)`);
      },
      (dbPath) =>
        expect(readServerActivity(dbPath)).toEqual({
          idle: false,
          activeSessions: 1,
          openWorkerRuns: 1,
          pendingRemoteWorkerRequests: 1,
        }),
    );
  });

  it("treats tables an older schema lacks as empty", () => {
    withStore(
      (db) =>
        db.exec(
          "CREATE TABLE projection_thread_sessions (thread_id TEXT, status TEXT, active_turn_id TEXT)",
        ),
      (dbPath) => expect(readServerActivity(dbPath).idle).toBe(true),
    );
  });
});
