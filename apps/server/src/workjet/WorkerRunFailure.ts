// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  WorkjetGatewayInferenceError,
  WorkjetGatewayModelCheck,
  type RuntimeErrorClass,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import type { WorkerAbortClass } from "./WorkerRunLedger.ts";

/** Only typed protocol evidence is classified. Messages and stack traces are never inspected. */
export function workerAbortClass(input: {
  readonly runtimeClass?: RuntimeErrorClass | undefined;
  readonly detail?: unknown;
}): typeof WorkerAbortClass.Type {
  if (Schema.is(WorkjetGatewayModelCheck)(input.detail)) {
    const check = input.detail;
    if (check.unavailableReason === "timeout") return "timeout";
    if (check.unavailableReason === "transport") return "transport";
    switch (check.errorClass) {
      case "auth":
        return "auth";
      case "quota-rate-limit":
        return "quota";
      case "network-provider":
        return "transport";
      case "unknown-model":
        return "task";
      case "account-selection-unavailable":
        return "auth";
      case null:
        return check.status === "ok" ? "none" : "task";
    }
  }
  if (Schema.is(WorkjetGatewayInferenceError)(input.detail)) {
    switch (input.detail.reason) {
      case "binding-mismatch":
      case "grant-unavailable":
      case "native-admission-rejected":
        return "auth";
      case "native-admission-unavailable":
      case "gateway-unavailable":
        return "transport";
      case "invalid-request":
      case "inference-failed":
        return "task";
    }
  }
  switch (input.runtimeClass) {
    case "permission_error":
      return "auth";
    case "transport_error":
      return "transport";
    default:
      return "task";
  }
}
