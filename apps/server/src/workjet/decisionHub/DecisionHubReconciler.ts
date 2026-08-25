import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  ThreadId,
  WorkjetConnectionId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { threadHasActiveTurn } from "../mailbox/WorkjetDelegationExecutor.ts";
import { DecisionHubConnectionRegistry } from "./DecisionHubConnectionRegistry.ts";
import { DecisionHubMcpClient } from "./DecisionHubMcpClient.ts";

interface DueRow {
  readonly decisionId: string;
  readonly connectionId: string;
  readonly threadId: string;
  readonly status: "open" | "resolved" | "expired";
  readonly selectedOptionId: string | null;
  readonly comment: string | null;
  readonly resolutionVersion: number;
  readonly attempt: number;
}

export interface DecisionHubReconcilerShape {
  readonly runOnce: Effect.Effect<void>;
}

export class DecisionHubReconciler extends Context.Service<
  DecisionHubReconciler,
  DecisionHubReconcilerShape
>()("t3/workjet/decisionHub/DecisionHubReconciler") {}

export const decisionHubRetryDelayMs = (attempt: number, key: string): number => {
  const bounded = Math.min(Math.max(attempt, 0), 8);
  const base = Math.min(300_000, 2_000 * 2 ** bounded);
  const hash = Array.from(`${key}:${attempt}`).reduce(
    (value, character) => (value * 33 + character.charCodeAt(0)) >>> 0,
    5381,
  );
  return Math.round(base * (0.85 + (hash % 301) / 1_000));
};

export const decisionHubContinuationIds = (decisionId: string, resolutionVersion: number) => {
  const suffix = `${decisionId}:${resolutionVersion}`;
  return {
    activityCommandId: CommandId.make(`server:decision-hub-activity:${suffix}`),
    activityEventId: EventId.make(`decision-hub-resolution:${suffix}`),
    turnCommandId: CommandId.make(`server:decision-hub-turn:${suffix}`),
    messageId: MessageId.make(`decision-hub-resolution:${suffix}`),
  };
};

export const makeDecisionHubReconciler = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* DecisionHubConnectionRegistry;
  const client = yield* DecisionHubMcpClient;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;

  const defer = (row: DueRow, now: number) =>
    sql`
      UPDATE workjet_decision_hub_escalations
          SET attempt = ${row.attempt + 1}, next_poll_at_ms = ${now + decisionHubRetryDelayMs(row.attempt, row.decisionId)},
          updated_at_ms = ${now}
      WHERE decision_id = ${row.decisionId}
    `.pipe(Effect.asVoid);

  const resumeTerminal = (row: DueRow, now: number) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(row.threadId);
      const thread = yield* query.getThreadDetailById(threadId);
      if (Option.isNone(thread) || thread.value.deletedAt !== null) {
        yield* sql`
          UPDATE workjet_decision_hub_escalations
          SET continuation_claimed_at_ms = ${now}, updated_at_ms = ${now}
          WHERE decision_id = ${row.decisionId} AND continuation_claimed_at_ms IS NULL
        `;
        return;
      }
      if (threadHasActiveTurn(thread.value)) {
        yield* sql`
          UPDATE workjet_decision_hub_escalations
          SET next_poll_at_ms = ${now + 2_000}, updated_at_ms = ${now}
          WHERE decision_id = ${row.decisionId}
        `;
        return;
      }

      const ids = decisionHubContinuationIds(row.decisionId, row.resolutionVersion);
      const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
      const terminalSummary =
        row.status === "expired"
          ? "Decision Hub request expired"
          : "Decision Hub decision resolved";
      const payload = {
        schemaVersion: 1 as const,
        decisionId: row.decisionId,
        status: row.status,
        selectedOptionId: row.selectedOptionId,
        hasComment: row.comment !== null && row.comment.length > 0,
        resolutionVersion: row.resolutionVersion,
      };
      const activity = {
        type: "thread.activity.append",
        commandId: ids.activityCommandId,
        threadId,
        activity: {
          id: ids.activityEventId,
          tone: "info",
          kind: "workjet-decision-hub-resolution",
          summary: terminalSummary,
          payload,
          turnId: null,
          createdAt: nowIso,
        },
        createdAt: nowIso,
      } as const satisfies OrchestrationCommand;
      yield* engine.dispatch(activity);

      const answer =
        row.status === "expired"
          ? "The Decision Hub request expired without an owner selection. Reassess the blocker and only escalate again if a new owner decision is required."
          : [
              `Decision Hub resolved decision ${row.decisionId}.`,
              row.selectedOptionId === null
                ? "No option id was returned."
                : `Selected option: ${row.selectedOptionId}.`,
              row.comment === null || row.comment.length === 0
                ? "No owner comment was provided."
                : `Owner comment: ${row.comment}`,
              "Continue the task using this decision.",
            ].join("\n\n");
      const turn = {
        type: "thread.turn.start",
        commandId: ids.turnCommandId,
        threadId,
        message: {
          messageId: ids.messageId,
          role: "user",
          text: answer,
          attachments: [],
        },
        runtimeMode: thread.value.runtimeMode,
        interactionMode: thread.value.interactionMode,
        createdAt: nowIso,
      } as const satisfies OrchestrationCommand;
      yield* engine.dispatch(turn);
      yield* sql`
        UPDATE workjet_decision_hub_escalations
        SET continuation_claimed_at_ms = ${now}, updated_at_ms = ${now}
        WHERE decision_id = ${row.decisionId} AND continuation_claimed_at_ms IS NULL
      `;
    });

  const runOnce = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = (yield* sql<DueRow>`
      SELECT decision_id AS "decisionId", connection_id AS "connectionId",
             thread_id AS "threadId", status,
             selected_option_id AS "selectedOptionId", comment,
             resolution_version AS "resolutionVersion", attempt
      FROM workjet_decision_hub_escalations
      WHERE next_poll_at_ms <= ${now}
        AND (status = 'open' OR continuation_claimed_at_ms IS NULL)
      ORDER BY next_poll_at_ms, decision_id
      LIMIT 32
    `) as ReadonlyArray<DueRow>;

    for (const row of rows) {
      if (row.status !== "open") {
        yield* resumeTerminal(row, now).pipe(Effect.catchCause(() => defer(row, now)));
        continue;
      }
      const polled = yield* Effect.exit(
        Effect.gen(function* () {
          const target = yield* registry.resolveReadyTarget(
            WorkjetConnectionId.make(row.connectionId),
          );
          return yield* client.getDecision(target, row.decisionId);
        }),
      );
      if (polled._tag === "Failure") {
        yield* defer(row, now);
        continue;
      }
      const resolution = polled.value;
      if (resolution.status === "open") {
        yield* defer(row, now);
        continue;
      }
      yield* sql`
        UPDATE workjet_decision_hub_escalations
        SET status = ${resolution.status},
            selected_option_id = ${resolution.selectedOptionId},
            comment = ${resolution.comment},
            resolution_version = ${resolution.resolutionVersion},
            attempt = 0, next_poll_at_ms = ${now}, updated_at_ms = ${now}
        WHERE decision_id = ${row.decisionId} AND status = 'open'
      `;
      yield* resumeTerminal(
        {
          ...row,
          status: resolution.status,
          selectedOptionId: resolution.selectedOptionId,
          comment: resolution.comment,
          resolutionVersion: resolution.resolutionVersion,
          attempt: 0,
        },
        now,
      ).pipe(Effect.catchCause(() => defer(row, now)));
    }
  }).pipe(Effect.catchCause(Effect.logWarning));

  return DecisionHubReconciler.of({ runOnce });
});

export const layer = Layer.effect(
  DecisionHubReconciler,
  Effect.gen(function* () {
    const reconciler = yield* makeDecisionHubReconciler;
    yield* reconciler.runOnce.pipe(
      Effect.repeat(Schedule.spaced("2 seconds").pipe(Schedule.jittered)),
      Effect.forkScoped,
    );
    return reconciler;
  }),
);
