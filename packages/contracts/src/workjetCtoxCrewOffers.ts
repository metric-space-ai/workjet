import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const WorkjetCtoxCrewOffers = Schema.Struct({
  schema: Schema.Literal("ctox.external_crew_executions.v1"),
  command_id: Id,
  executor_id: Id,
  offers: Schema.Array(
    Schema.Struct({
      attempt_id: Id,
      harness: Schema.Literals(["codex", "claude", "opencode", "grok", "cursor"]),
      deadline_ms: Schema.Int.check(Schema.isGreaterThan(0)),
      state: Schema.Literals(["offered", "claimed", "reported"]),
    }),
  ).check(Schema.isMaxLength(100)),
});
