import {
  WorkjetSupervisorJournal,
  WorkjetSupervisorExecutionPageRequest,
  CtoxWorkjetProjectControlResult,
  isWorkjetSupervisorReceiptForRequest,
  CommandId,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import {
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";
import type { WorkjetSupervisorJournalPort } from "./workjetSupervisorControl";

const decodeJournal = Schema.decodeUnknownSync(WorkjetSupervisorJournal, {
  onExcessProperty: "error",
});
const decodePageRequest = Schema.decodeUnknownSync(WorkjetSupervisorExecutionPageRequest, {
  onExcessProperty: "error",
});
const decodeObservation = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResult, {
  onExcessProperty: "error",
});

/** Read one bounded native event page over the authorized guest. Never submit from an observer. */
export async function readWorkjetSupervisorExecutionPage(
  saved: WorkjetSupervisorJournal,
  observationId: CommandId,
  journal: WorkjetSupervisorJournalPort,
  pageRequest: WorkjetSupervisorExecutionPageRequest = {},
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  decodeJournal(saved);
  decodePageRequest(pageRequest);
  if (!saved.turn || (pageRequest.cursor && !pageRequest.attempt_id)) {
    return { _tag: "failed", code: "invalid_input" };
  }
  const request = {
    action: "project.supervisor.turn.watch",
    commandId: observationId,
    projectId: saved.intent.projectId,
    threadId: saved.intent.threadId,
    targetCommandId: saved.turn.commandId,
    executionPage: pageRequest,
  } as const;
  let result: CtoxWorkjetProjectControlResult;
  try {
    result = decodeObservation(
      await requestWorkjetProjectControl(saved.intent.instanceId, request, port),
    );
  } catch {
    return { _tag: "failed", code: "guest_failed" };
  }
  if (result._tag !== "completed") return result;
  if (result.response.action === request.action && result.response.executionPage === undefined) {
    return { _tag: "failed", code: "unsupported" };
  }
  if (
    !isWorkjetSupervisorReceiptForRequest(request, result.response) ||
    result.response.action !== request.action
  ) {
    return { _tag: "failed", code: "guest_failed" };
  }
  await journal.save({ intent: saved.intent, turn: result.response.turn, submission: "confirmed" });
  return result;
}

/** Opt into native assistant chunks; an older reader may still return ordinary task history. */
export async function readWorkjetSupervisorPublicExecutionPage(
  saved: WorkjetSupervisorJournal,
  observationId: CommandId,
  journal: WorkjetSupervisorJournalPort,
  pageRequest: WorkjetSupervisorExecutionPageRequest = { include_public_text: true },
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  const result = await readWorkjetSupervisorExecutionPage(saved, observationId, journal, pageRequest, port);
  if (pageRequest.include_public_text !== true || result._tag !== "failed" ||
    !["unsupported", "guest_failed", "invalid_input"].includes(result.code)) return result;
  const { include_public_text: _optIn, ...legacy } = pageRequest;
  // This is only a second read of the same command and attempt, never another submit.
  return readWorkjetSupervisorExecutionPage(saved, CommandId.make(`${observationId}:legacy`), journal, legacy, port);
}
