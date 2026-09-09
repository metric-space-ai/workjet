import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CtoxNativeRequestError } from "./CtoxNativeRequests.ts";

export const CtoxCrewPlanInput = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
      status: Schema.Literals(["pending", "in_progress", "completed"]),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  explanation: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))),
});
export const CtoxCrewPlanReceipt = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Int,
  task_id: Schema.String,
  command_id: Schema.String,
  phase: Schema.String,
  percent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  review: Schema.Struct({ status: Schema.String }),
});
export const decodeCtoxCrewPlanInput = Effect.fn("decodeCtoxCrewPlanInput")(function* (
  value: unknown,
) {
  const input = yield* Schema.decodeUnknownEffect(CtoxCrewPlanInput, { onExcessProperty: "error" })(
    value,
  ).pipe(Effect.mapError(() => new CtoxNativeRequestError({ reason: "native-request-conflict" })));
  if (
    input.steps.some((step) => !step.label.trim()) ||
    new TextEncoder().encode(JSON.stringify(input)).byteLength > 64 * 1024
  )
    return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
  return input;
});
