import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationThread,
  ThreadId,
  WorkjetConnectionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SqliteClient from "../../persistence/NodeSqliteClient.ts";
import { DecisionHubConnectionRegistry } from "./DecisionHubConnectionRegistry.ts";
import { DecisionHubMcpClient } from "./DecisionHubMcpClient.ts";
import { decisionHubContinuationIds, makeDecisionHubReconciler } from "./DecisionHubReconciler.ts";

const connectionId = WorkjetConnectionId.make("connection-decision-hub-test");
const threadId = ThreadId.make("thread-decision-hub-test");
const decisionId = "decision-hub-test-1";
const resolutionVersion = 1_787_663_663_227;

const inactiveThread = {
  id: threadId,
  deletedAt: null,
  runtimeMode: "interactive",
  interactionMode: "chat",
  latestTurn: null,
  session: null,
} as unknown as OrchestrationThread;

const layer = it.layer(SqliteClient.layerMemory());

layer("DecisionHubReconciler", (it) => {
  it.effect("persists a resolution and starts exactly one deterministic continuation turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE workjet_decision_hub_escalations (
          decision_id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL,
          environment_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          decision_key TEXT NOT NULL,
          status TEXT NOT NULL,
          selected_option_id TEXT,
          comment TEXT,
          resolution_version INTEGER NOT NULL DEFAULT 0,
          next_poll_at_ms INTEGER NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          continuation_claimed_at_ms INTEGER,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO workjet_decision_hub_escalations (
          decision_id, connection_id, environment_id, thread_id, decision_key,
          status, next_poll_at_ms, created_at_ms, updated_at_ms
        ) VALUES (
          ${decisionId}, ${connectionId}, ${EnvironmentId.make("environment-test")},
          ${threadId}, 'blocking-choice', 'open', 0, 1, 1
        )
      `;

      const commands: Array<OrchestrationCommand> = [];
      const engine = {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape;
      const query = {
        getThreadDetailById: () => Effect.succeed(Option.some(inactiveThread)),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
      const registry = {
        resolveReadyTarget: () =>
          Effect.succeed({ endpoint: "http://127.0.0.1:8788/mcp", token: "test-token" }),
      } as unknown as DecisionHubConnectionRegistry["Service"];
      const client = {
        getDecision: () =>
          Effect.succeed({
            decisionId,
            status: "resolved" as const,
            selectedOptionId: "path-a",
            comment: "Owner chose the recommended path.",
            resolutionVersion,
          }),
      } as unknown as DecisionHubMcpClient["Service"];

      const reconciler = yield* makeDecisionHubReconciler.pipe(
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, query),
        Effect.provideService(DecisionHubConnectionRegistry, registry),
        Effect.provideService(DecisionHubMcpClient, client),
      );
      yield* reconciler.runOnce;
      yield* reconciler.runOnce;

      const rows = yield* sql<{
        readonly status: string;
        readonly selectedOptionId: string | null;
        readonly comment: string | null;
        readonly resolutionVersion: number;
        readonly continuationClaimedAtMs: number | null;
      }>`
        SELECT status, selected_option_id AS "selectedOptionId", comment,
               resolution_version AS "resolutionVersion",
               continuation_claimed_at_ms AS "continuationClaimedAtMs"
        FROM workjet_decision_hub_escalations
        WHERE decision_id = ${decisionId}
      `;
      assert.equal(rows[0]?.status, "resolved");
      assert.equal(rows[0]?.selectedOptionId, "path-a");
      assert.equal(rows[0]?.comment, "Owner chose the recommended path.");
      assert.equal(rows[0]?.resolutionVersion, resolutionVersion);
      assert.isNumber(rows[0]?.continuationClaimedAtMs);

      assert.deepEqual(
        commands.map(({ type }) => type),
        ["thread.activity.append", "thread.turn.start"],
      );
      const ids = decisionHubContinuationIds(decisionId, resolutionVersion);
      const activity = commands[0];
      assert.equal(activity?.type, "thread.activity.append");
      if (activity?.type === "thread.activity.append") {
        assert.equal(activity.commandId, ids.activityCommandId);
        assert.equal(activity.activity.id, ids.activityEventId);
        const payload = activity.activity.payload as {
          readonly hasComment?: boolean;
          readonly comment?: unknown;
        };
        assert.equal(payload.hasComment, true);
        assert.notProperty(payload, "comment");
      }
      const turn = commands[1];
      assert.equal(turn?.type, "thread.turn.start");
      if (turn?.type === "thread.turn.start") {
        assert.equal(turn.commandId, ids.turnCommandId);
        assert.equal(turn.message.messageId, ids.messageId);
        assert.include(turn.message.text, "Selected option: path-a.");
      }
    }),
  );
});
