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
  | "disrupted";
export type ProjectOverviewStatus = ProjectOverviewWorkerState | "completed";
export function projectOverviewStatusTone(state: ProjectOverviewStatus) {
  switch (state) {
    case "disrupted":
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
  return { name: short || withoutHarness, harness: suffix?.[1] ?? null };
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
export function projectOverviewWorkerState(
  thread: Pick<
    EnvironmentThreadShell,
    | "session"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "backgroundLiveness"
    | "waitingOnSupervisor"
    | "workerDecisionProblem"
  >,
): ProjectOverviewWorkerState {
  if (thread.workerDecisionProblem === "missing-supervisor") return "missingSupervisor";
  if (thread.workerDecisionProblem === "timed-out") return "supervisorTimedOut";
  if (thread.waitingOnSupervisor) return "waitingSupervisor";
  if (thread.session?.status === "error") return "disrupted";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "asks";
  if (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.backgroundLiveness === "working"
  )
    return "running";
  return "waiting";
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
export type ProjectOverviewPr = {
  readonly url: string;
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly mergedAt?: string | null;
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
        owner: item.owner ?? text.unknown,
        state: text.unknown,
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
                : projectOverviewWorkerState(thread);
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
  const history = all.flatMap((thread) =>
    thread.latestTurn?.state === "completed" && thread.latestTurn.completedAt
      ? [
          {
            id: thread.environmentId + ":" + thread.id + ":turn",
            at: thread.latestTurn.completedAt,
            sentence: projectOverviewFormat(text.completedStep, {
              name: projectOverviewWorkerName(thread.title, project.title).name,
            }),
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
      });
  if (lastMeeting)
    history.push({
      id: "meeting",
      at: new Date(lastMeeting.scheduled_at_ms).toISOString(),
      sentence: text.meetingCompleted,
    });
  if (confirmed?.confirmed_at_ms)
    history.push({
      id: "todos:confirmed",
      at: new Date(confirmed.confirmed_at_ms).toISOString(),
      sentence: text.todosConfirmed,
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
        range: day(dates[0]!) + "–" + day(dates.at(-1)!),
      }),
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
        projectOverviewWorkerState(thread) === "disrupted" ||
        (thread.workjetConfig.schemaVersion === 2 &&
          thread.workjetConfig.goal?.status === "blocked"),
    ),
    escalations: [...parents, ...workers].filter(
      (thread) => thread.waitingOnSupervisor || thread.workerDecisionProblem != null,
    ),
    kpis,
    merged,
    history: history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 5),
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
