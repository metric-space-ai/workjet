import * as Schema from "effect/Schema";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { isWorkjetJourFixeReadReceiptForRequest } from "./workjetJourFixeMeeting.ts";

// Wire names and limits match ctox.workjet.jour_fixe.v1. Owner text cannot
// impersonate a supervisor or assert speech provenance.
const text = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const id = text(128);
const unsigned = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const meetingFields = {
  commandId: CommandId,
  projectId: ProjectId,
  operationId: id,
  meetingId: id,
  expectedRevision: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
  ),
};
const ownerText = Schema.Struct({
  id,
  meeting_id: id,
  sequence: unsigned,
  speaker: Schema.Literal("owner"),
  modality: Schema.Literal("text"),
  text: text(16_384),
  started_at_ms: unsigned,
  ended_at_ms: unsigned,
}).check(
  Schema.makeFilter(
    (turn) => turn.ended_at_ms >= turn.started_at_ms || "Text ends before it starts.",
  ),
);
const todo = Schema.Struct({
  id,
  title: text(512),
  acceptance: text(4_096),
  priority: Schema.Literals(["P0", "P1", "P2"]),
  evidence_ids: Schema.Array(id).check(Schema.isMaxLength(128)),
  due_at_ms: Schema.optionalKey(unsigned),
});

export const WorkjetJourFixeOwnerRequests = [
  Schema.Struct({ action: Schema.Literal("project.jour_fixe.meeting.start"), ...meetingFields }),
  Schema.Struct({ action: Schema.Literal("project.jour_fixe.meeting.end"), ...meetingFields }),
  Schema.Struct({
    action: Schema.Literal("project.jour_fixe.transcript.append"),
    ...meetingFields,
    turn: ownerText,
  }).check(
    Schema.makeFilter(
      (request) =>
        request.turn.meeting_id === request.meetingId || "Text belongs to another meeting.",
    ),
  ),
  Schema.Struct({
    action: Schema.Literal("project.jour_fixe.todos.revise"),
    ...meetingFields,
    proposalRevision: unsigned,
    items: Schema.Array(todo).check(Schema.isMaxLength(100)),
  }),
] as const;
export const WorkjetJourFixeOwnerRequest = Schema.Union(WorkjetJourFixeOwnerRequests);
export type WorkjetJourFixeOwnerRequest = typeof WorkjetJourFixeOwnerRequest.Type;

export const WorkjetJourFixeOwnerResponse = Schema.Struct({
  action: Schema.Literals([
    "project.jour_fixe.meeting.start",
    "project.jour_fixe.meeting.end",
    "project.jour_fixe.transcript.append",
    "project.jour_fixe.todos.revise",
  ]),
  commandId: CommandId,
  projectId: ProjectId,
  contract: Schema.Literal("ctox.workjet.jour_fixe.v1"),
  mutation: Schema.Struct({
    operation_id: id,
    meeting_id: id,
    project_id: id,
    revision: unsigned,
    state: Schema.Literals([
      "planned",
      "preparing",
      "ready",
      "live",
      "review",
      "confirmed",
      "cancelled",
      "failed",
    ]),
    changed_id: Schema.optionalKey(id),
    todos_revision: Schema.optionalKey(unsigned),
  }),
}).check(
  Schema.makeFilter(
    (response) =>
      response.projectId === response.mutation.project_id ||
      "Meeting receipt belongs to another project.",
  ),
);
export type WorkjetJourFixeOwnerResponse = typeof WorkjetJourFixeOwnerResponse.Type;

const decodeRequest = Schema.decodeUnknownSync(WorkjetJourFixeOwnerRequest, {
  onExcessProperty: "error",
});
const decodeResponse = Schema.decodeUnknownSync(WorkjetJourFixeOwnerResponse, {
  onExcessProperty: "error",
});

/** Reject stale/cross-operation guest receipts before resolving a room action. */
export function isWorkjetJourFixeReceiptForRequest(request: unknown, response: unknown): boolean {
  if (
    typeof request !== "object" ||
    request === null ||
    !("action" in request) ||
    typeof request.action !== "string"
  )
    return false;

  if (!request.action.startsWith("project.jour_fixe.")) return true;
  if (request.action === "project.jour_fixe.meeting.read") return isWorkjetJourFixeReadReceiptForRequest(request, response);

  try {
    const intent = decodeRequest(request);
    const receipt = decodeResponse(response);
    const mutation = receipt.mutation;
    if (
      receipt.action !== intent.action ||
      receipt.commandId !== intent.commandId ||
      receipt.projectId !== intent.projectId ||
      mutation.operation_id !== intent.operationId ||
      mutation.meeting_id !== intent.meetingId ||
      mutation.revision !== intent.expectedRevision + 1
    )
      return false;
    switch (intent.action) {
      case "project.jour_fixe.meeting.start":
        return mutation.state === "live";
      case "project.jour_fixe.meeting.end":
        return mutation.state === "review";
      case "project.jour_fixe.transcript.append":
        return (
          ["live", "review"].includes(mutation.state) && mutation.changed_id === intent.turn.id
        );
      case "project.jour_fixe.todos.revise":
        return mutation.state === "review" && mutation.todos_revision === intent.proposalRevision;
    }
  } catch {
    return false;
  }
}
