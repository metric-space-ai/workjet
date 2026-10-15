// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "@effect/vitest";
import { workerAbortClass } from "./WorkerRunFailure.ts";
import { startup } from "./nativeWorkerOutcomeFixture.ts";
const check = {
  accountId: "account-a",
  modelId: startup.modelSelection.model,
  status: "error",
  errorClass: null,
  checkedAtMs: 1,
  latencyMs: 1,
  httpStatus: null,
};
describe("structured worker failure classification", () => {
  it("retains every model-check failure class without parsing prose", () => {
    for (const [errorClass, expected] of [
      ["auth", "auth"],
      ["quota-rate-limit", "quota"],
      ["network-provider", "transport"],
      ["unknown-model", "task"],
    ] as const)
      expect(workerAbortClass({ detail: { ...check, errorClass } })).toBe(expected);
    expect(workerAbortClass({ detail: { ...check, unavailableReason: "timeout" } })).toBe(
      "timeout",
    );
    expect(workerAbortClass({ runtimeClass: "permission_error" })).toBe("auth");
    expect(workerAbortClass({ runtimeClass: "transport_error" })).toBe("transport");
  });
  it("never guesses a quota or authentication class from arbitrary messages", () => {
    expect(workerAbortClass({ detail: { message: "quota authentication timeout" } })).toBe("task");
    expect(workerAbortClass({ detail: { ...check, errorClass: "unknown-provider-class" } })).toBe(
      "task",
    );
  });
});
