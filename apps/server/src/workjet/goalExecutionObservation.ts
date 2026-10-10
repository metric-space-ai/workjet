import type { ProviderRuntimeEvent, WorkjetGoalExecution } from "@workjet/contracts";
import { TrimmedNonEmptyString } from "@workjet/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeAssistantModel = Schema.decodeUnknownOption(
  Schema.Struct({ workjetAuthorModel: TrimmedNonEmptyString.check(Schema.isMaxLength(256)) }),
);

/** Selection, timestamps, summaries and card claims are never author evidence. */
export function goalExecutionObservation(
  event: ProviderRuntimeEvent,
  previous?: WorkjetGoalExecution,
): WorkjetGoalExecution | undefined {
  if (!event.turnId || !event.providerInstanceId) return undefined;
  const retained = previous?.turnId === event.turnId ? previous : undefined;
  let state: WorkjetGoalExecution["state"];
  let author = retained?.author ?? null;
  if (event.type === "turn.started") state = "running";
  else if (event.type === "turn.completed") state = event.payload.state;
  else if (
    event.type === "thread.metadata.updated" &&
    event.raw?.source === "claude.sdk.message" &&
    event.raw.method === "claude/assistant/model"
  ) {
    const decoded = decodeAssistantModel(event.payload.metadata);
    if (Option.isNone(decoded) || retained?.author?.model === decoded.value.workjetAuthorModel) return undefined;
    state = retained?.state ?? "running";
    author = {
      model: decoded.value.workjetAuthorModel,
      evidence: "assistant-response",
      sourceEventId: event.eventId,
    };
  } else return undefined;
  return {
    turnId: event.turnId,
    provider: event.provider,
    providerInstanceId: event.providerInstanceId,
    runtimeSource: event.raw?.source ?? null,
    state,
    sourceEventId: event.eventId,
    observedAt: event.createdAt,
    author,
  };
}
