import {
  CommandId,
  WorkjetSupervisorInputIntent,
  WorkjetSupervisorInputReceipt,
  type WorkjetSupervisorInputJournal,
  WorkjetSupervisorJournal,
  isWorkjetSupervisorReceiptForRequest,
  type CtoxWorkjetProjectControlResult,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { Effect, Random } from "effect";
import {
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";
import type { WorkjetSupervisorJournalPort } from "./workjetSupervisorControl";

const decodeIntent = Schema.decodeUnknownSync(WorkjetSupervisorInputIntent, {
  onExcessProperty: "error",
});
const decodeJournal = Schema.decodeUnknownSync(WorkjetSupervisorJournal, {
  onExcessProperty: "error",
});
const decodeReceipt = Schema.decodeUnknownSync(WorkjetSupervisorInputReceipt, {
  onExcessProperty: "error",
});

/** A separate opt-in read preserves legacy conversation capability discovery. */
export async function readWorkjetSupervisorInputCapabilities(
  scope: Pick<WorkjetSupervisorInputIntent, "instanceId" | "projectId" | "threadId">,
  commandId: CommandId,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  const request = {
    action: "project.supervisor.turn.capabilities" as const,
    commandId,
    projectId: scope.projectId,
    threadId: scope.threadId,
    includeInput: true,
  };
  const result = await requestWorkjetProjectControl(scope.instanceId, request, port);
  return result._tag === "completed" &&
    !isWorkjetSupervisorReceiptForRequest(request, result.response)
    ? { _tag: "failed", code: "unsupported" }
    : result;
}

/** Save the input identity before dispatch; recovery resends that exact operation. */
export async function submitWorkjetSupervisorInput(
  saved: WorkjetSupervisorJournal,
  intent: WorkjetSupervisorInputIntent,
  journal: WorkjetSupervisorJournalPort,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  decodeJournal(saved);
  decodeIntent(intent);
  const previous = saved.inputs ?? [];
  const known = previous.find((entry) => entry.intent.commandId === intent.commandId);
  if (
    saved.submission !== "confirmed" ||
    !saved.turn?.taskId ||
    intent.instanceId !== saved.intent.instanceId ||
    intent.projectId !== saved.intent.projectId ||
    intent.threadId !== saved.intent.threadId ||
    intent.targetCommandId !== saved.turn.commandId
  )
    throw new Error("Select an active confirmed Supervisor task before adding context.");
  if (saved.turn.terminal && !known?.receipt && known?.submission !== "awaiting-receipt")
    throw new Error("This task has finished; new context was not sent.");
  if (known && JSON.stringify(known.intent) !== JSON.stringify(intent))
    throw new Error("The saved input identity belongs to different context.");
  if (known?.receipt) return { _tag: "completed", response: known.receipt };
  if (!known && previous.length >= 128)
    throw new Error("This task has reached its saved context limit.");
  if (
    previous.some((entry) => entry.intent.commandId !== intent.commandId && entry.receipt === null)
  )
    throw new Error("Recover the previous context receipt before adding another message.");
  let entry: WorkjetSupervisorInputJournal = known ?? {
    intent,
    receipt: null,
    submission: "prepared",
  };
  const save = async (next: typeof entry, turn = saved.turn) => {
    const inputs = [...previous.filter((item) => item.intent.commandId !== intent.commandId), next];
    await journal.save({ ...saved, turn, inputs });
    entry = next;
  };
  await save(entry);
  const nonce = Effect.runSync(Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER));
  const capability = await readWorkjetSupervisorInputCapabilities(
    intent,
    CommandId.make(`input-cap-${nonce}`),
    port,
  );
  if (capability._tag !== "completed") return capability;
  await save({ ...entry, submission: "awaiting-receipt" });
  const request = {
    action: "project.supervisor.turn.input" as const,
    commandId: intent.commandId,
    projectId: intent.projectId,
    threadId: intent.threadId,
    targetCommandId: intent.targetCommandId,
    body: intent.body,
  };
  const result = await requestWorkjetProjectControl(intent.instanceId, request, port);
  if (result._tag !== "completed") return result;
  if (
    !isWorkjetSupervisorReceiptForRequest(request, result.response) ||
    result.response.action !== "project.supervisor.turn.input" ||
    result.response.turn.taskId !== saved.turn.taskId
  )
    return { _tag: "failed", code: "guest_failed" };
  let receipt: WorkjetSupervisorInputReceipt;
  try {
    receipt = decodeReceipt(result.response);
  } catch {
    return { _tag: "failed", code: "guest_failed" };
  }
  // An idempotent input receipt can predate the current task observation.
  // Only the task watch advances its state; adding context never reopens a hold.
  await save({ intent, receipt, submission: "confirmed" });
  return { _tag: "completed", response: receipt };
}
