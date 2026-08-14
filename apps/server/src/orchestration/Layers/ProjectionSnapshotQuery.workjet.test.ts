import {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkjetThreadConfig,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const ACTIVE_THREAD_ID = ThreadId.make("thread-workjet-active");
const ARCHIVED_THREAD_ID = ThreadId.make("thread-workjet-archived");
const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const encodeWorkjetThreadConfig = Schema.encodeSync(Schema.fromJsonString(WorkjetThreadConfig));

const orchestratorConfig = {
  schemaVersion: 1,
  role: "orchestrator",
  parent: null,
  managedInstructions: "Coordinate snapshot work.",
  enabledCapabilityIds: ["greppy", "web-search"],
} as const satisfies WorkjetThreadConfig;

const workerConfig = {
  schemaVersion: 1,
  role: "worker",
  parent: {
    environmentId: EnvironmentId.make("environment-snapshot"),
    threadId: ACTIVE_THREAD_ID,
  },
  managedInstructions: "Implement snapshot work.",
  enabledCapabilityIds: ["web-search"],
} as const satisfies WorkjetThreadConfig;

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("ProjectionSnapshotQuery Workjet configuration", (it) => {
  it.effect("rehydrates persisted configurations through full and shell snapshot paths", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-workjet-snapshot',
          'Workjet snapshot project',
          '/tmp/workjet-snapshot-project',
          ${encodeModelSelection({
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          })},
          '[]',
          ${NOW},
          ${NOW},
          NULL
        )
      `;

      const insertThread = (input: {
        readonly threadId: ThreadId;
        readonly title: string;
        readonly workjetConfig: WorkjetThreadConfig;
        readonly archivedAt: string | null;
      }) =>
        sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            workjet_config_json,
            branch,
            worktree_path,
            latest_turn_id,
            created_at,
            updated_at,
            archived_at,
            deleted_at
          )
          VALUES (
            ${input.threadId},
            'project-workjet-snapshot',
            ${input.title},
            ${encodeModelSelection({
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
            })},
            'full-access',
            'default',
            ${encodeWorkjetThreadConfig(input.workjetConfig)},
            NULL,
            NULL,
            NULL,
            ${NOW},
            ${NOW},
            ${input.archivedAt},
            NULL
          )
        `;

      yield* insertThread({
        threadId: ACTIVE_THREAD_ID,
        title: "Active orchestrator",
        workjetConfig: orchestratorConfig,
        archivedAt: null,
      });
      yield* insertThread({
        threadId: ARCHIVED_THREAD_ID,
        title: "Archived worker",
        workjetConfig: workerConfig,
        archivedAt: "2026-08-14T00:00:01.000Z",
      });

      const snapshot = yield* snapshotQuery.getSnapshot();
      assert.deepEqual(
        snapshot.threads.find((thread) => thread.id === ACTIVE_THREAD_ID)?.workjetConfig,
        orchestratorConfig,
      );
      assert.deepEqual(
        snapshot.threads.find((thread) => thread.id === ARCHIVED_THREAD_ID)?.workjetConfig,
        workerConfig,
      );

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.deepEqual(
        commandReadModel.threads.find((thread) => thread.id === ACTIVE_THREAD_ID)?.workjetConfig,
        orchestratorConfig,
      );
      assert.deepEqual(
        commandReadModel.threads.find((thread) => thread.id === ARCHIVED_THREAD_ID)?.workjetConfig,
        workerConfig,
      );

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.workjetConfig),
        [orchestratorConfig],
      );

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.workjetConfig),
        [workerConfig],
      );

      const threadShell = yield* snapshotQuery.getThreadShellById(ACTIVE_THREAD_ID);
      assert.deepEqual(Option.getOrNull(threadShell)?.workjetConfig, orchestratorConfig);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ACTIVE_THREAD_ID);
      assert.deepEqual(Option.getOrNull(threadDetail)?.workjetConfig, orchestratorConfig);

      const threadDetailSnapshot = yield* snapshotQuery.getThreadDetailSnapshot(ACTIVE_THREAD_ID);
      assert.deepEqual(
        Option.getOrNull(threadDetailSnapshot)?.thread.workjetConfig,
        orchestratorConfig,
      );
    }),
  );

  it.effect("fails through the typed decode path for malformed stored configuration JSON", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_threads`;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          workjet_config_json,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-workjet-malformed',
          'project-workjet-snapshot',
          'Malformed Workjet configuration',
          ${encodeModelSelection({
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          })},
          'full-access',
          'default',
          '{"schemaVersion":1}',
          NULL,
          NULL,
          NULL,
          ${NOW},
          ${NOW},
          NULL,
          NULL
        )
      `;

      const error = yield* Effect.flip(
        snapshotQuery.getThreadShellById(ThreadId.make("thread-workjet-malformed")),
      );
      assert.equal(error._tag, "PersistenceDecodeError");
      assert.equal(
        error.operation,
        "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
      );
    }),
  );
});
