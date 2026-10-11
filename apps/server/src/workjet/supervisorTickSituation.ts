import {
  type OrchestrationProject,
  type OrchestrationThread,
  type CtoxWorkjetJourFixe,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";

const Check = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.optionalKey(Schema.String),
});
export const SupervisorPullRequests = Schema.Array(
  Schema.Struct({
    number: Schema.Int,
    title: Schema.String,
    url: Schema.String,
    headRefName: Schema.String,
    createdAt: Schema.String,
    updatedAt: Schema.String,
    isDraft: Schema.Boolean,
    author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
    statusCheckRollup: Schema.NullOr(Schema.Array(Check)),
    mergeStateStatus: Schema.String,
  }),
);
export type SupervisorPullRequest = (typeof SupervisorPullRequests.Type)[number];

export function supervisorPullRequestState(pr: SupervisorPullRequest) {
  const checks = pr.statusCheckRollup ?? [];
  const red = checks.some((c) =>
    ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(
      c.conclusion ?? c.state ?? "",
    ),
  );
  const green =
    checks.length > 0 &&
    checks.every((c) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? c.state ?? ""));
  return { red, green, ready: !pr.isDraft && green && pr.mergeStateStatus === "CLEAN" };
}

export function minutesUntilRegularMeeting(
  meeting: typeof CtoxWorkjetJourFixe.Type | null | undefined,
  now: number,
): number | null {
  if (!meeting) return null;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: meeting.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  // Compare in the configured zone, including DST; at most one week plus a DST hour.
  for (let minutes = 0; minutes <= 7 * 24 * 60 + 120; minutes++) {
    const parts = formatter.formatToParts(now + minutes * 60000);
    const part = (kind: string) => parts.find((p) => p.type === kind)?.value;
    if (
      weekdays[meeting.weekday - 1] === part("weekday") &&
      meeting.time === part("hour") + ":" + part("minute")
    )
      return minutes;
  }
  return null;
}

export function supervisorTickSituation(input: {
  project: OrchestrationProject;
  threads: readonly OrchestrationThread[];
  since: string;
  now: number;
  pullRequests: readonly SupervisorPullRequest[];
  sourceErrors: readonly string[];
  errors: readonly { threadId: string; kind: string; summary: string; createdAt: string }[];
  escalations: readonly { threadId: string; decisionKey: string; createdAtMs: number }[];
  changes: readonly { threadId: string; occurredAt: string }[];
  meetingMinutes: number | null;
}) {
  const clip = (value: string | null | undefined, limit = 500) => value?.slice(0, limit) ?? null;
  const members = input.threads.filter(
    (t) => t.projectId === input.project.id && t.deletedAt === null,
  );
  const worker = (t: OrchestrationThread) => {
    const c = t.workjetConfig;
    const goal = c.schemaVersion === 2 ? c.goal : undefined;
    return {
      thread: t.id,
      title: clip(t.title),
      since: t.createdAt,
      lastTurn: t.latestTurn
        ? {
            state: t.latestTurn.state,
            requestedAt: t.latestTurn.requestedAt,
            completedAt: t.latestTurn.completedAt,
          }
        : null,
      status:
        t.session?.status === "error" || t.latestTurn?.state === "error"
          ? "error"
          : goal?.status === "blocked"
            ? "blocked"
            : t.session?.status === "running" ||
                t.session?.status === "starting" ||
                t.latestTurn?.state === "running"
              ? "running"
              : t.archivedAt !== null || goal?.status === "complete"
                ? "finished"
                : "waiting",
      goal: clip(goal?.objective ?? (c.schemaVersion === 2 ? c.team?.goal : undefined)),
      reason: clip(goal?.reason ?? t.session?.lastError),
      goalChangedSinceControl: goal != null && Date.parse(goal.updatedAt) > Date.parse(input.since),
      kanbanChangedSinceControl:
        goal?.kanban != null && Date.parse(goal.kanban.updatedAt) > Date.parse(input.since),
      kanban: goal?.kanban?.cards.map((card) => ({
        id: card.id,
        title: clip(card.title),
        status: card.status,
      })),
      changedAt: input.changes.filter((v) => v.threadId === t.id).map((v) => v.occurredAt),
    };
  };
  const text = JSON.stringify({
    project: { id: input.project.id, title: input.project.title },
    since: input.since,
    persistentWorkers: members
      .filter(
        (t) => t.workjetConfig.schemaVersion === 2 && t.workjetConfig.team?.role === "specialist",
      )
      .map(worker),
    oneShotWorkers: members.filter((t) => t.workjetConfig.role === "worker").map(worker),
    pullRequests: input.pullRequests.map((pr) => {
      const state = supervisorPullRequestState(pr);
      return {
        number: pr.number,
        title: clip(pr.title),
        url: pr.url,
        author: pr.author?.login ?? null,
        workerThread:
          members.find(
            (t) =>
              (t.workjetConfig.schemaVersion === 2 &&
                t.workjetConfig.role === "worker" &&
                t.workjetConfig.pullRequest?.url === pr.url) ||
              t.branch === pr.headRefName,
          )?.id ?? null,
        ageMinutes: Math.max(0, Math.floor((input.now - Date.parse(pr.createdAt)) / 60000)),
        updatedAt: pr.updatedAt,
        ci: state.red ? "red" : state.green ? "green" : "pending-or-unknown",
        readyUnmerged: state.ready,
        redWithoutMovement: state.red && Date.parse(pr.updatedAt) <= Date.parse(input.since),
      };
    }),
    escalations: input.escalations,
    errorsAndTimeouts: input.errors.map((e) => ({ ...e, summary: clip(e.summary) })),
    tokenBudget: null,
    minutesUntilNextRegularMeeting: input.meetingMinutes,
    sourceErrors: input.sourceErrors,
    limits: { pullRequests: 100, errors: 50, changes: 100 },
  });
  return text.length <= 62000
    ? text
    : text.slice(0, 62000) + "\nLagebild gekürzt: weitere Einträge im Projektverlauf.";
}
