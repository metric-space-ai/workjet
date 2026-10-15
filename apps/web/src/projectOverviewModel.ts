import { localizedThreadTitle } from "./localizedThreadTitle";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import { selectThreadsForProjectScope } from "@workjet/client-runtime/state/worker-overview";
import type { WorkjetJourFixeMeeting } from "@workjet/contracts";
import { projectKpiPresentation, type PromptedProjectKpis } from "./projectKpis";
import { exitModelPresentation } from "./projectExitModel";
import { resolveGalleryProjectOverview, type GalleryProject } from "./projectOverview";
import { projectTeamSectionOf } from "./lib/projectTeamSections";
import {
  PROJECT_OVERVIEW_TEXT,
  projectOverviewFormat,
  type ProjectOverviewLanguage,
} from "./projectOverviewText";

export type ProjectOverviewWorkerState =
  | "running"
  | "waiting"
  | "waitingSupervisor"
  | "missingSupervisor"
  | "supervisorTimedOut"
  | "asks"
  | "disrupted"
  | "stuck";
export type ProjectOverviewStatus = ProjectOverviewWorkerState | "completed";
export function projectOverviewStatusTone(state: ProjectOverviewStatus) {
  switch (state) {
    case "disrupted":
    case "stuck":
    case "missingSupervisor":
    case "supervisorTimedOut":
      return "red";
    case "asks":
    case "waitingSupervisor":
      return "blue";
    case "running":
      return "amber";
    case "completed":
      return "green";
    case "waiting":
      return "gray";
  }
}
/** Read-only #417 usage supplied by useProjectOverviewTokenBudgetSource. */
export type ProjectOverviewTokenBudgetSource = {
  readonly consumedTokens: number | null;
  readonly limitBillions: number | null;
  readonly partial?: boolean;
};
export function projectOverviewBudgetValue(
  source?: ProjectOverviewTokenBudgetSource | null,
): string {
  if (
    source?.consumedTokens == null ||
    !Number.isFinite(source.consumedTokens) ||
    source.consumedTokens < 0
  )
    return "—";
  const billions = new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const used = billions.format(source.consumedTokens / 1_000_000_000);
  const limit = source.limitBillions;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return used + " Mrd.";
  const percent = Math.floor(
    (source.consumedTokens / (Math.round(limit * 10) * 100_000_000)) * 100,
  );
  return `${used}/${billions.format(limit)} Mrd. (${source.partial ? "≥" : ""}${percent} %)`;
}
export function projectOverviewWorkerName(title: string, projectTitle: string) {
  const suffix = title.match(/\s*\((Codex|Claude(?: Code)?|Cursor|Grok|OpenCode)\)\s*$/iu);
  const withoutHarness = suffix ? title.slice(0, suffix.index).trim() : title.trim();
  const prefix = projectTitle.trim();
  const short = withoutHarness.toLowerCase().startsWith(prefix.toLowerCase())
    ? withoutHarness
        .slice(prefix.length)
        .replace(/^[\s·:–—-]+/u, "")
        .trim()
    : withoutHarness;
  return { name: localizedThreadTitle(short || withoutHarness), harness: suffix?.[1] ?? null };
}
/** Calendar date of the next configured weekly meeting, evaluated in its timezone. */
export function projectOverviewNextMeetingDate(
  recurring: NonNullable<GalleryProject["configuration"]>["jourFixe"],
  now: number,
) {
  if (!recurring) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: recurring.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const value = (key: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === key)?.value);
  const today = new Date(Date.UTC(value("year"), value("month") - 1, value("day")));
  const offset = (recurring.weekday - (today.getUTCDay() || 7) + 7) % 7;
  const [hour, minute] = recurring.time.split(":").map(Number);
  const passed = offset === 0 && value("hour") * 60 + value("minute") >= hour! * 60 + minute!;
  today.setUTCDate(today.getUTCDate() + offset + (passed ? 7 : 0));
  return today.toISOString().slice(0, 10);
}
/**
 * An open turn without any sign of life for this long counts as stuck. No
 * provider heartbeat reaches the client, so the brief's 120 s bound applies.
 */
export const PROJECT_OVERVIEW_LIVE_STALE_MS = 120_000;

type ProjectOverviewLiveThread = Pick<
  EnvironmentThreadShell,
  | "session"
  | "latestTurn"
  | "updatedAt"
  | "workjetConfig"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "backgroundLiveness"
  | "waitingOnSupervisor"
  | "workerDecisionProblem"
>;

/**
 * Newest evidence that the thread's turn is doing something. A skipped
 * control round only repeats the server's own "busy" guess and is no
 * evidence of work, so its bump of `updatedAt` does not count.
 */
export function projectOverviewLastSignOfLife(thread: ProjectOverviewLiveThread): number | null {
  const tick =
    thread.workjetConfig?.schemaVersion === 2 ? thread.workjetConfig.supervisorTick : undefined;
  const threadUpdate =
    tick?.outcome === "skipped-busy" && tick.lastTickAt === thread.updatedAt
      ? null
      : thread.updatedAt;
  const times = [
    thread.session?.updatedAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    threadUpdate,
  ]
    .map((at) => (at ? Date.parse(at) : Number.NaN))
    .filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

export function projectOverviewWorkerState(
  thread: ProjectOverviewLiveThread,
  now: number = Date.now(),
): ProjectOverviewWorkerState {
  if (thread.workerDecisionProblem === "missing-supervisor") return "missingSupervisor";
  if (thread.workerDecisionProblem === "timed-out") return "supervisorTimedOut";
  if (thread.waitingOnSupervisor) return "waitingSupervisor";
  if (thread.session?.status === "error") return "disrupted";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "asks";
  // Live in-process background work (subagents, workflows) is current by construction.
  if (thread.backgroundLiveness === "working") return "running";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    const lastSign = projectOverviewLastSignOfLife(thread);
    return lastSign !== null && now - lastSign <= PROJECT_OVERVIEW_LIVE_STALE_MS
      ? "running"
      : "stuck";
  }
  return "waiting";
}

/** Owner attention first: stuck or disrupted, then blocked, then questions, then running. */
export function projectOverviewAttentionRank(state: ProjectOverviewStatus): number {
  switch (state) {
    case "stuck":
    case "disrupted":
      return 0;
    case "missingSupervisor":
    case "supervisorTimedOut":
      return 1;
    case "asks":
    case "waitingSupervisor":
      return 2;
    case "running":
      return 3;
    case "waiting":
      return 4;
    case "completed":
      return 5;
  }
}

/** Stable sort by attention rank; equal ranks keep their incoming order. */
export function sortByAttention<T>(items: readonly T[], stateOf: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, rank: stateOf(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

export type ProjectOverviewSideSection = "live" | "goals" | "kpis" | "meeting";
/** Side column, action first: live/stuck, goals, KPIs, next meeting. Empty sections are left out. */
export function projectOverviewSideSections(present: {
  readonly live: boolean;
  readonly goals: boolean;
  readonly kpis: boolean;
  readonly meeting: boolean;
}): ProjectOverviewSideSection[] {
  return (["live", "goals", "kpis", "meeting"] as const).filter((section) => present[section]);
}
export function isRunningProjectOneShot(thread: EnvironmentThreadShell) {
  return (
    projectTeamSectionOf(thread) !== "workers" ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.backgroundLiveness === "working" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.waitingOnSupervisor ||
    thread.workerDecisionProblem != null
  );
}
export type ProjectOverviewFeedKind = "step" | "pr" | "meeting" | "goal" | "setup";
export type ProjectOverviewHistoryItem = {
  readonly id: string;
  readonly at: string;
  readonly sentence: string;
  readonly thread: EnvironmentThreadShell | undefined;
  readonly kind: ProjectOverviewFeedKind;
  readonly url?: string;
};
export type ProjectOverviewPr = {
  readonly url: string;
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly mergedAt?: string | null;
  /** Who opened the PR (GitHub login), when the source delivers it. */
  readonly author?: string | null;
  /** PR description, when the PR source delivers it. */
  readonly body?: string | null;
  /** Diff size, when the PR source delivers it. */
  readonly additions?: number | null;
  readonly deletions?: number | null;
  readonly changedFiles?: number | null;
};
export type ProjectOverviewGoal = {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly harness: string | null;
  readonly status: ProjectOverviewStatus;
  readonly state: string;
  readonly thread?: EnvironmentThreadShell;
};
export function projectGoalSentence(goal: string): string {
  const paragraph = goal.trim().split(/\n\s*\n/u)[0] ?? "";
  const normalized = paragraph
    .replace(/^#+\s*/u, "")
    .replace(/^\d+[.)]\s*/u, "")
    .replace(/^(?:Übergabe|Handoff)\s+[^:]+\.(?:md|txt)[^:]*:\s*/iu, "")
    .replace(/\([^)]*\)/gu, "")
    .replace(/\b[\w./-]+\.(?:md|rs|tsx?|jsx?|json|ya?ml|sh|py)\b/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.])/gu, "$1")
    .trim();
  const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(normalized);
  return sentences[Symbol.iterator]().next().value?.segment.trim() ?? normalized;
}
/** Only authoritative project scope, saved goals and evidenced values feed the owner overview. */
export function buildProjectOwnerOverview(input: {
  readonly project: GalleryProject;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly language: ProjectOverviewLanguage;
  readonly meeting?: WorkjetJourFixeMeeting | null;
  readonly kpis?: PromptedProjectKpis | null;
  readonly pullRequests?: readonly ProjectOverviewPr[];
  readonly openTaskCount?: number | null;
  readonly now?: number;
  readonly projectTokenBudgetSource?: ProjectOverviewTokenBudgetSource | null;
}) {
  const { project, language } = input;
  const text = PROJECT_OVERVIEW_TEXT[language];
  const local = project.local;
  const scoped = selectThreadsForProjectScope(
    input.threads,
    new Set(local ? [local.environmentId + ":" + local.id] : []),
  );
  const all = scoped.filter((thread) => thread.deletedAt == null);
  const members = all.filter((thread) => thread.archivedAt == null);
  const parents = members.filter((thread) => projectTeamSectionOf(thread) === "parents");
  const supervisors = members.filter((thread) => projectTeamSectionOf(thread) === "supervisor");
  const workers = members.filter(
    (thread) => projectTeamSectionOf(thread) === "workers" && isRunningProjectOneShot(thread),
  );
  const meeting = input.meeting?.project_id === project.id ? input.meeting : null;
  const confirmed = meeting?.todos?.status === "confirmed" ? meeting.todos : null;
  const goals: ProjectOverviewGoal[] = confirmed
    ? confirmed.items.map((item) => ({
        id: item.id,
        title: item.title,
        owner: item.owner ?? "",
        state: text.waiting,
        harness: null,
        status: "waiting",
      }))
    : parents.flatMap((thread) => {
        const team =
          thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
        const goal =
          thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.goal : undefined;
        const name = projectOverviewWorkerName(thread.title, project.title);
        const status: ProjectOverviewStatus =
          goal?.status === "complete"
            ? "completed"
            : goal?.status === "blocked"
              ? "disrupted"
              : goal?.status === "paused"
                ? "waiting"
                : projectOverviewWorkerState(thread, input.now);
        return (goal?.objective ?? team?.goal)?.trim()
          ? [
              {
                id: thread.environmentId + ":" + thread.id,
                title: projectGoalSentence(goal?.objective ?? team!.goal),
                owner: name.name,
                harness: name.harness ?? thread.session?.providerName ?? null,
                status,
                state: text[status],
                thread,
              },
            ]
          : [];
      });
  const lastMeeting =
    meeting?.state === "confirmed" && meeting.scheduled_at_ms <= (input.now ?? Date.now())
      ? meeting
      : null;
  const prs = [...new Map((input.pullRequests ?? []).map((pr) => [pr.url, pr])).values()];
  const merged = prs.filter((pr) => pr.state === "merged");
  const prsSince =
    lastMeeting &&
    input.pullRequests !== undefined &&
    merged.length > 0 &&
    merged.every((pr) => pr.mergedAt != null && Number.isFinite(Date.parse(pr.mergedAt)))
      ? merged.filter((pr) => Date.parse(pr.mergedAt!) >= lastMeeting.scheduled_at_ms).length
      : null;
  const overview = resolveGalleryProjectOverview(project);
  const metric =
    input.kpis?.project_id === project.id
      ? input.kpis.items
          .map((record, index) => projectKpiPresentation(record, project.id, index + 1))
          .find(
            (item) => (item.status === "ready" || item.status === "stale") && item.value !== "—",
          )
      : undefined;
  const configuredMetric = overview.slots.find(
    (slot) => slot?.kind === "metric" && !/^(sessions?|latency|errors?)$/iu.test(slot.label.trim()),
  );
  const primary = metric
    ? { label: metric.label ?? text.projectKpi, value: metric.value }
    : configuredMetric?.kind === "metric"
      ? {
          label: configuredMetric.label,
          value:
            String(configuredMetric.value) +
            (configuredMetric.unit ? " " + configuredMetric.unit : ""),
        }
      : null;
  const exit = exitModelPresentation(project.configuration?.exitModel, project.id);
  const savedGoals = parents.map((thread) =>
    thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.goal : undefined,
  );
  const openTaskCount =
    input.openTaskCount ??
    (!confirmed && savedGoals.length > 0 && savedGoals.every((goal) => goal !== undefined)
      ? savedGoals.filter((goal) => goal?.status !== "complete").length
      : null);
  const kpis = [
    {
      id: "project",
      label: primary?.label ?? text.projectKpi,
      value: primary?.value ?? "—",
      note: metric?.status === "stale" ? text.staleMetric : null,
    },
    {
      id: "prs",
      label: text.prs,
      value: prsSince === null ? "—" : String(prsSince),
      note: null,
    },
    {
      id: "tasks",
      label: text.openTasks,
      value: openTaskCount === null ? "—" : String(openTaskCount),
      note: null,
    },
    {
      id: "exit",
      label: text.exit,
      value: exit.assessment?.result ? exit.value : "—",
      note: null,
    },
    {
      id: "tokens",
      label: text.tokenBudget,
      value: projectOverviewBudgetValue(input.projectTokenBudgetSource),
      note:
        input.projectTokenBudgetSource?.consumedTokens != null &&
        input.projectTokenBudgetSource.partial
          ? text.partialUsage
          : null,
    },
  ];
  const history: ProjectOverviewHistoryItem[] = all.flatMap((thread) =>
    thread.latestTurn?.state === "completed" && thread.latestTurn.completedAt
      ? [
          {
            id: thread.environmentId + ":" + thread.id + ":turn",
            at: thread.latestTurn.completedAt,
            sentence: projectOverviewFormat(text.completedStep, {
              name: projectOverviewWorkerName(thread.title, project.title).name,
            }),
            thread,
            kind: "step" as const,
          },
        ]
      : [],
  );
  for (const pr of merged)
    if (pr.mergedAt && Number.isFinite(Date.parse(pr.mergedAt)))
      history.push({
        id: pr.url,
        at: pr.mergedAt,
        sentence: projectOverviewFormat(text.mergedEvent, { number: pr.number, title: pr.title }),
        thread: undefined,
        kind: "pr",
        url: pr.url,
      });
  if (lastMeeting)
    history.push({
      id: "meeting",
      at: new Date(lastMeeting.scheduled_at_ms).toISOString(),
      sentence: text.meetingCompleted,
      thread: undefined,
      kind: "meeting",
    });
  if (confirmed?.confirmed_at_ms)
    history.push({
      id: "todos:confirmed",
      at: new Date(confirmed.confirmed_at_ms).toISOString(),
      sentence: text.todosConfirmed,
      thread: undefined,
      kind: "goal",
    });
  const setup = all.filter((thread) => Number.isFinite(Date.parse(thread.createdAt)));
  if (setup.length) {
    const dates = setup
      .map((thread) => thread.createdAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const day = (at: string) =>
      new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
        day: "2-digit",
        month: "2-digit",
      }).format(new Date(at));
    const roles = (["supervisor", "parents", "workers"] as const).flatMap((role) => {
      const count = setup.filter((thread) => projectTeamSectionOf(thread) === role).length;
      const label =
        count === 1 && role !== "supervisor"
          ? role === "parents"
            ? text.parentSingular
            : text.workerSingular
          : text[role];
      return count ? [count + " " + label] : [];
    });
    history.push({
      id: "setup",
      at: dates.at(-1)!,
      sentence: projectOverviewFormat(text.setupGroup, {
        roles: roles.join(" + "),
        range:
          day(dates[0]!) === day(dates.at(-1)!)
            ? day(dates[0]!)
            : day(dates[0]!) + "–" + day(dates.at(-1)!),
      }),
      thread: undefined,
      kind: "setup",
    });
  }
  return {
    projectId: project.id,
    title: project.title,
    summary:
      project.configuration?.info?.summary?.trim() ||
      project.configuration?.info?.description?.trim() ||
      null,
    text,
    language,
    members,
    all,
    supervisors,
    parents,
    workers,
    goals,
    confirmed: confirmed !== null,
    confirmedAt: confirmed?.confirmed_at_ms ?? null,
    decisions: supervisors.filter(
      (thread) => thread.hasPendingApprovals || thread.hasPendingUserInput,
    ),
    disruptions: [...supervisors, ...parents, ...workers].filter(
      (thread) =>
        projectOverviewWorkerState(thread, input.now) === "disrupted" ||
        (thread.workjetConfig.schemaVersion === 2 &&
          thread.workjetConfig.goal?.status === "blocked"),
    ),
    escalations: [...parents, ...workers].filter(
      (thread) => thread.waitingOnSupervisor || thread.workerDecisionProblem != null,
    ),
    kpis,
    merged,
    history: history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 5),
    /** Everything for the feed, newest first (#overview-feed). */
    feed: history.slice(0, 40),
    lastMeeting,
    recurring: project.configuration?.jourFixe ?? null,
    nextMeetingDate: projectOverviewNextMeetingDate(
      project.configuration?.jourFixe,
      input.now ?? Date.now(),
    ),
    supervisorLumaId: project.configuration?.supervisorLumaId ?? null,
    supervisorTick: {
      createdAt: supervisors[0]?.createdAt ?? null,
      configuration: overview.supervisorTick,
      state:
        supervisors[0]?.workjetConfig.schemaVersion === 2
          ? supervisors[0].workjetConfig.supervisorTick
          : undefined,
    },
    ownerDecisions: confirmed?.confirmed_at_ms ? [text.todosConfirmed] : [],
    links: [
      { label: text.repository, url: overview.repositoryUrl },
      { label: text.website, url: overview.websiteUrl },
    ].flatMap((link) => (link.url ? [{ label: link.label, url: link.url }] : [])),
  };
}
export type ProjectOwnerOverview = ReturnType<typeof buildProjectOwnerOverview>;
