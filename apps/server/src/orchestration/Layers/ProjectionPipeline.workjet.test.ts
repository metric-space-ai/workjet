import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkjetThreadConfig,
  type WorkjetThreadConfig as WorkjetThreadConfigType,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const UPDATED_AT = "2026-08-14T00:00:01.000Z";
const THREAD_ID = ThreadId.make("thread-workjet-persistence");

const orchestratorConfig = {
  schemaVersion: 1,
  role: "orchestrator",
  parent: null,
  managedInstructions: "Coordinate persisted work.",
  enabledCapabilityIds: ["greppy", "web-search"],
} as const satisfies WorkjetThreadConfigType;

const workerConfig = {
  schemaVersion: 1,
  role: "worker",
  parent: {
    environmentId: EnvironmentId.make("environment-workjet"),
    threadId: ThreadId.make("thread-workjet-parent"),
  },
  managedInstructions: "Implement the persisted slice.",
  enabledCapabilityIds: ["greppy"],
} as const satisfies WorkjetThreadConfigType;

const decodeStoredWorkjetConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(WorkjetThreadConfig),
);

const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-pipeline-workjet-test-" }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("OrchestrationProjectionPipeline Workjet configuration", (it) => {
  it.effect("persists creation, replacement, replay, and bootstrap configurations", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      const created = yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("event-workjet-created"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: NOW,
        commandId: CommandId.make("command-workjet-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-workjet-created"),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          projectId: ProjectId.make("project-workjet"),
          title: "Persisted Workjet thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "plan",
          workjetConfig: orchestratorConfig,
          branch: "workjet/config",
          worktreePath: "/tmp/workjet-config",
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      yield* pipeline.projectEvent(created);

      const readThreadRow = () =>
        sql<{
          readonly title: string;
          readonly runtimeMode: string;
          readonly interactionMode: string;
          readonly branch: string | null;
          readonly workjetConfigJson: string;
          readonly updatedAt: string;
        }>`
          SELECT
            title,
            runtime_mode AS "runtimeMode",
            interaction_mode AS "interactionMode",
            branch,
            workjet_config_json AS "workjetConfigJson",
            updated_at AS "updatedAt"
          FROM projection_threads
          WHERE thread_id = ${THREAD_ID}
        `;

      const createdRow = (yield* readThreadRow())[0];
      if (!createdRow) {
        return yield* Effect.die("Expected the created projection thread row.");
      }
      assert.deepEqual(decodeStoredWorkjetConfig(createdRow.workjetConfigJson), orchestratorConfig);

      const configSet = yield* eventStore.append({
        type: "thread.workjet-config-set",
        eventId: EventId.make("event-workjet-config-set"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: UPDATED_AT,
        commandId: CommandId.make("command-workjet-config-set"),
        causationEventId: null,
        correlationId: CommandId.make("command-workjet-config-set"),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          workjetConfig: workerConfig,
          updatedAt: UPDATED_AT,
        },
      });
      yield* pipeline.projectEvent(configSet);
      yield* pipeline.projectEvent(configSet);

      const replacedRow = (yield* readThreadRow())[0];
      if (!replacedRow) {
        return yield* Effect.die("Expected the replaced projection thread row.");
      }
      assert.deepEqual(decodeStoredWorkjetConfig(replacedRow.workjetConfigJson), workerConfig);
      assert.equal(replacedRow.title, "Persisted Workjet thread");
      assert.equal(replacedRow.runtimeMode, "full-access");
      assert.equal(replacedRow.interactionMode, "plan");
      assert.equal(replacedRow.branch, "workjet/config");
      assert.equal(replacedRow.updatedAt, UPDATED_AT);

      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${THREAD_ID}`;
      yield* sql`
        DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
      `;
      yield* pipeline.bootstrap;
      yield* pipeline.bootstrap;

      const bootstrappedRow = (yield* readThreadRow())[0];
      if (!bootstrappedRow) {
        return yield* Effect.die("Expected the bootstrapped projection thread row.");
      }
      assert.deepEqual(decodeStoredWorkjetConfig(bootstrappedRow.workjetConfigJson), workerConfig);
      assert.equal(bootstrappedRow.title, "Persisted Workjet thread");
      assert.equal(bootstrappedRow.runtimeMode, "full-access");
      assert.equal(bootstrappedRow.interactionMode, "plan");
      assert.equal(bootstrappedRow.branch, "workjet/config");
      assert.equal(bootstrappedRow.updatedAt, UPDATED_AT);
    }),
  );
});
