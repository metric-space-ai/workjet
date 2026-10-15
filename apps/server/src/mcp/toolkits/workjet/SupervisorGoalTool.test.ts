import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@workjet/contracts";
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
import { GoalToolkitRegistrationLive } from "./GoalTool.ts";

it.effect("Supervisor assigns only its bound persistent worker and preserves stopped states", () =>
  Effect.gen(function* () {
    const supervisorId = ThreadId.make("supervisor");
    const parentId = ThreadId.make("parent");
    const projectId = ProjectId.make("project");
    const at = "2026-10-10T12:00:00Z";
    const thread = (
      id: ThreadId,
      role: "supervisor" | "specialist" | "worker",
      owner = supervisorId,
      project = projectId,
    ) =>
      ({
        id,
        projectId: project,
        deletedAt: null,
        archivedAt: null,
        workjetConfig: {
          schemaVersion: 2,
          team: { role, threadId: id, projectId: project, parentThreadId: owner },
        },
      }) as unknown as OrchestrationThreadShell;
    let supervisor = thread(supervisorId, "supervisor");
    let parent = thread(parentId, "specialist");
    const commands: OrchestrationCommand[] = [];
    const query = {
      getThreadShellById: (id: ThreadId) =>
        Effect.succeed(
          id === supervisorId
            ? Option.some(supervisor)
            : id === parentId
              ? Option.some(parent)
              : Option.none(),
        ),
    } as unknown as ProjectionSnapshotQuery["Service"];
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineService["Service"];
    const scope: Invocation.McpInvocationScope = {
      environmentId: EnvironmentId.make("test-environment"),
      threadId: supervisorId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: "current",
      capabilities: new Set(),
      workjetRole: "orchestrator",
      issuedAt: 1,
    };
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      protocolVersion: "2025-06-18",
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "goal-test", version: "1" },
      },
      getClient: Effect.die("unused"),
    });
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (args: Record<string, unknown>) =>
        server
          .callTool({ name: "workjet_update_goal", arguments: args })
          .pipe(
            Effect.provideService(Invocation.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.provideService(ProjectionSnapshotQuery, query),
            Effect.provideService(OrchestrationEngineService, engine),
          );
      const request = {
        action: "set",
        threadId: parentId,
        objective: " Verify the weekly outcome ",
      };
      expect((yield* call(request)).structuredContent).toEqual({
        threadId: parentId,
        status: "active",
        accepted: true,
      });
      expect(commands[0]).toMatchObject({
        type: "thread.goal.assign",
        supervisorThreadId: supervisorId,
        threadId: parentId,
        objective: "Verify the weekly outcome",
        status: "active",
      });
      if (parent.workjetConfig.schemaVersion !== 2) throw new Error("Invalid fixture config");
      parent = {
        ...parent,
        workjetConfig: {
          ...parent.workjetConfig,
          schemaVersion: 2,
          goal: { ...initialWorkerGoal("Old objective", at), status: "paused", revision: 4 },
        },
      };
      expect((yield* call({ ...request, expectedRevision: 4 })).structuredContent).toMatchObject({
        status: "paused",
      });
      expect(commands[1]).toMatchObject({
        type: "thread.goal.assign",
        status: "paused",
        expectedRevision: 4,
      });
      for (const args of [
        { ...request, expectedRevision: 3 },
        { ...request, objective: " " },
        { ...request, threadId: "foreign" },
        { ...request, status: "active" },
      ])
        expect((yield* call(args)).isError).toBe(true);
      for (const target of [
        thread(parentId, "specialist", ThreadId.make("other-supervisor")),
        thread(parentId, "specialist", supervisorId, ProjectId.make("foreign-project")),
        thread(parentId, "worker"),
        { ...thread(parentId, "specialist"), archivedAt: at },
        { ...thread(parentId, "specialist"), deletedAt: at },
      ]) {
        parent = target;
        expect((yield* call(request)).isError).toBe(true);
      }
      parent = thread(parentId, "specialist");
      supervisor = thread(supervisorId, "specialist");
      expect((yield* call(request)).isError).toBe(true);
      expect(commands).toHaveLength(2);
    }).pipe(
      Effect.provide(
        GoalToolkitRegistrationLive.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }),
);
