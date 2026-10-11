// @effect-diagnostics nodeBuiltinImport:off -- Isolated profile and SQLite reopen fixtures never read installed app state.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  WorkerSourceCustodyStore,
  makeWorkerSourceCustodyPersistence,
  layer,
  type WorkerSourceCustodyIntent,
} from "./WorkerSourceCustodyStore.ts";
import { makeWorkerSourcePrivateProfile } from "./WorkerSourcePrivateProfile.ts";
import { workerSourceNativeProfile } from "./WorkerSourceNativeProfile.ts";

const intent: WorkerSourceCustodyIntent = {
  workerId: "source-worker",
  sourceEnvironmentId: "source",
  targetEnvironmentId: "target",
  requestDigest: "a".repeat(64),
  harness: "greppy",
  model: "gpt-6.1-sol",
  profileRoot: "/profiles/source-worker",
};
const profile = {
  root: { path: intent.profileRoot, identity: { device: "1", inode: "2" } },
  profile: {
    path: intent.profileRoot + "/profile-original",
    identity: { device: "1", inode: "3" },
  },
};
const runtime = {
  command: "/runtime/greppy",
  runtimeFiles: [{ path: "/runtime/greppy", identity: { device: "1", inode: "4" } }],
};
const memory = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect(
  "rejects a changed Source request, target, harness, model or profile root on recovery",
  () =>
    Effect.gen(function* () {
      const store = yield* WorkerSourceCustodyStore;
      assert.deepEqual(yield* store.reserve(intent), { intent, profile: null, runtime: null });
      for (const changed of [
        { ...intent, sourceEnvironmentId: "foreign" },
        { ...intent, targetEnvironmentId: "foreign" },
        { ...intent, requestDigest: "b".repeat(64) },
        { ...intent, harness: "pi-code" as const },
        { ...intent, model: "" },
        { ...intent, profileRoot: "/foreign/profile" },
        { ...intent, workerId: "foreign-worker" },
      ])
        assert.equal((yield* Effect.flip(store.reserve(changed)))._tag, "WorkerSourceCustodyError");
      assert.deepEqual(yield* store.reserve(intent), { intent, profile: null, runtime: null });
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "keeps the first profile and runtime identities immutable across concurrent capture",
  () =>
    Effect.gen(function* () {
      const store = yield* WorkerSourceCustodyStore;
      yield* store.reserve(intent);
      assert.equal(
        (yield* Effect.flip(store.captureRuntime(intent.workerId, runtime)))._tag,
        "WorkerSourceCustodyError",
      );
      const results = yield* Effect.forEach(
        [
          profile,
          {
            ...profile,
            profile: { ...profile.profile, identity: { device: "1", inode: "foreign" } },
          },
        ],
        (value) => Effect.result(store.captureProfile(intent.workerId, value)),
        { concurrency: 2 },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      const original = Option.getOrThrow(yield* store.get(intent.workerId));
      assert.ok(original.profile !== null);
      yield* store.captureProfile(intent.workerId, original.profile);
      yield* store.captureRuntime(intent.workerId, runtime);
      yield* store.captureRuntime(intent.workerId, runtime);
      assert.equal(
        (yield* Effect.flip(
          store.captureRuntime(intent.workerId, {
            ...runtime,
            runtimeFiles: [
              { ...runtime.runtimeFiles[0]!, identity: { device: "1", inode: "replaced" } },
            ],
          }),
        ))._tag,
        "WorkerSourceCustodyError",
      );
      assert.equal(
        (yield* Effect.flip(
          store.captureRuntime(intent.workerId, {
            ...runtime,
            runtimeFiles: [],
          }),
        ))._tag,
        "WorkerSourceCustodyError",
      );
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "reopens SQLite and the original private profile while retaining real session files",
  () =>
    Effect.gen(function* () {
      if (NodeProcess.platform !== "linux") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "source-custody-reopen-" });
      const savedIntent = {
        ...intent,
        harness: "minimax-code" as const,
        profileRoot: path.join(root, "profiles"),
      };
      const services = () =>
        layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: path.join(root, "state.sqlite") })),
        );
      const create = (key: string) => (directory: string) =>
        workerSourceNativeProfile({
          harness: savedIntent.harness,
          directory,
          model: savedIntent.model,
          baseUrl: "http://127.0.0.1:23197/v1",
          apiKey: key,
        });
      let originalDirectory = "";
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const store = yield* WorkerSourceCustodyStore;
        const receipt = yield* store.reserve(savedIntent);
        const persistence = yield* makeWorkerSourceCustodyPersistence(store, receipt);
        yield* Effect.promise(async () => {
          const prepared = await makeWorkerSourcePrivateProfile(
            savedIntent.profileRoot,
            create("first-scoped-key"),
            persistence.profile,
          );
          try {
            originalDirectory = prepared.profile.directory;
            await NodeFSP.writeFile(
              NodePath.join(originalDirectory, "sessions", "turn.json"),
              '{"turn":3}',
            );
            await NodeFSP.writeFile(
              NodePath.join(originalDirectory, "home", "goal-progress"),
              "step-three",
            );
          } finally {
            await prepared.close();
          }
        });
        yield* store.captureRuntime(savedIntent.workerId, runtime);
      }).pipe(Effect.provide(services()));
      yield* Effect.gen(function* () {
        assert.deepEqual(yield* runMigrations(), []);
        const store = yield* WorkerSourceCustodyStore;
        const receipt = yield* store.reserve(savedIntent);
        assert.deepEqual(receipt.runtime, runtime);
        const persistence = yield* makeWorkerSourceCustodyPersistence(store, receipt);
        yield* Effect.promise(async () => {
          const recovered = await makeWorkerSourcePrivateProfile(
            savedIntent.profileRoot,
            create("new-scoped-key"),
            persistence.profile,
          );
          try {
            assert.equal(recovered.profile.directory, originalDirectory);
            assert.equal(
              await NodeFSP.readFile(
                NodePath.join(originalDirectory, "sessions", "turn.json"),
                "utf8",
              ),
              '{"turn":3}',
            );
            assert.equal(
              await NodeFSP.readFile(
                NodePath.join(originalDirectory, "home", "goal-progress"),
                "utf8",
              ),
              "step-three",
            );
            const config = await NodeFSP.readFile(
              NodePath.join(originalDirectory, "config.yaml"),
              "utf8",
            );
            assert.ok(config.includes("new-scoped-key"));
            assert.ok(!config.includes("first-scoped-key"));
            await recovered.verify();
          } finally {
            await recovered.close();
          }
        });
      }).pipe(Effect.provide(services()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects corrupt persisted custody without inventing a replacement capture", () =>
  Effect.gen(function* () {
    const store = yield* WorkerSourceCustodyStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.reserve(intent);
    yield* store.captureProfile(intent.workerId, profile);
    yield* sql`UPDATE workjet_worker_source_custody SET profile_json = 'invalid JSON'`;
    assert.equal((yield* Effect.flip(store.get(intent.workerId)))._tag, "PersistenceSqlError");
  }).pipe(Effect.provide(memory)),
);
