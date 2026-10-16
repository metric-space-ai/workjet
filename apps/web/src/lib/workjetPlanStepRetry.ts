import { useCallback, useState, useSyncExternalStore } from "react";
import { WorkjetPlanStepRetryResponse } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { newCommandId } from "./utils";
import {
  isCoreOutdatedFailure,
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
  type WorkjetProjectPoolPort,
} from "../workjetProjectControl";

/** Core business command of ctox#872; the payload carries only `step_id`. */
export const PLAN_STEP_RETRY_COMMAND = "ctox.plan.step.retry";

export type PlanStepRetryOutcome = "retried" | "unsupported" | "failed";

const decodeResponse = Schema.decodeUnknownSync(WorkjetPlanStepRetryResponse);

/**
 * Sends `ctox.plan.step.retry` with `{ step_id }`. An instance whose shell or
 * core does not know the command answers `unsupported` or `core_outdated`;
 * both become "unsupported", never an error line.
 */
export async function requestPlanStepRetry(
  instanceId: string,
  stepId: string,
  port?: WorkjetProjectControlPort,
  ensurePooled?: WorkjetProjectPoolPort,
): Promise<PlanStepRetryOutcome> {
  const commandId = newCommandId();
  try {
    const result = await requestWorkjetProjectControl(
      instanceId,
      { action: PLAN_STEP_RETRY_COMMAND, commandId, payload: { step_id: stepId } },
      port,
      ensurePooled,
    );
    if (result._tag === "failed")
      return result.code === "unsupported" || isCoreOutdatedFailure(result)
        ? "unsupported"
        : "failed";
    const response = decodeResponse(result.response);
    return response.commandId === commandId ? "retried" : "failed";
  } catch {
    return "failed";
  }
}

// Session-wide: an instance that does not know the command keeps the button hidden.
const unsupportedInstances = new Set<string>();
const retriedSteps = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
function publish() {
  version += 1;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const stepKey = (instanceId: string, stepId: string) => `${instanceId}\u0000${stepId}`;

/** Whether the retry button may show for this step. */
export function isPlanStepRetryAvailable(instanceId: string, stepId: string): boolean {
  return !unsupportedInstances.has(instanceId) && !retriedSteps.has(stepKey(instanceId, stepId));
}

/** Runs one retry and records an outcome that hides the button. */
export async function runPlanStepRetry(
  instanceId: string,
  stepId: string,
  port?: WorkjetProjectControlPort,
  ensurePooled?: WorkjetProjectPoolPort,
): Promise<PlanStepRetryOutcome> {
  const outcome = await requestPlanStepRetry(instanceId, stepId, port, ensurePooled);
  if (outcome === "unsupported") unsupportedInstances.add(instanceId);
  else if (outcome === "retried") retriedSteps.add(stepKey(instanceId, stepId));
  if (outcome !== "failed") publish();
  return outcome;
}

/**
 * The banner's retry action for a failed plan step, or undefined when no step
 * is known, the instance does not support the command, or it was retried.
 */
export function usePlanStepRetry(
  target: { readonly instanceId: string; readonly stepId: string } | null | undefined,
): (() => void) | undefined {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  const [busy, setBusy] = useState(false);
  const instanceId = target?.instanceId;
  const stepId = target?.stepId;
  const retry = useCallback(() => {
    if (instanceId === undefined || stepId === undefined || busy) return;
    setBusy(true);
    void runPlanStepRetry(instanceId, stepId).finally(() => setBusy(false));
  }, [instanceId, stepId, busy]);
  if (instanceId === undefined || stepId === undefined) return undefined;
  if (busy || !isPlanStepRetryAvailable(instanceId, stepId)) return undefined;
  return retry;
}
