import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, type OrchestrationThreadShell, type OrchestrationCommand } from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as Invocation from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { initialWorkerGoal } from "../../../workjet/workerGoal.ts";
import { GoalToolkitRegistrationLive } from "./GoalTool.ts";
import { WorkerKanbanToolkitRegistrationLive } from "./WorkerKanbanTool.ts";

for (const harness of ["claudeAgent", "codex", "opencode", "grok", "pi", "cursor", "minimax"] as const) {
  it.effect(`exposes callable kanban and goal tools in a ${harness} persistent turn without optional capabilities`, () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`persistent-${harness}`);
      const commands: OrchestrationCommand[] = [];
      const query = { getThreadShellById: () => Effect.succeed(Option.some({ id: threadId, archivedAt: null, deletedAt: null,
        workjetConfig: { schemaVersion: 2, team: { role: "specialist" }, goal: initialWorkerGoal("Verify the assigned outcome", "2026-10-11T00:00:00.000Z") },
      } as unknown as OrchestrationThreadShell)) } as unknown as ProjectionSnapshotQuery["Service"];
      const engine = { dispatch: (command: OrchestrationCommand) => Effect.sync(() => { commands.push(command); return { sequence: 1 }; }) } as unknown as OrchestrationEngineService["Service"];
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const board = yield* server.callTool({ name: "workjet_worker_kanban", arguments: { action: "update", cards: [{ id: "work", title: "Check the project", status: "doing" }] } });
        expect(board.isError).toBe(false);
        const goal = yield* server.callTool({ name: "workjet_update_goal", arguments: { status: "complete", reason: "Verified through the project acceptance workflow." } });
        expect(goal.isError).toBe(false);
      }).pipe(
        Effect.provideService(Invocation.McpInvocationContext, {
          environmentId: EnvironmentId.make("isolated-tools"), threadId, providerInstanceId: ProviderInstanceId.make(harness),
          providerSessionId: "current-turn", workjetRole: "standard", capabilities: new Set(), activeWorkjetMcpCapabilityIds: new Set(), issuedAt: 1,
        }),
        Effect.provideService(McpSchema.McpServerClient, McpSchema.McpServerClient.of({ clientId: 1, protocolVersion: "2025-06-18",
          initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: harness, version: "1" } }, getClient: Effect.die("unused"),
        })),
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(OrchestrationEngineService, engine),
        Effect.provide(Layer.mergeAll(GoalToolkitRegistrationLive, WorkerKanbanToolkitRegistrationLive).pipe(
          Layer.provideMerge(McpServer.McpServer.layer), Layer.provide(NodeServices.layer))),
      );
      expect(commands.map(command => command.type)).toEqual(["thread.worker-kanban.set", "thread.goal.set"]);
    }),
  );
}
