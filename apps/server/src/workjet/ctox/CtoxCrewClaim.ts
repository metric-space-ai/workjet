import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { CtoxNativeRequestError, type NativeTaskReference } from "./CtoxNativeRequests.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Text = Schema.String.check(Schema.isMaxLength(65_536));
export const CtoxCrewContext = Schema.Struct({
  schema: Schema.Literal("ctox.crew_context.v1"),
  command_id: Id,
  attempt_id: Id,
  task_id: Id,
  module_id: Id,
  member_id: Id,
  member_name: Id,
  persona: Text,
  memory_block: Schema.NullOr(Text),
  execution_plan: Schema.Unknown,
  context_version: Id,
});

const Claim = Schema.Struct({
  schema: Schema.Literal("ctox.external_crew_offer.v1"),
  attempt_id: Id,
  command_id: Id,
  executor_id: Id,
  harness: Id,
  deadline_ms: Schema.Int,
  command_session: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  prompt: Text,
  instructions: Text,
  crew_context: CtoxCrewContext,
});

/** Server-only claim: never serialize it into provider events or model tool results. */
export const decodeCtoxCrewClaim = Effect.fn("decodeCtoxCrewClaim")(function* (
  reference: NativeTaskReference,
  executorId: string,
  attemptId: string,
  nowMillis: number,
  value: unknown,
) {
  const claim = yield* Schema.decodeUnknownEffect(Claim)(value).pipe(
    Effect.mapError(() => new CtoxNativeRequestError({ reason: "native-response-invalid" })),
  );
  const context = claim.crew_context;
  if (
    reference.request.operation !== "start_crew_execution" ||
    !reference.commandId ||
    !reference.taskId ||
    claim.command_id !== reference.commandId ||
    claim.executor_id !== executorId ||
    claim.attempt_id !== attemptId ||
    claim.harness !== reference.request.harness ||
    context.command_id !== reference.commandId ||
    context.task_id !== reference.taskId ||
    context.attempt_id !== attemptId ||
    context.module_id !== "ctox" ||
    claim.deadline_ms <= nowMillis
  )
    return yield* new CtoxNativeRequestError({ reason: "native-response-invalid" });
  return {
    attemptId,
    commandId: claim.command_id,
    executorId,
    harness: claim.harness,
    deadlineMillis: claim.deadline_ms,
    commandSession: Redacted.make(claim.command_session),
    prompt: claim.prompt,
    instructions: claim.instructions,
    context,
  };
});

/** Refresh may change knowledge and plan, but never the admitted identity. */
export const decodeCtoxCrewContext = Effect.fn("decodeCtoxCrewContext")(function* (
  expected: Pick<
    typeof CtoxCrewContext.Type,
    "command_id" | "attempt_id" | "task_id" | "module_id" | "member_id"
  >,
  value: unknown,
) {
  const context = yield* Schema.decodeUnknownEffect(CtoxCrewContext)(value).pipe(
    Effect.mapError(() => new CtoxNativeRequestError({ reason: "native-response-invalid" })),
  );
  if (
    context.command_id !== expected.command_id ||
    context.attempt_id !== expected.attempt_id ||
    context.task_id !== expected.task_id ||
    context.module_id !== expected.module_id ||
    context.member_id !== expected.member_id
  )
    return yield* new CtoxNativeRequestError({ reason: "native-response-invalid" });
  return context;
});
