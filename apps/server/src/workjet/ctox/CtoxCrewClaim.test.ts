import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { decodeCtoxCrewClaim } from "./CtoxCrewClaim.ts";
import type { NativeTaskReference } from "./CtoxNativeRequests.ts";

const reference: NativeTaskReference = {
  request: {
    operation: "start_crew_execution",
    thread_id: "workjet_private_chat",
    title: "Work",
    instruction: "Work",
    harness: "codex",
    timeout_seconds: 60,
    idempotency_key: "request",
  },
  instanceId: "instance",
  commandId: "command",
  taskId: "task",
  preparedAt: 1,
  receivedAt: 2,
};
const claim = {
  schema: "ctox.external_crew_offer.v1",
  attempt_id: "attempt",
  command_id: "command",
  executor_id: "computer",
  harness: "codex",
  deadline_ms: 200,
  command_session: "private-session-value",
  prompt: "Task",
  instructions: "Plan and report",
  crew_context: {
    schema: "ctox.crew_context.v1",
    command_id: "command",
    attempt_id: "attempt",
    task_id: "task",
    module_id: "ctox",
    member_id: "member",
    member_name: "Crew",
    persona: "Persona",
    memory_block: "Knowledge",
    execution_plan: null,
    context_version: "v1",
  },
};
it.effect("validates native claim binding and keeps its session redacted", () =>
  Effect.gen(function* () {
    const result = yield* decodeCtoxCrewClaim(reference, "computer", "attempt", 100, claim);
    expect(Redacted.value(result.commandSession)).toBe(claim.command_session);
    expect(JSON.stringify(result)).not.toContain(claim.command_session);
    expect(result.context.memory_block).toBe("Knowledge");
    const invalid = [
      { ...claim, command_id: "other" },
      { ...claim, executor_id: "other" },
      { ...claim, attempt_id: "other" },
      { ...claim, harness: "claude" },
      { ...claim, deadline_ms: 100 },
      { ...claim, command_session: "" },
      { ...claim, crew_context: { ...claim.crew_context, command_id: "other" } },
      { ...claim, crew_context: { ...claim.crew_context, task_id: "other" } },
      { ...claim, crew_context: { ...claim.crew_context, attempt_id: "other" } },
      { ...claim, crew_context: { ...claim.crew_context, module_id: "other" } },
    ];
    for (const response of invalid) {
      expect(
        yield* Effect.flip(decodeCtoxCrewClaim(reference, "computer", "attempt", 100, response)),
      ).toMatchObject({ reason: "native-response-invalid" });
    }
  }),
);
