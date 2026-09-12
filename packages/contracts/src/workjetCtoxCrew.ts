import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
/** Controller request; actor, instance, Crew identity and executor are native bindings. */
export const WorkjetCtoxCrewRequest = Schema.Struct({
  operation: Schema.Literal("start_crew_execution"),
  thread_id: Id.check(Schema.isPattern(/^workjet_private_/)),
  title: Id,
  instruction: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  harness: Schema.Literals(["codex", "claude", "opencode", "grok", "cursor"]),
  timeout_seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
  idempotency_key: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)),
});
export type WorkjetCtoxCrewRequest = typeof WorkjetCtoxCrewRequest.Type;

export const WorkjetCtoxCrewReceipt = Schema.Struct({
  schema: Schema.Literal("ctox.project_crew_request.v1"),
  command_id: Id,
  thread_id: Id,
  crew_member_id: Id,
  executor_id: Id,
  status: Id,
  task_id: Schema.NullOr(Id),
});
