import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  IsolatedWorkerWorktreeStore,
  layer,
  type IsolatedWorkerWorktreeIntent,
} from "./IsolatedWorkerWorktreeStore.ts";

const intent: IsolatedWorkerWorktreeIntent = {
  workerId: "worker-one",
  projectId: "project",
  repositoryKey: "github.com/owner/project",
  repositoryUrl: "https://github.com/owner/project.git",
  sourceCwd: "/source/project",
  revision: "a".repeat(40),
  branch: "workjet/worker/worker-one",
  destination: "/workers/one",
  authorityDigest: "b".repeat(64),
};
const custody = {
  kind: "isolated" as const,
  worktreePath: "/workers/.workjet-prepared-worker-one-stage",
  worktreeDev: "1",
  worktreeIno: "2",
  adminPath: "/workers/.workjet-prepared-worker-one-stage/.git",
  adminDev: "1",
  adminIno: "3",
};
const testLayer = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("keeps the original policy, source and destination reservation immutable", () =>
  Effect.gen(function* () {
    const store = yield* IsolatedWorkerWorktreeStore;
    assert.deepEqual(yield* store.reserve(intent), { intent, custody: null });
    for (const changed of [
      { ...intent, authorityDigest: "c".repeat(64) },
      { ...intent, sourceCwd: "/foreign/source" },
      { ...intent, destination: "/workers/foreign" },
      { ...intent, projectId: "foreign-project" },
      { ...intent, workerId: "worker-two" },
    ])
      assert.equal(
        (yield* Effect.flip(store.reserve(changed)))._tag,
        "IsolatedWorkerWorktreeError",
      );
    assert.deepEqual(yield* store.reserve(intent), { intent, custody: null });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a concurrent capture cannot replace the first inode identities", () =>
  Effect.gen(function* () {
    const store = yield* IsolatedWorkerWorktreeStore;
    yield* store.reserve(intent);
    const results = yield* Effect.forEach(
      [custody, { ...custody, worktreeIno: "foreign" }],
      (value) => Effect.result(store.capture(intent.workerId, value)),
      { concurrency: 2 },
    );
    assert.equal(results.filter((result) => result._tag === "Success").length, 1);
    const original = Option.getOrThrow(yield* store.get(intent.workerId));
    assert.ok(original.custody !== null);
    yield* store.capture(intent.workerId, original.custody);
    assert.equal(
      (yield* Effect.flip(store.capture("absent", custody)))._tag,
      "IsolatedWorkerWorktreeError",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("retains pre-publication custody after SQLite closes and reopens", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "isolated-worker-store-" });
    const runtime = () =>
      layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: path.join(root, "state.sqlite") })),
      );
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* IsolatedWorkerWorktreeStore;
      yield* store.reserve(intent);
      yield* store.capture(intent.workerId, custody);
    }).pipe(Effect.provide(runtime()));
    yield* Effect.gen(function* () {
      assert.deepEqual(yield* runMigrations(), []);
      const store = yield* IsolatedWorkerWorktreeStore;
      assert.deepEqual(Option.getOrThrow(yield* store.get(intent.workerId)), { intent, custody });
      yield* store.reserve(intent);
    }).pipe(Effect.provide(runtime()));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects corrupt or mismatched persisted receipts instead of inventing custody", () =>
  Effect.gen(function* () {
    const store = yield* IsolatedWorkerWorktreeStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.reserve(intent);
    yield* sql`UPDATE workjet_isolated_worker_worktrees SET intent_json = 'invalid JSON'`;
    assert.equal((yield* Effect.flip(store.get(intent.workerId)))._tag, "PersistenceSqlError");
  }).pipe(Effect.provide(testLayer)),
);
