import {
  EnvironmentId,
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

const threadId = ThreadId.make("persistent-parent");
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("goal-test"),
  threadId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "current-session",
  capabilities: new Set(),
  workjetRole: "standard",
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

it.effect(
  "registered goal tool rejects foreign scope, resume, stopped goals and stale reports",
  () =>
    Effect.gen(function* () {
      const commands: OrchestrationCommand[] = [];
      let goal = initialWorkerGoal("Verify the approved outcome.", "2026-10-09T21:00:00.000Z");
      let role = "specialist";
      let archivedAt: string | null = null;
      let stopDuringDispatch = false;
      const query = {
        getThreadShellById: (requested: ThreadId) =>
          Effect.sync(() => {
            expect(requested).toBe(threadId);
            return Option.some({
              id: threadId,
              deletedAt: null,
              archivedAt,
              workjetConfig: { schemaVersion: 2, team: { role }, goal },
            } as unknown as OrchestrationThreadShell);
          }),
      } as unknown as ProjectionSnapshotQuery["Service"];
      const engine = {
        dispatch: (command: OrchestrationCommand) =>
          Effect.gen(function* () {
            if (command.type !== "thread.goal.set") return yield* Effect.die("unexpected command");
            if (stopDuringDispatch)
              goal = { ...goal, status: "paused", revision: goal.revision + 1 };
            if (command.expectedRevision !== goal.revision)
              return yield* new McpSchema.InvalidParams({
                message: "Owner stopped the goal before this report.",
              });
            commands.push(command);
            return { sequence: 1 };
          }),
      } as unknown as OrchestrationEngineService["Service"];
      const registration = GoalToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const call = (args: Record<string, unknown>, invocation = scope) =>
          server
            .callTool({ name: "workjet_update_goal", arguments: args })
            .pipe(
              Effect.provideService(Invocation.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, client),
              Effect.provideService(ProjectionSnapshotQuery, query),
              Effect.provideService(OrchestrationEngineService, engine),
            );
        for (const args of [
          { status: "active", reason: "Resume without Owner authority" },
          { status: "complete", reason: " " },
          { status: "complete", reason: "Done", threadId: "foreign" },
          { status: "blocked", reason: "Missing decision", expectedRevision: 999 },
        ])
          expect((yield* call(args)).isError).toBe(true);
        expect(commands).toHaveLength(0);
        const denied = yield* call(
          { status: "complete", reason: "Verified" },
          { ...scope, workjetRole: undefined },
        ).pipe(Effect.result);
        expect(denied._tag === "Failure" || denied.success.isError).toBe(true);
        expect(
          (yield* call({
            status: "complete",
            reason: "Verified results in the retained artifact.",
          })).structuredContent,
        ).toEqual({ threadId, status: "complete", accepted: true });
        expect(commands[0]).toMatchObject({
          type: "thread.goal.set",
          threadId,
          expectedRevision: 0,
        });
        for (const status of ["paused", "blocked", "complete"] as const) {
          goal = { ...goal, status };
          expect((yield* call({ status: "complete", reason: "Late report" })).isError).toBe(true);
        }
        goal = { ...goal, status: "active" };
        role = "worker";
        expect((yield* call({ status: "complete", reason: "One-shot report" })).isError).toBe(true);
        role = "specialist";
        archivedAt = "2026-10-09T22:00:00.000Z";
        expect((yield* call({ status: "complete", reason: "Archived report" })).isError).toBe(true);
        archivedAt = null;
        stopDuringDispatch = true;
        expect((yield* call({ status: "complete", reason: "Racing Owner stop" })).isError).toBe(
          true,
        );
        expect(goal.status).toBe("paused");
        expect(commands).toHaveLength(1);
      }).pipe(Effect.provide(registration));
    }),
);
