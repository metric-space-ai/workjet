import {
  CommandId,
  WorkjetSupervisorTurnIntent,
  WorkjetSupervisorJournal,
  isWorkjetSupervisorReceiptForRequest,
  type CtoxWorkjetProjectControlRequest,
  type CtoxWorkjetProjectControlResult,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import {
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";

export interface WorkjetSupervisorJournalPort {
  /** Backed by the Code server's persisted thread state, never just localStorage. */
  readonly save: (journal: WorkjetSupervisorJournal) => Promise<void>;
}

const decodeIntent = Schema.decodeUnknownSync(WorkjetSupervisorTurnIntent, {
  onExcessProperty: "error",
});
const decodeJournal = Schema.decodeUnknownSync(WorkjetSupervisorJournal, {
  onExcessProperty: "error",
});

async function confirmedControl(
  intent: WorkjetSupervisorTurnIntent,
  request: CtoxWorkjetProjectControlRequest,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  const result = await requestWorkjetProjectControl(intent.instanceId, request, port);
  if (
    result._tag === "completed" &&
    !isWorkjetSupervisorReceiptForRequest(request, result.response)
  ) {
    return { _tag: "failed", code: "guest_failed" };
  }
  return result;
}

/** Save before dispatch. A lost response is resumed with the exact saved intent. */
export async function submitWorkjetSupervisorTurn(
  intent: WorkjetSupervisorTurnIntent,
  journal: WorkjetSupervisorJournalPort,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  decodeIntent(intent);
  return dispatchSavedSupervisorTurn({ intent, turn: null, submission: "prepared" }, journal, port);
}

async function dispatchSavedSupervisorTurn(
  saved: WorkjetSupervisorJournal,
  journal: WorkjetSupervisorJournalPort,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  const { intent } = saved;
  if (saved.submission === "not-submitted") return { _tag: "failed", code: saved.submissionError ?? "unsupported" };
  await journal.save(saved);
  if (saved.submission === "prepared") {
  const binding = await confirmedControl(
    intent,
    {
      action: "project.supervisor.bind",
      commandId: CommandId.make(`${intent.commandId}:bind`),
      projectId: intent.projectId,
      threadId: intent.threadId,
    },
    port,
  );
  if (binding._tag !== "completed") {
    await journal.save({ intent, turn: null, submission: "not-submitted", submissionError: binding.code });
    return binding;
  }
  }
  // Persist the uncertainty boundary before the first native submit can start.
  await journal.save({ intent, turn: null, submission: "awaiting-receipt" });
  const result = await confirmedControl(
    intent,
    {
      action: "project.supervisor.turn.submit",
      commandId: intent.commandId,
      projectId: intent.projectId,
      threadId: intent.threadId,
      goal: intent.goal,
    },
    port,
  );
  if (result._tag === "completed" && result.response.action === "project.supervisor.turn.submit") {
    await journal.save({ intent, turn: result.response.turn, submission: "confirmed" });
  }
  return result;
}

/** A watch has a fresh observation ID. It never creates a new execution command. */
export async function resumeWorkjetSupervisorTurn(
  saved: WorkjetSupervisorJournal,
  observationId: CommandId,
  journal: WorkjetSupervisorJournalPort,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  decodeJournal(saved);
  if (saved.turn === null) return dispatchSavedSupervisorTurn(saved, journal, port);
  const result = await confirmedControl(
    saved.intent,
    {
      action: "project.supervisor.turn.watch",
      commandId: observationId,
      projectId: saved.intent.projectId,
      threadId: saved.intent.threadId,
      targetCommandId: saved.turn.commandId,
    },
    port,
  );
  if (result._tag === "completed" && result.response.action === "project.supervisor.turn.watch") {
    await journal.save({ intent: saved.intent, turn: result.response.turn, submission: "confirmed" });
  }
  return result;
}
