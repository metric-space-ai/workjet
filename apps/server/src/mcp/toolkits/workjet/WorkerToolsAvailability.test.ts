import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  type OrchestrationThreadShell,
  type OrchestrationCommand,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../../persistence/Migrations.ts";
import { WorkerAutonomyToolkitRegistrationLive } from "./WorkerAutonomyTool.ts";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as Invocation from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { initialWorkerGoal } from "../../../workjet/workerGoal.ts";
import { GoalToolkitRegistrationLive } from "./GoalTool.ts";
import { WorkerKanbanToolkitRegistrationLive } from "./WorkerKanbanTool.ts";

for (const harness of [
  "claudeAgent",
  "codex",
  "opencode",
  "grok",
  "pi",
  "cursor",
  "minimax",
  "greppy",
  "ctox",
] as const) {
  it.effect(
    `exposes callable kanban and goal tools in a ${harness} persistent turn without optional capabilities`,
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make(`persistent-${harness}`);
        const commands: OrchestrationCommand[] = [];
        const query = {
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                id: threadId,
                projectId: ProjectId.make("project"),
                runtimeMode: "full-access",
                interactionMode: "default",
                archivedAt: null,
                deletedAt: null,
                workjetConfig: {
                  schemaVersion: 2,
                  team: { role: "specialist" },
                  goal: initialWorkerGoal(
                    "Verify the assigned outcome",
                    "2026-10-11T00:00:00.000Z",
                  ),
                },
              } as unknown as OrchestrationThreadShell),
            ),
        } as unknown as ProjectionSnapshotQuery["Service"];
        const engine = {
          dispatch: (command: OrchestrationCommand) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: 1 };
            }),
        } as unknown as OrchestrationEngineService["Service"];
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const board = yield* server.callTool({
            name: "workjet_worker_kanban",
            arguments: {
              action: "update",
              cards: [{ id: "work", title: "Check the project", status: "doing" }],
            },
          });
          expect(board.isError).toBe(false);
          const goal = yield* server.callTool({
            name: "workjet_update_goal",
            arguments: {
              status: "complete",
              reason: "Verified through the project acceptance workflow.",
            },
          });
          expect(goal.isError).toBe(false);
          const escalation = yield* server.callTool({
            name: "workjet_escalate",
            arguments: { question: "Which authorised implementation?", options: ["A", "B"] },
          });
          expect(escalation.isError).toBe(false);
          expect(
            (yield* sql`SELECT supervisor_thread_id,request_json FROM workjet_worker_supervisor_decisions`)[0],
          ).toMatchObject({ supervisor_thread_id: null });
        }).pipe(
          Effect.provideService(Invocation.McpInvocationContext, {
            environmentId: EnvironmentId.make("isolated-tools"),
            threadId,
            providerInstanceId: ProviderInstanceId.make(harness),
            providerSessionId: "current-turn",
            workjetRole: "standard",
            projectTeamRole: "specialist",
            capabilities: new Set<Invocation.McpCapability>(),
            activeWorkjetMcpCapabilityIds: new Set<
              import("@workjet/contracts").WorkjetCapabilityId
            >(),
            issuedAt: 1,
          }),
          Effect.provideService(
            McpSchema.McpServerClient,
            McpSchema.McpServerClient.of({
              clientId: 1,
              protocolVersion: "2025-06-18",
              initializePayload: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: harness, version: "1" },
              },
              getClient: Effect.die("unused"),
            }),
          ),
          Effect.provideService(ProjectionSnapshotQuery, query),
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provide(
            Layer.mergeAll(
              GoalToolkitRegistrationLive,
              WorkerKanbanToolkitRegistrationLive,
              WorkerAutonomyToolkitRegistrationLive,
            ).pipe(
              Layer.provideMerge(McpServer.McpServer.layer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
        expect(commands.map((command) => command.type)).toEqual([
          "thread.worker-kanban.set",
          "thread.goal.set",
          "thread.activity.append",
        ]);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}
