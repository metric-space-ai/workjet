import { EnvironmentId, ProviderInstanceId, ProjectId, ThreadId, type OrchestrationCommand, type OrchestrationThreadShell } from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as Invocation from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { initialWorkerGoal } from "../../../workjet/workerGoal.ts";
import { WorkerKanbanToolkitRegistrationLive } from "./WorkerKanbanTool.ts";

it.effect("registered mini-kanban is parent-owned and supervisor reads exclude foreign projects and leaves", () =>
  Effect.gen(function* () {
    const at = "2026-10-09T22:00:00.000Z";
    const parentId = ThreadId.make("parent");
    const supervisorId = ThreadId.make("supervisor");
    const projectId = ProjectId.make("project");
    let status = "active";
    let role = "specialist";
    const commands: OrchestrationCommand[] = [];
    const parent = () => ({ id: parentId, title: "Harness", projectId, archivedAt: null, deletedAt: null,
      workjetConfig: { schemaVersion: 2, team: { role, parentThreadId: supervisorId, goal: "Verify" },
        goal: { ...initialWorkerGoal("Verify", at), status } },
    } as unknown as OrchestrationThreadShell);
    const supervisor = { ...parent(), id: supervisorId,
      workjetConfig: { ...parent().workjetConfig, schemaVersion: 2, team: { role: "supervisor" } },
    } as unknown as OrchestrationThreadShell;
    const query = {
      getThreadShellById: (id: ThreadId) => Effect.sync(() => Option.some(id === supervisorId ? supervisor : parent())),
      getCommandReadModel: () => Effect.succeed({ threads: [
        parent(), { ...parent(), id: ThreadId.make("foreign"), projectId: ProjectId.make("foreign") },
        { ...parent(), id: ThreadId.make("archived"), archivedAt: at },
        { ...parent(), id: ThreadId.make("leaf"), workjetConfig: { schemaVersion: 2, team: { role: "worker" } } },
      ] }),
    } as unknown as ProjectionSnapshotQuery["Service"];
    const engine = { dispatch: (command: OrchestrationCommand) => Effect.sync(() => {
      commands.push(command); return { sequence: 1 };
    }) } as unknown as OrchestrationEngineService["Service"];
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (args: Record<string, unknown>, threadId = parentId) =>
        server.callTool({ name: "workjet_worker_kanban", arguments: args }).pipe(
          Effect.provideService(Invocation.McpInvocationContext, {
            environmentId: EnvironmentId.make("kanban-test"), threadId,
            providerInstanceId: ProviderInstanceId.make("codex"), providerSessionId: "session",
            capabilities: new Set(), workjetRole: "standard", issuedAt: 1,
          }),
          Effect.provideService(McpSchema.McpServerClient, McpSchema.McpServerClient.of({
            clientId: 1, protocolVersion: "2025-06-18",
            initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            getClient: Effect.die("unused"),
          })),
          Effect.provideService(ProjectionSnapshotQuery, query), Effect.provideService(OrchestrationEngineService, engine),
        );
      const update = { action: "update", cards: [{ id: "verify", title: "Verify the outcome", status: "doing" }] };
      expect((yield* call(update)).isError).toBe(false);
      expect(commands[0]).toMatchObject({ type: "thread.worker-kanban.set", threadId: parentId,
        kanban: { goalRevision: 0, iteration: 0, cards: update.cards } });
      for (const args of [ { ...update, threadId: "foreign" }, { ...update, projectId: "foreign" },
        { action: "update", cards: [{ id: "wrong", title: "Wrong", status: "invented" }] } ])
        expect((yield* call(args)).isError).toBe(true);
      expect((yield* call({ action: "project" })).isError).toBe(true);
      for (const nextRole of ["worker", "supervisor"]) {
        role = nextRole; expect((yield* call(update)).isError).toBe(true);
      }
      role = "specialist"; status = "paused";
      expect((yield* call(update)).isError).toBe(true);
      status = "active";
      const read = yield* call({ action: "project" }, supervisorId);
      expect(read.isError).toBe(false);
      expect(read.structuredContent).toMatchObject({ workers: [{ threadId: parentId }] });
      expect((read.structuredContent as { workers: unknown[] }).workers).toHaveLength(1);
      expect((yield* call(update, supervisorId)).isError).toBe(true);
      expect(commands).toHaveLength(1);
    }).pipe(Effect.provide(WorkerKanbanToolkitRegistrationLive.pipe(
      Layer.provideMerge(McpServer.McpServer.layer), Layer.provide(NodeServices.layer),
    )));
  }),
);
