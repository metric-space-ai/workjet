import {
  ApprovalRequestId,
  EventId,
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationThreadShell,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
} from "@workjet/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export class WorkerSupervisorDecisionError extends Schema.TaggedErrorClass<WorkerSupervisorDecisionError>()(
  "WorkerSupervisorDecisionError",
  { message: Schema.String },
) {}

export const WorkerSupervisorAnswer = Schema.Struct({
  decisionId: Schema.String,
  answers: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
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
  readonly answerJson?: string | null;
}

export const ONE_SHOT_SELF_DECISION =
  "Entscheide selbst innerhalb deines Worktrees und dokumentiere die Entscheidung im PR";

/** Called exclusively by the authenticated websocket UI turn ingress after dispatch succeeds. */
export const recordWorkerOwnerActivity = Effect.fn("workjet.recordWorkerOwnerActivity")(function* (
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
) {
  if (!command.message.text.trim() && command.message.attachments.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO workjet_worker_owner_engagement(thread_id,command_id,message_id,created_at)
    SELECT thread_id, ${command.commandId}, ${command.message.messageId}, ${command.createdAt}
    FROM projection_threads WHERE thread_id = ${command.threadId} AND deleted_at IS NULL
      AND json_extract(workjet_config_json, '$.team.role') IN ('specialist','worker')
    ON CONFLICT(thread_id) DO NOTHING`;
});

const automaticallyAnswerOneShot = Effect.fn("workjet.automaticallyAnswerOneShot")(function* (
  thread: OrchestrationThreadShell,
  event: Extract<ProviderRuntimeEvent, { type: "user-input.requested" | "request.opened" }>,
) {
  const providers = yield* ProviderService;
  const requestId = ApprovalRequestId.make(event.requestId ?? event.eventId);
  yield* (
    event.type === "user-input.requested"
      ? providers.respondToUserInput({
          threadId: thread.id,
          requestId,
          answers: Object.fromEntries(
            event.payload.questions.map((question) => [question.id, ONE_SHOT_SELF_DECISION]),
          ),
        })
      : providers.respondToRequest({ threadId: thread.id, requestId, decision: "accept" })
  ).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`server:one-shot-unanswered:${event.eventId}`),
          threadId: thread.id,
          createdAt,
          activity: {
            id: EventId.make(`server:one-shot-unanswered:${event.eventId}`),
            turnId: null,
            kind: "worker.result",
            tone: "error",
            summary: "One-Shot beendet: Frage-Werkzeug konnte nicht automatisch beantwortet werden",
            payload: { openPoint: String(error), decision: ONE_SHOT_SELF_DECISION },
            createdAt,
          },
        });
        yield* providers.stopSession({ threadId: thread.id }).pipe(Effect.catch(Effect.logWarning));
      }),
    ),
  );
});

export const WORKER_SUPERVISOR_TIMEOUT_MS = 5 * 60 * 1000;
const expireUnboundWorkerDecisions = Effect.fn("workjet.expireUnboundWorkerDecisions")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    const cutoff = DateTime.formatIso(DateTime.makeUnsafe(now - WORKER_SUPERVISOR_TIMEOUT_MS));
    const expired = yield* sql<{
      decisionId: string;
      workerThreadId: string;
    }>`UPDATE workjet_worker_supervisor_decisions SET status='timed-out', failure='Projekt ohne Supervisor: Wartezeit abgelaufen'
    WHERE status='pending' AND created_at < ${cutoff} AND NOT EXISTS (
      SELECT 1 FROM projection_threads WHERE project_id=workjet_worker_supervisor_decisions.project_id
        AND deleted_at IS NULL AND archived_at IS NULL AND json_extract(workjet_config_json,'$.team.role')='supervisor') RETURNING decision_id AS "decisionId",worker_thread_id AS "workerThreadId"`;
    const engine = yield* OrchestrationEngineService;
    const createdAt = DateTime.formatIso(DateTime.makeUnsafe(now));
    for (const row of expired)
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:worker-decision-timeout:${row.decisionId}`),
        threadId: ThreadId.make(row.workerThreadId),
        createdAt,
        activity: {
          id: EventId.make(`server:worker-decision-timeout:${row.decisionId}`),
          turnId: null,
          kind: "workjet.worker.decision-timeout",
          tone: "error",
          summary: "Projekt ohne Supervisor: Wartezeit abgelaufen",
          payload: { decisionId: row.decisionId },
          createdAt,
        },
      });
  },
);

/** Recover only once at reactor startup; never steal a live in-flight response. */
export const recoverWorkerDecisionAnswers = Effect.fn("workjet.recoverWorkerDecisionAnswers")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE workjet_worker_supervisor_decisions SET status='pending' WHERE status='answering'`;
  },
);

export const retryRetainedWorkerAnswers = Effect.fn("workjet.retryRetainedWorkerAnswers")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      decisionId: string;
      supervisorThreadId: string;
      answerJson: string;
    }>`SELECT decision_id AS "decisionId",
    supervisor_thread_id AS "supervisorThreadId", answer_json AS "answerJson"
    FROM workjet_worker_supervisor_decisions WHERE status='pending' AND answer_json IS NOT NULL AND supervisor_thread_id IS NOT NULL LIMIT 16`;
    for (const row of rows) {
      const input = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(WorkerSupervisorAnswer),
      )(row.answerJson);
      yield* answerWorkerDecision(ThreadId.make(row.supervisorThreadId), input).pipe(
        Effect.catch((error) =>
          Effect.logWarning("retained worker answer deferred", {
            decisionId: row.decisionId,
            error,
          }),
        ),
      );
    }
  },
);

export const routeWorkerDecision = Effect.fn("workjet.routeWorkerDecision")(function* (
  thread: OrchestrationThreadShell,
  event: ProviderRuntimeEvent,
) {
  const sql = yield* SqlClient.SqlClient;
  if (event.type === "session.exited") {
    yield* sql`UPDATE workjet_worker_supervisor_decisions SET status = 'resolved' WHERE worker_thread_id = ${thread.id}`;
    return false;
  }
  if (event.type === "request.resolved" || event.type === "user-input.resolved") {
    yield* sql`UPDATE workjet_worker_supervisor_decisions SET status = 'resolved'
      WHERE worker_thread_id = ${thread.id} AND request_id = ${event.requestId ?? ""}`;
    return false;
  }
  if (event.type !== "user-input.requested" && event.type !== "request.opened") return false;
  if (event.type === "request.opened" && event.payload.requestType === "tool_user_input")
    return false;
  const team = thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
  if (team?.role !== "specialist" && team?.role !== "worker") return false;
  if (team.role === "worker") {
    yield* automaticallyAnswerOneShot(thread, event);
    return true;
  }
  // This receipt is written only at the authenticated UI message ingress, never inferred from actor_kind.
  const engaged =
    yield* sql`SELECT 1 FROM workjet_worker_owner_engagement WHERE thread_id = ${thread.id} LIMIT 1`;
  if (engaged.length > 0) return false;
  const supervisors = yield* sql<{
    threadId: string;
  }>`SELECT thread_id AS "threadId" FROM projection_threads
    WHERE project_id = ${thread.projectId} AND deleted_at IS NULL AND archived_at IS NULL
      AND json_extract(workjet_config_json, '$.team.role') = 'supervisor'
    ORDER BY created_at, thread_id LIMIT 1`;
  const requestId = event.requestId ?? event.eventId;
  yield* sql`INSERT INTO workjet_worker_supervisor_decisions
    (decision_id, worker_thread_id, supervisor_thread_id, project_id, request_id, kind, request_json, created_at)
    VALUES (${`${thread.id}:${requestId}`}, ${thread.id}, ${supervisors[0]?.threadId ?? null},
      ${thread.projectId}, ${requestId}, ${event.type === "user-input.requested" ? "question" : "approval"},
      ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(event.payload)}, ${event.createdAt}) ON CONFLICT (decision_id) DO NOTHING`;
  return true;
});

export const deliverWorkerDecisions = Effect.fn("workjet.deliverWorkerDecisions")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  yield* expireUnboundWorkerDecisions();
  const rows =
    yield* sql<DecisionRow>`SELECT decision_id AS "decisionId", worker_thread_id AS "workerThreadId",
    supervisor_thread_id AS "supervisorThreadId", project_id AS "projectId", request_id AS "requestId",
    kind, request_json AS "requestJson", status, created_at AS "createdAt"
    FROM workjet_worker_supervisor_decisions WHERE status = 'pending' AND notified = 0 ORDER BY created_at LIMIT 16`;
  for (const row of rows) {
    const supervisors = yield* sql<{
      threadId: string;
    }>`SELECT thread_id AS "threadId" FROM projection_threads
      WHERE project_id = ${row.projectId} AND deleted_at IS NULL AND archived_at IS NULL
        AND json_extract(workjet_config_json, '$.team.role') = 'supervisor'
      ORDER BY created_at, thread_id LIMIT 1`;
    const supervisorId = supervisors[0]?.threadId;
    if (!supervisorId) {
      yield* sql`UPDATE workjet_worker_supervisor_decisions SET supervisor_thread_id = NULL WHERE decision_id = ${row.decisionId}`;
      continue;
    }
    const found = yield* query.getThreadShellById(ThreadId.make(supervisorId));
    if (Option.isNone(found)) continue;
    const supervisor = found.value;
    if (
      supervisor.session?.status === "running" ||
      supervisor.session?.status === "starting" ||
      supervisor.hasPendingApprovals ||
      supervisor.hasPendingUserInput
    )
      continue;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE workjet_worker_supervisor_decisions SET supervisor_thread_id = ${supervisorId} WHERE decision_id = ${row.decisionId}`;
    yield* engine.dispatch(
      {
        type: "thread.turn.start",
        commandId: CommandId.make(`server:worker-decision:${row.decisionId}`),
        threadId: supervisor.id,
        message: {
          messageId: MessageId.make(`server:worker-decision:${row.decisionId}`),
          role: "user",
          attachments: [],
          text: [
            `A project worker is waiting for your decision: [${row.workerThreadId}](/#/${encodeURIComponent(environmentId)}/${encodeURIComponent(row.workerThreadId)}).`,
            `Decision ID: ${row.decisionId}. Request kind: ${row.kind}.`,
            `Question, options or requested action: ${row.requestJson}`,
            'Decide within the Owner’s instructions. If workjet_answer_worker is available, call it with this decisionId and answers keyed by question id, or an approval decision. If your harness has no such tool, reply ONLY with <workjet_worker_decision>{"decisionId":"' +
              row.decisionId +
              '","answers":{"question-id":"selected answer"}}</workjet_worker_decision> (for approvals replace answers with decision accept/acceptForSession/decline/cancel). Workjet reads this completed Supervisor reply and resumes the original request. Only you may escalate to the Owner when an Owner decision is necessary.',
          ].join("\n\n"),
        },
        runtimeMode: supervisor.runtimeMode,
        interactionMode: supervisor.interactionMode,
        createdAt,
      },
      { deferWhileBusy: true },
    );
    yield* sql`UPDATE workjet_worker_supervisor_decisions SET notified = 1 WHERE decision_id = ${row.decisionId}`;
  }
});

/** A native Supervisor without MCP may answer through one exact, completed assistant message. */
export const resumeWorkerDecisionsFromSupervisor = Effect.fn(
  "workjet.resumeWorkerDecisionsFromSupervisor",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql<DecisionRow>`SELECT decision_id AS "decisionId", supervisor_thread_id AS "supervisorThreadId", created_at AS "createdAt"
    FROM workjet_worker_supervisor_decisions WHERE status = 'pending' AND notified = 1 AND supervisor_thread_id IS NOT NULL
    ORDER BY created_at LIMIT 16`;
  for (const row of rows) {
    const messages = yield* sql<{
      text: string;
    }>`SELECT substr(text, 1, 16384) AS text FROM projection_thread_messages
      WHERE thread_id = ${row.supervisorThreadId} AND role = 'assistant' AND is_streaming = 0 AND created_at >= ${row.createdAt}
      ORDER BY created_at DESC LIMIT 3`;
    for (const message of messages) {
      const payload = /^\s*<workjet_worker_decision>([\s\S]+)<\/workjet_worker_decision>\s*$/.exec(
        message.text,
      )?.[1];
      if (!payload) continue;
      const answer = Schema.decodeUnknownOption(Schema.fromJsonString(WorkerSupervisorAnswer), {
        onExcessProperty: "error",
      })(payload);
      if (Option.isNone(answer) || answer.value.decisionId !== row.decisionId) continue;
      yield* answerWorkerDecision(ThreadId.make(row.supervisorThreadId!), answer.value);
      break;
    }
  }
});

const continueWorkerWithAnswer = Effect.fn("workjet.continueWorkerWithAnswer")(function* (
  workerThreadId: ThreadId,
  input: WorkerSupervisorAnswer,
) {
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const found = yield* query.getThreadShellById(workerThreadId);
  if (Option.isNone(found))
    return yield* new WorkerSupervisorDecisionError({ message: "Worker thread is unavailable." });
  const worker = found.value;
  if (worker.workjetConfig.schemaVersion === 2 && worker.workjetConfig.goal?.status === "paused")
    return yield* new WorkerSupervisorDecisionError({
      message: "Worker is paused by the Owner; retain the answer until resumed.",
    });
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* engine.dispatch(
    {
      type: "thread.turn.start",
      commandId: CommandId.make(`server:worker-answer:${input.decisionId}`),
      threadId: worker.id,
      message: {
        messageId: MessageId.make(`server:worker-answer:${input.decisionId}`),
        role: "user",
        attachments: [],
        text: `Decision for ${input.decisionId}: ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input.answers ?? input.decision)}. Continue within your assigned goal and worktree.`,
      },
      runtimeMode: worker.runtimeMode,
      interactionMode: worker.interactionMode,
      createdAt,
    },
    { deferWhileBusy: true },
  );
});

export const WorkjetEscalation = Schema.Struct({
  question: Schema.String,
  options: Schema.optional(Schema.Array(Schema.String)),
});

export const escalateWorkjetDecision = Effect.fn("workjet.escalateWorkjetDecision")(function* (
  threadId: ThreadId,
  input: typeof WorkjetEscalation.Type,
) {
  const sql = yield* SqlClient.SqlClient;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const found = yield* query.getThreadShellById(threadId);
  const team =
    Option.isSome(found) && found.value.workjetConfig.schemaVersion === 2
      ? found.value.workjetConfig.team
      : undefined;
  if (Option.isNone(found) || !team || team.role === "worker")
    return yield* new WorkerSupervisorDecisionError({
      message:
        "One-Shots cannot ask or escalate. Decide within your worktree and document the decision in the PR.",
    });
  const thread = found.value;
  const requestId = `workjet-escalate:${yield* (yield* Crypto.Crypto).randomUUIDv4}`;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const payload = {
    transport: "mcp",
    questions: [
      {
        id: "decision",
        header: "Decision",
        question: input.question,
        multiSelect: false,
        options: (input.options ?? []).map((label) => ({ label, description: label })),
      },
    ],
  };
  const supervisors = yield* sql<{
    threadId: string;
  }>`SELECT thread_id AS "threadId" FROM projection_threads
    WHERE project_id=${thread.projectId} AND deleted_at IS NULL AND archived_at IS NULL
    AND json_extract(workjet_config_json,'$.team.role')='supervisor' ORDER BY created_at, thread_id LIMIT 1`;
  yield* sql`INSERT INTO workjet_worker_supervisor_decisions
    (decision_id,worker_thread_id,supervisor_thread_id,project_id,request_id,kind,request_json,created_at,notified)
    VALUES (${`${thread.id}:${requestId}`},${thread.id},${team.role === "supervisor" ? thread.id : (supervisors[0]?.threadId ?? null)},
    ${thread.projectId},${requestId},'question',${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(payload)},${createdAt},${team.role === "supervisor" ? 1 : 0})`;
  yield* engine.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.make(`server:${requestId}`),
    threadId,
    activity: {
      id: EventId.make(`server:${requestId}`),
      turnId: null,
      kind: "user-input.requested",
      summary:
        team.role === "supervisor"
          ? "Supervisor benötigt eine Owner-Entscheidung"
          : "Worker wartet auf Supervisor",
      tone: "info",
      payload: {
        ...payload,
        requestId,
        ...(team.role === "supervisor" ? {} : { recipient: "supervisor" }),
      },
      createdAt,
    },
    createdAt,
  });
  return {
    accepted: true,
    decisionId: `${thread.id}:${requestId}`,
    recipient: team.role === "supervisor" ? "owner" : "supervisor",
  };
});

/** MCP questions have no native CLI callback; a UI answer resumes the Supervisor through the durable queue. */
export const answerOwnerEscalation = Effect.fn("workjet.answerOwnerEscalation")(function* (
  threadId: ThreadId,
  requestId: string,
  answers: Readonly<Record<string, unknown>>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT decision_id FROM workjet_worker_supervisor_decisions
    WHERE worker_thread_id=${threadId} AND supervisor_thread_id=${threadId} AND request_id=${requestId} AND status='pending'
    AND json_extract(request_json,'$.transport')='mcp'`;
  if (rows.length === 0) return false;
  const answer = yield* Schema.decodeUnknownEffect(WorkerSupervisorAnswer)({
    decisionId: `${threadId}:${requestId}`,
    answers,
  });
  yield* answerWorkerDecision(threadId, answer);

  return true;
});

/** Harnesses without a native question hook still cannot put an unattended question in Needs you. */
export const routeWorkerTerminalQuestion = Effect.fn("workjet.routeWorkerTerminalQuestion")(
  function* (thread: OrchestrationThreadShell, text: string, turnId: string) {
    const team = thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
    if (!team || (team.role !== "specialist" && team.role !== "worker")) return false;
    const tail =
      text
        .trim()
        .split(/\n\s*\n/)
        .at(-1)
        ?.trim() ?? "";
    if (!/[?？]\s*$/.test(tail)) return false;
    if (team.role === "worker") {
      const sql = yield* SqlClient.SqlClient;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const first = yield* sql`INSERT INTO workjet_worker_supervisor_decisions
        (decision_id,worker_thread_id,supervisor_thread_id,project_id,request_id,kind,request_json,created_at,status)
        VALUES (${thread.id + ":one-shot-self-decision"},${thread.id},NULL,${thread.projectId},'one-shot-self-decision','question','{}',${createdAt},'resolved')
        ON CONFLICT(decision_id) DO NOTHING RETURNING decision_id`;
      if (first.length === 0) {
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`server:one-shot-report:${turnId}`),
          threadId: thread.id,
          createdAt,
          activity: {
            id: EventId.make(`server:one-shot-report:${turnId}`),
            turnId: null,
            kind: "workjet.worker.result",
            tone: "error",
            summary: "One-Shot beendet: offener Punkt im Bericht",
            payload: { openPoint: tail, decision: ONE_SHOT_SELF_DECISION },
            createdAt,
          },
        });
        yield* (yield* ProviderService)
          .stopSession({ threadId: thread.id })
          .pipe(Effect.catch(Effect.logWarning));
        return true;
      }
      yield* continueWorkerWithAnswer(thread.id, {
        decisionId: `text:${turnId}`,
        answers: { decision: ONE_SHOT_SELF_DECISION },
      });
      return true;
    }
    const sql = yield* SqlClient.SqlClient;
    const engaged =
      yield* sql`SELECT 1 FROM workjet_worker_owner_engagement WHERE thread_id=${thread.id} LIMIT 1`;
    if (engaged.length > 0) return false;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const requestId = `text:${turnId}`;
    const supervisors = yield* sql<{
      threadId: string;
    }>`SELECT thread_id AS "threadId" FROM projection_threads WHERE project_id=${thread.projectId}
    AND deleted_at IS NULL AND archived_at IS NULL AND json_extract(workjet_config_json,'$.team.role')='supervisor' ORDER BY created_at,thread_id LIMIT 1`;
    yield* sql`INSERT INTO workjet_worker_supervisor_decisions
    (decision_id,worker_thread_id,supervisor_thread_id,project_id,request_id,kind,request_json,created_at)
    VALUES (${`${thread.id}:${requestId}`},${thread.id},${supervisors[0]?.threadId ?? null},${thread.projectId},${requestId},'question',
      ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ transport: "text", questions: [{ id: "decision", question: tail, options: [] }] })},${createdAt}) ON CONFLICT(decision_id) DO NOTHING`;
    return true;
  },
);

export const answerWorkerDecision = Effect.fn("workjet.answerWorkerDecision")(function* (
  supervisorThreadId: ThreadId,
  input: WorkerSupervisorAnswer,
) {
  const sql = yield* SqlClient.SqlClient;
  const query = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  const rows =
    yield* sql<DecisionRow>`SELECT worker_thread_id AS "workerThreadId", supervisor_thread_id AS "supervisorThreadId",
    project_id AS "projectId", request_id AS "requestId", request_json AS "requestJson", kind, status
    FROM workjet_worker_supervisor_decisions WHERE decision_id = ${input.decisionId}`;
  const row = rows[0];
  const found = yield* query.getThreadShellById(supervisorThreadId);
  const config = Option.isSome(found) ? found.value.workjetConfig : undefined;
  if (
    !row ||
    row.status !== "pending" ||
    row.supervisorThreadId !== supervisorThreadId ||
    Option.isNone(found) ||
    found.value.deletedAt != null ||
    found.value.archivedAt !== null ||
    found.value.projectId !== row.projectId ||
    config?.schemaVersion !== 2 ||
    config.team?.role !== "supervisor"
  )
    return yield* new WorkerSupervisorDecisionError({
      message: "Only the bound project Supervisor may answer a pending worker decision.",
    });
  if ((row.kind === "question" && !input.answers) || (row.kind === "approval" && !input.decision))
    return yield* new WorkerSupervisorDecisionError({
      message: "Supply answers for a question or a decision for an approval.",
    });
  const retainedAnswer = yield* Schema.encodeEffect(Schema.fromJsonString(WorkerSupervisorAnswer))(
    input,
  );
  const claimed =
    yield* sql`UPDATE workjet_worker_supervisor_decisions SET status = 'answering', answer_json = ${retainedAnswer}
    WHERE decision_id = ${input.decisionId} AND status = 'pending' RETURNING decision_id`;
  if (claimed.length === 0)
    return yield* new WorkerSupervisorDecisionError({
      message: "The worker decision is already being answered.",
    });
  const request = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  )(row.requestJson);
  yield* Effect.gen(function* () {
    if (request.transport === "mcp" || request.transport === "text") {
      yield* continueWorkerWithAnswer(ThreadId.make(row.workerThreadId), input);
    } else if (row.kind === "question") {
      yield* providers.respondToUserInput({
        threadId: ThreadId.make(row.workerThreadId),
        requestId: ApprovalRequestId.make(row.requestId),
        answers: input.answers!,
      });
    } else {
      yield* providers.respondToRequest({
        threadId: ThreadId.make(row.workerThreadId),
        requestId: ApprovalRequestId.make(row.requestId),
        decision: input.decision!,
      });
    }
  }).pipe(
    Effect.catch((error) =>
      /stale|unknown pending|no active provider session/i.test(String(error))
        ? continueWorkerWithAnswer(ThreadId.make(row.workerThreadId), input)
        : Effect.fail(error),
    ),
    Effect.tapError(
      () =>
        sql`UPDATE workjet_worker_supervisor_decisions SET status = 'pending' WHERE decision_id = ${input.decisionId}`,
    ),
  );
  if (row.workerThreadId === supervisorThreadId && request.transport === "mcp") {
    const engine = yield* OrchestrationEngineService;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:owner-answer:${row.requestId}`),
      threadId: supervisorThreadId,
      activity: {
        id: EventId.make(`server:owner-answer:${row.requestId}`),
        turnId: null,
        kind: "user-input.resolved",
        summary: "Owner decision received",
        tone: "info",
        payload: { requestId: row.requestId },
        createdAt,
      },
      createdAt,
    });
  }
  yield* sql`UPDATE workjet_worker_supervisor_decisions SET status = 'resolved' WHERE decision_id = ${input.decisionId}`;
  return { accepted: true as const, workerThreadId: row.workerThreadId };
});
