// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { ProviderRuntimeEvent } from "@workjet/contracts";
import type { WorkerRunProgress } from "./WorkerRunLedger.ts";

/** Selected configuration is not execution evidence. These facts come from the harness wire. */
export function workerRunProgressFromEvent(
  event: ProviderRuntimeEvent,
): WorkerRunProgress | undefined {
  if (event.type === "turn.started")
    return {
      runId: event.threadId,
      startedAt: event.createdAt,
      execution: {
        model: event.payload.model ?? null,
        harness: event.provider,
        providerRoute: event.providerInstanceId ?? null,
        reasoning: event.payload.effort ?? null,
      },
    };
  if (
    event.type === "content.delta" &&
    event.payload.streamKind === "assistant_text" &&
    event.payload.delta.length > 0
  )
    return { runId: event.threadId, firstOutputAt: event.createdAt };
  if (event.type === "session.exited" && event.payload.recoverable === false)
    return {
      runId: event.threadId,
      terminalAt: event.createdAt,
      abortClass: event.payload.exitKind === "error" ? "task" : "none",
    };
  return undefined;
}
