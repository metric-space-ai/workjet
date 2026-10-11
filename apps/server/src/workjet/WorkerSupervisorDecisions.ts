import {
  ApprovalRequestId, CommandId, MessageId, ThreadId,
  type OrchestrationThreadShell, type ProviderRuntimeEvent,
} from "@workjet/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export class WorkerSupervisorDecisionError extends Schema.TaggedErrorClass<WorkerSupervisorDecisionError>()(
  "WorkerSupervisorDecisionError", { message: Schema.String },
) {}

export const WorkerSupervisorAnswer = Schema.Struct({
  decisionId: Schema.String,
  answers: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)]))),
  decision: Schema.optional(Schema.Literals(["accept", "acceptForSession", "decline", "cancel"])),
});
export type WorkerSupervisorAnswer = typeof WorkerSupervisorAnswer.Type;

interface DecisionRow {
  readonly decisionId: string;
  readonly workerThreadId: string;
  readonly supervisorThreadId: string | null;
  readonly projectId: string;
  readonly requestId: string;
  readonly kind: "question" | "approval";
  readonly requestJson: string;
  readonly status: "pending" | "answering" | "resolved";
  readonly createdAt: string;
}

export const routeWorkerDecision = Effect.fn("workjet.routeWorkerDecision")(function* (
  thread: OrchestrationThreadShell, event: ProviderRuntimeEvent,
) {
  const sql = yield* SqlClient.SqlClient;
  if (event.type === "session.exited") {
    yield* sql`UPDATE workjet_worker_supervisor_decisions SET status = 'resolved' WHERE worker_thread_id = ${thread.id}`;
    return false;
  }
  if (event.type === "request.resolved" || event.type === "user-input.resolved") {
    yield* sql`UPDATE workjet_worker_supervisor_decisions SET status = 'resolved'
      WHERE worker_thread_id = ${thread.id} AND request_id = ${event.requestId ?? ''}`;
    return false;
  }
  if (event.type !== "user-input.requested" && event.type !== "request.opened") return false;
  if (event.type === "request.opened" && event.payload.requestType === "tool_user_input") return false;
  const team = thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
  if (team?.role !== "specialist" && team?.role !== "worker") return false;
  // Imported messages and server continuations are not human engagement.
  const engaged = yield* sql`SELECT 1 FROM orchestration_events
    WHERE stream_id = ${thread.id} AND event_type = 'thread.turn-start-requested'
      AND actor_kind = 'client' LIMIT 1`;
  if (engaged.length > 0) return false;
  const supervisors = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId" FROM projection_threads
    WHERE project_id = ${thread.projectId} AND deleted_at IS NULL AND archived_at IS NULL
      AND json_extract(workjet_config_json, '$.team.role') = 'supervisor'
    ORDER BY created_at, thread_id LIMIT 1`;
  const requestId = event.requestId ?? event.eventId;
  yield* sql`INSERT INTO workjet_worker_supervisor_decisions
    (decision_id, worker_thread_id, supervisor_thread_id, project_id, request_id, kind, request_json, created_at)
    VALUES (${`${thread.id}:${requestId}`}, ${thread.id}, ${supervisors[0]?.threadId ?? null},
      ${thread.projectId}, ${requestId}, ${event.type === 'user-input.requested' ? 'question' : 'approval'},
      ${Schema.encodeSync(Schema.UnknownFromJsonString)(event.payload)}, ${event.createdAt}) ON CONFLICT (decision_id) DO NOTHING`;
  return true;
});

export const deliverWorkerDecisions = Effect.fn("workjet.deliverWorkerDecisions")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  const rows = yield* sql<DecisionRow>`SELECT decision_id AS "decisionId", worker_thread_id AS "workerThreadId",
    supervisor_thread_id AS "supervisorThreadId", project_id AS "projectId", request_id AS "requestId",
    kind, request_json AS "requestJson", status, created_at AS "createdAt"
    FROM workjet_worker_supervisor_decisions WHERE status = 'pending' AND notified = 0 ORDER BY created_at LIMIT 16`;
  for (const row of rows) {
    const supervisors = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId" FROM projection_threads
      WHERE project_id = ${row.projectId} AND deleted_at IS NULL AND archived_at IS NULL
        AND json_extract(workjet_config_json, '$.team.role') = 'supervisor'
      ORDER BY created_at, thread_id LIMIT 1`;
    const supervisorId = supervisors[0]?.threadId;
    if (!supervisorId) continue;
    const found = yield* query.getThreadShellById(ThreadId.make(supervisorId));
    if (Option.isNone(found)) continue;
    const supervisor = found.value;
    if (supervisor.session?.status === 'running' || supervisor.session?.status === 'starting' ||
        supervisor.hasPendingApprovals || supervisor.hasPendingUserInput) continue;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE workjet_worker_supervisor_decisions SET supervisor_thread_id = ${supervisorId} WHERE decision_id = ${row.decisionId}`;
    yield* engine.dispatch({
      type: 'thread.turn.start', commandId: CommandId.make(`server:worker-decision:${row.decisionId}`),
      threadId: supervisor.id,
      message: { messageId: MessageId.make(`server:worker-decision:${row.decisionId}`), role: 'user', attachments: [],
        text: [
          `A project worker is waiting for your decision: [${row.workerThreadId}](/#/${encodeURIComponent(environmentId)}/${encodeURIComponent(row.workerThreadId)}).`,
          `Decision ID: ${row.decisionId}. Request kind: ${row.kind}.`,
          `Question, options or requested action: ${row.requestJson}`,
          'Decide within the Owner’s instructions. Call workjet_answer_worker with this decisionId and answers keyed by question id, or an approval decision. This resumes the original worker request. Only you may escalate to the Owner when an Owner decision is necessary.',
        ].join('\n\n') },
      runtimeMode: supervisor.runtimeMode, interactionMode: supervisor.interactionMode, createdAt,
    }, { deferWhileBusy: true });
    yield* sql`UPDATE workjet_worker_supervisor_decisions SET notified = 1 WHERE decision_id = ${row.decisionId}`;
  }
});

export const answerWorkerDecision = Effect.fn("workjet.answerWorkerDecision")(function* (
  supervisorThreadId: ThreadId, input: WorkerSupervisorAnswer,
) {
  const sql = yield* SqlClient.SqlClient;
  const query = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  const rows = yield* sql<DecisionRow>`SELECT worker_thread_id AS "workerThreadId", supervisor_thread_id AS "supervisorThreadId",
    project_id AS "projectId", request_id AS "requestId", kind, status
    FROM workjet_worker_supervisor_decisions WHERE decision_id = ${input.decisionId}`;
  const row = rows[0];
  const found = yield* query.getThreadShellById(supervisorThreadId);
  const config = Option.isSome(found) ? found.value.workjetConfig : undefined;
  if (!row || row.status !== 'pending' || row.supervisorThreadId !== supervisorThreadId ||
      Option.isNone(found) || found.value.deletedAt != null || found.value.archivedAt !== null ||
      found.value.projectId !== row.projectId || config?.schemaVersion !== 2 || config.team?.role !== 'supervisor')
    return yield* new WorkerSupervisorDecisionError({ message: 'Only the bound project Supervisor may answer a pending worker decision.' });
  if ((row.kind === 'question' && !input.answers) || (row.kind === 'approval' && !input.decision))
    return yield* new WorkerSupervisorDecisionError({ message: 'Supply answers for a question or a decision for an approval.' });
  const claimed = yield* sql`UPDATE workjet_worker_supervisor_decisions SET status = 'answering'
    WHERE decision_id = ${input.decisionId} AND status = 'pending' RETURNING decision_id`;
  if (claimed.length === 0) return yield* new WorkerSupervisorDecisionError({ message: 'The worker decision is already being answered.' });
  yield* (row.kind === 'question'
    ? providers.respondToUserInput({ threadId: ThreadId.make(row.workerThreadId), requestId: ApprovalRequestId.make(row.requestId), answers: input.answers! })
    : providers.respondToRequest({ threadId: ThreadId.make(row.workerThreadId), requestId: ApprovalRequestId.make(row.requestId), decision: input.decision! })
  ).pipe(Effect.tapError(() => sql`UPDATE workjet_worker_supervisor_decisions SET status = 'pending' WHERE decision_id = ${input.decisionId}`));
  yield* sql`UPDATE workjet_worker_supervisor_decisions SET status = 'resolved' WHERE decision_id = ${input.decisionId}`;
  return { accepted: true as const, workerThreadId: row.workerThreadId };
});
