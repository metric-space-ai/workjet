import {
  CommandId,
  WorkjetSupervisorTurnIntent,
  WorkjetSupervisorJournal,
  isWorkjetSupervisorReceiptForRequest,
  type CtoxWorkjetProjectControlRequest,
  type CtoxWorkjetProjectControlResult,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { Effect, Random } from "effect";
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
  intent: Pick<WorkjetSupervisorTurnIntent, "instanceId">,
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

/** Set up the native supervisor without creating a message or an execution task. */
export function bindWorkjetSupervisor(
  scope: Pick<WorkjetSupervisorTurnIntent, "instanceId" | "projectId" | "threadId">,
  commandId: CommandId,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  return confirmedControl(
    scope,
    {
      action: "project.supervisor.bind",
      commandId,
      projectId: scope.projectId,
      threadId: scope.threadId,
    },
    port,
  );
}

/** Query the current native capability without creating a model turn. */
export function readWorkjetSupervisorTurnCapabilities(
  scope: Pick<WorkjetSupervisorTurnIntent, "instanceId" | "projectId" | "threadId">,
  commandId: CommandId,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  return confirmedControl(
    scope,
    {
      action: "project.supervisor.turn.capabilities",
      commandId,
      projectId: scope.projectId,
      threadId: scope.threadId,
    },
    port,
  );
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
  if (
    saved.submission === "not-submitted" &&
    saved.submissionError !== "not_active" &&
    saved.submissionError !== "timeout"
  )
    return { _tag: "failed", code: saved.submissionError ?? "unsupported" };
  // Older clients stored a transient bind failure as a refusal. Replay its
  // original binding command before submitting the original user intent.
  const submission = saved.submission === "not-submitted" ? "prepared" : saved.submission;
  await journal.save({ ...saved, submission });
  if (submission === "prepared") {
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
      await journal.save({
        intent,
        turn: null,
        submission:
          binding.code === "not_active" || binding.code === "timeout"
            ? "prepared"
            : "not-submitted",
        submissionError: binding.code,
      });
      return binding;
    }
  }
  if (submission === "prepared" && intent.turnKind === "conversation") {
    const capability = await readWorkjetSupervisorTurnCapabilities(
      intent,
      CommandId.make(`supervisor-kind-${Effect.runSync(Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER))}`),
      port,
    );
    if (capability._tag !== "completed") {
      await journal.save({
        intent,
        turn: null,
        submission:
          capability.code === "not_active" || capability.code === "timeout"
            ? "prepared"
            : "not-submitted",
        submissionError: capability.code,
      });
      return capability;
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
      ...(intent.turnKind === "conversation" ? { turnKind: intent.turnKind } : {}),
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
    await journal.save({
      intent: saved.intent,
      turn: result.response.turn,
      submission: "confirmed",
    });
  }
  return result;
}
