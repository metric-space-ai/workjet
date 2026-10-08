// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkjetComputerId,
  type RemoteWorkerRequest,
  type RemoteWorkerResponse,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { RemoteWorkerStore, layer } from "./RemoteWorkerStore.ts";

const request = (id = "worker-one"): RemoteWorkerRequest => ({
  schemaVersion: 1,
  requestId: ThreadId.make(id),
  targetEnvironmentId: EnvironmentId.make("gpu3"),
  computerId: WorkjetComputerId.make("gpu3"),
  parent: { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("parent") },
  parentTeamRole: "supervisor",
  parentCapabilityIds: [],
  managedInstructions: "Create exactly one PR.",
  project: {
    id: ProjectId.make("project-one"),
    title: "Example project",
    repository: {
      canonicalKey: "github:example/project",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/project.git",
      },
    },
  },
  revision: "a".repeat(40),
  task: "Fix the issue.",
  title: "Issue repair",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  enabledCapabilityIds: [],
  createdAt: "2026-10-07T10:00:00.000Z",
  expiresAt: "2026-10-08T10:00:00.000Z",
});
const failure = (id = "worker-one"): RemoteWorkerResponse => ({
  requestId: ThreadId.make(id),
  outcome: { status: "failed", reason: "create-failed" },
});
const success = (prepared: RemoteWorkerRequest): RemoteWorkerResponse => ({
  requestId: prepared.requestId,
  outcome: {
    status: "dispatched",
    result: {
      schemaVersion: 1,
      status: "dispatched",
      environmentId: prepared.targetEnvironmentId,
      workerThreadId: prepared.requestId,
      computerId: prepared.computerId,
      branch: "codex/worker-one",
      worktreePath: "/isolated/worker-one",
      parent: prepared.parent,
      modelSelection: prepared.modelSelection,
      enabledCapabilityIds: prepared.enabledCapabilityIds,
    },
  },
});
const testLayer = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("replays the identical request and rejects changed payload without replacing it", () =>
  Effect.gen(function* () {
    const store = yield* RemoteWorkerStore;
    const prepared = request();
    yield* store.put("inbound", prepared);
    yield* store.put("inbound", {
      ...prepared,
      project: {
        repository: prepared.project.repository,
        title: prepared.project.title,
        id: prepared.project.id,
      },
    });
    const error = yield* Effect.flip(store.put("inbound", { ...prepared, task: "Different task" }));
    assert.ok(error._tag === "RemoteWorkerDispatchError");
    assert.equal(error.reason, "request-conflict");
    assert.deepEqual(Option.getOrThrow(yield* store.get("inbound", prepared.requestId)), {
      request: prepared,
      response: null,
      worktreePath: null,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps the first completion and path immutable while allowing exact replay", () =>
  Effect.gen(function* () {
    const store = yield* RemoteWorkerStore;
    const prepared = request();
    yield* store.put("inbound", prepared);
    yield* store.recordWorktree(prepared.requestId, "/isolated/worker-one");
    yield* store.recordWorktree(prepared.requestId, "/isolated/worker-one");
    const pathConflict = yield* Effect.flip(
      store.recordWorktree(prepared.requestId, "/isolated/other"),
    );
    assert.ok(pathConflict._tag === "RemoteWorkerDispatchError");
    assert.equal(pathConflict.reason, "request-conflict");
    yield* store.complete("inbound", success(prepared));
    yield* store.complete("inbound", success(prepared));
    const outcomeConflict = yield* Effect.flip(store.complete("inbound", failure()));
    assert.ok(outcomeConflict._tag === "RemoteWorkerDispatchError");
    assert.equal(outcomeConflict.reason, "request-conflict");
    assert.deepEqual(Option.getOrThrow(yield* store.get("inbound", prepared.requestId)), {
      request: prepared,
      response: success(prepared),
      worktreePath: "/isolated/worker-one",
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("isolates source and target receipts sharing the same request ID", () =>
  Effect.gen(function* () {
    const store = yield* RemoteWorkerStore;
    const prepared = request();
    const inbound = { ...prepared, task: "Target's distinct request" };
    yield* store.put("outbound", prepared);
    yield* store.put("inbound", inbound);
    yield* store.recordWorktree(prepared.requestId, "/isolated/worker-one");
    yield* store.complete("inbound", failure());
    assert.deepEqual(yield* store.pendingOutbound, [prepared]);
    assert.equal(
      Option.getOrThrow(yield* store.get("outbound", prepared.requestId)).worktreePath,
      null,
    );
    yield* store.complete("outbound", success(prepared));
    assert.deepEqual(yield* store.pendingOutbound, []);
    assert.deepEqual(
      Option.getOrThrow(yield* store.get("inbound", prepared.requestId)).response,
      failure(),
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not record an outcome or worktree before its inbound request exists", () =>
  Effect.gen(function* () {
    const store = yield* RemoteWorkerStore;
    yield* store.put("outbound", request());
    const missingCompletion = yield* Effect.flip(store.complete("inbound", failure()));
    assert.ok(missingCompletion._tag === "RemoteWorkerDispatchError");
    assert.equal(missingCompletion.reason, "invalid-request");
    const missingPath = yield* Effect.flip(
      store.recordWorktree("worker-one", "/isolated/worker-one"),
    );
    assert.ok(missingPath._tag === "RemoteWorkerDispatchError");
    assert.equal(missingPath.reason, "invalid-request");
    assert.ok(Option.isNone(yield* store.get("inbound", "worker-one")));
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "bounds pending reconnect work and preserves the first outcome under a completion race",
  () =>
    Effect.gen(function* () {
      const store = yield* RemoteWorkerStore;
      yield* Effect.forEach(
        Array.from({ length: 130 }, (_, index) =>
          request(`worker-${String(index).padStart(3, "0")}`),
        ),
        (prepared) => store.put("outbound", prepared),
      );
      const pending = yield* store.pendingOutbound;
      assert.equal(pending.length, 128);
      assert.equal(pending[0]?.requestId, "worker-000");
      const prepared = request("worker-000");
      const outcomes = yield* Effect.forEach(
        [failure("worker-000"), success(prepared)],
        (response) => Effect.result(store.complete("outbound", response)),
        { concurrency: 2 },
      );
      const stored = Option.getOrThrow(yield* store.get("outbound", prepared.requestId));
      assert.ok(stored.response !== null);
      assert.equal(outcomes.filter((outcome) => outcome._tag === "Success").length, 1);
      assert.equal((yield* store.pendingOutbound)[0]?.requestId, "worker-001");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "retains pending reconnect work and target recovery data after SQLite closes and reopens",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "remote-worker-receipts-" });
      const filename = path.join(directory, "state.sqlite");
      const runtime = () => layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));
      const prepared = request();
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const store = yield* RemoteWorkerStore;
        yield* store.put("outbound", prepared);
        yield* store.put("outbound", request("completed"));
        yield* store.complete("outbound", failure("completed"));
        yield* store.put("inbound", prepared);
        yield* store.recordWorktree(prepared.requestId, "/isolated/worker-one");
      }).pipe(Effect.provide(runtime()));
      yield* Effect.gen(function* () {
        const store = yield* RemoteWorkerStore;
        assert.deepEqual(yield* runMigrations(), []);
        assert.deepEqual(yield* store.pendingOutbound, [prepared]);

        assert.equal(
          Option.getOrThrow(yield* store.get("inbound", prepared.requestId)).worktreePath,
          "/isolated/worker-one",
        );
        yield* store.put("inbound", prepared);
        yield* store.complete("inbound", success(prepared));
      }).pipe(Effect.provide(runtime()));
      yield* Effect.gen(function* () {
        const store = yield* RemoteWorkerStore;
        assert.deepEqual(
          Option.getOrThrow(yield* store.get("inbound", prepared.requestId)).response,
          success(prepared),
        );
        assert.deepEqual(yield* store.pendingOutbound, [prepared]);
      }).pipe(Effect.provide(runtime()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed persistence error for corrupt stored JSON", () =>
  Effect.gen(function* () {
    const store = yield* RemoteWorkerStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.put("outbound", request());
    yield* sql`UPDATE workjet_remote_worker_receipts SET request_json = 'invalid JSON' WHERE request_id = 'worker-one'`;
    assert.equal(
      (yield* Effect.flip(store.get("outbound", "worker-one")))._tag,
      "PersistenceSqlError",
    );
    assert.equal((yield* Effect.flip(store.pendingOutbound))._tag, "PersistenceSqlError");
  }).pipe(Effect.provide(testLayer)),
);
