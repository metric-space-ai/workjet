import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeCtoxCrewPlanInput } from "./CtoxCrewPlan.ts";
it.effect("bounds native plan bytes, steps and caller-controlled fields", () =>
  Effect.gen(function* () {
    const valid = { steps: [{ label: "Work", status: "completed" }] };
    expect(yield* decodeCtoxCrewPlanInput(valid)).toEqual(valid);
    for (const invalid of [
      { steps: [] },
      { steps: Array(101).fill(valid.steps[0]) },
      { steps: [{ label: " ", status: "pending" }] },
      { steps: [{ label: "😀".repeat(16_384), status: "pending" }] },
      { steps: [{ label: "Work", status: "approved" }] },
      { ...valid, attempt_id: "foreign" },
      { steps: [{ label: "Work", status: "pending", member_id: "other" }] },
    ])
      expect(yield* Effect.flip(decodeCtoxCrewPlanInput(invalid))).toMatchObject({
        reason: "native-request-conflict",
      });
  }),
);
