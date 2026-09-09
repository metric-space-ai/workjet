import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as Invocation from "../../McpInvocationContext.ts";
import { CtoxCrewToolkitRegistrationLive, isCtoxCrewToolVisible } from "./CtoxCrewTool.ts";
const base: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session",
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
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
it.effect(
  "registered Crew tools require the exact session grant and reject caller scope overrides",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      let plans = 0;
      let reports = 0;
      const scope: Invocation.McpInvocationScope = {
        ...base,
        ctoxCrewExecution: {
          threadId: base.threadId,
          providerInstanceId: base.providerInstanceId,
          attemptId: "attempt",
          refreshContext: () =>
            Effect.sync(() => {
              reads++;
              return {
                schema: "ctox.crew_context.v1" as const,
                command_id: "command",
                attempt_id: "attempt",
                task_id: "task",
                module_id: "ctox",
                member_id: "crew",
                member_name: "Crew",
                persona: "Persona",
                memory_block: "Knowledge",
                execution_plan: null,
                context_version: "v1",
              };
            }),
          updatePlan: (input) =>
            Effect.sync(() => {
              plans++;
              expect(input.steps).toEqual([{ label: "Work", status: "completed" }]);
              return {
                version: 1 as const,
                revision: 1,
                task_id: "task",
                command_id: "command",
                phase: "review",
                percent: 90,
                review: { status: "pending" },
              };
            }),
          report: (candidate) =>
            Effect.sync(() => {
              reports++;
              expect(candidate).toEqual({ reply: "Result" });
              return {
                accepted: true as const,
                attempt_id: "attempt",
                review_status: "pending" as const,
              };
            }),
        },
      };
      const server = yield* McpServer.McpServer;
      const call = (invocation: Invocation.McpInvocationScope, name: string, args: unknown) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(Invocation.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      expect(isCtoxCrewToolVisible(base)).toBe(false);
      expect(isCtoxCrewToolVisible(scope)).toBe(true);
      expect(
        (yield* call(scope, "business_os.get_crew_context", { attempt_id: "attempt" })).isError,
      ).toBe(false);
      expect(reads).toBe(1);
      for (const args of [
        { attempt_id: "other" },
        { attempt_id: "attempt", command_session: "override" },
      ]) {
        expect((yield* call(scope, "business_os.get_crew_context", args)).isError).toBe(true);
      }
      for (const deniedScope of [
        base,
        { ...scope, threadId: ThreadId.make("other") },
        { ...scope, providerInstanceId: ProviderInstanceId.make("claude") },
      ]) {
        expect(
          (yield* call(deniedScope, "business_os.get_crew_context", { attempt_id: "attempt" }))
            .isError,
        ).toBe(true);
      }
      expect(reads).toBe(1);
      expect(
        (yield* call(scope, "business_os.report_crew_execution", { reply: "Result" }))
          .structuredContent,
      ).toEqual({ accepted: true, attempt_id: "attempt", review_status: "pending" });
      for (const args of [
        { reply: "Result", error: "Error" },
        { reply: "Result", attempt_id: "other" },
      ]) {
        expect((yield* call(scope, "business_os.report_crew_execution", args)).isError).toBe(true);
      }
      expect(reports).toBe(1);
      expect(
        (yield* call(scope, "business_os.update_crew_plan", {
          steps: [{ label: "Work", status: "completed" }],
        })).structuredContent,
      ).toMatchObject({ percent: 90, review: { status: "pending" } });
      for (const args of [
        { steps: [] },
        { steps: [{ label: "Work", status: "approved" }] },
        { steps: [{ label: "Work", status: "completed" }], work_key: "other" },
      ]) {
        expect((yield* call(scope, "business_os.update_crew_plan", args)).isError).toBe(true);
      }
      expect(plans).toBe(1);
    }).pipe(
      Effect.provide(
        CtoxCrewToolkitRegistrationLive.pipe(Layer.provideMerge(McpServer.McpServer.layer)),
      ),
    ),
);
