import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import { selectThreadsForProjectScope } from "@workjet/client-runtime/state/worker-overview";
import type { WorkjetJourFixeMeeting } from "@workjet/contracts";
import { projectKpiPresentation, type PromptedProjectKpis } from "./projectKpis";
import { exitModelPresentation } from "./projectExitModel";
import { resolveGalleryProjectOverview, type GalleryProject } from "./projectOverview";
import { projectTeamSectionOf } from "./lib/projectTeamSections";
import { PROJECT_OVERVIEW_TEXT, type ProjectOverviewLanguage } from "./projectOverviewText";

export type ProjectOverviewWorkerState =
  | "running"
  | "waiting"
  | "waitingSupervisor"
  | "asks"
  | "disrupted";
export function projectOverviewWorkerState(
  thread: Pick<
    EnvironmentThreadShell,
    | "session"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "backgroundLiveness"
    | "waitingOnSupervisor"
  >,
): ProjectOverviewWorkerState {
  if (thread.waitingOnSupervisor) return "waitingSupervisor";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "asks";
  if (thread.session?.status === "error") return "disrupted";
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
    thread.hasPendingUserInput
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
  return (
    new Intl.Segmenter(undefined, { granularity: "sentence" })
      .segment(normalized)
      [Symbol.iterator]()
      .next()
      .value?.segment.trim() ?? normalized
  );
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
      }))
    : parents.flatMap((thread) => {
        const team =
          thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
        const goal =
          thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.goal : undefined;
        return (goal?.objective ?? team?.goal)?.trim()
          ? [
              {
                id: thread.environmentId + ":" + thread.id,
                title: projectGoalSentence(goal?.objective ?? team!.goal),
                owner: thread.title,
                state:
                  goal?.status === "complete"
                    ? text.completed
                    : goal?.status === "blocked"
                      ? text.disrupted
                      : goal?.status === "paused"
                        ? text.waiting
                        : text[projectOverviewWorkerState(thread)],
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
    ? { label: metric.label, value: metric.value }
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
      value: primary?.value ?? null,
      explanation: primary
        ? (metric?.status === "stale" ? text.staleMetric + " " : "") + text.unavailableDelta
        : text.unavailableKpi,
    },
    {
      id: "prs",
      label: text.prs,
      value: prsSince === null ? null : String(prsSince),
      explanation: prsSince === null ? text.unavailablePrs : text.unavailableDelta,
    },
    {
      id: "tasks",
      label: text.openTasks,
      value: openTaskCount === null ? null : String(openTaskCount),
      explanation:
        openTaskCount === null
          ? text.unavailableTasks
          : (language === "de"
              ? "Gespeicherte Worker-Ziele, die noch nicht erledigt sind. "
              : "Saved worker goals that are not complete. ") + text.unavailableDelta,
    },
    {
      id: "exit",
      label: text.exit,
      value: exit.assessment?.result ? exit.value : null,
      explanation: exit.assessment?.result ? text.unavailableDelta : text.unavailableExit,
    },
  ];
  const history = all
    .filter((thread) => projectTeamSectionOf(thread) !== "workers")
    .flatMap((thread) => {
      const role = text[projectTeamSectionOf(thread)];
      const events = [
        {
          id: thread.id + ":created",
          at: thread.createdAt,
          sentence:
            language === "de"
              ? thread.title + " wurde als " + role + " angelegt."
              : thread.title + " was created as a " + role + ".",
        },
      ];
      if (thread.latestTurn?.state === "completed" && thread.latestTurn.completedAt)
        events.push({
          id: thread.id + ":turn",
          at: thread.latestTurn.completedAt,
          sentence:
            language === "de"
              ? thread.title + " hat den letzten Arbeitsschritt abgeschlossen."
              : thread.title + " completed its latest work step.",
        });
      return events;
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 10);
  return {
    projectId: project.id,
    title: project.title,
    summary:
      project.configuration?.info?.summary?.trim() ||
      project.configuration?.info?.description?.trim() ||
      text.noSummary,
    text,
    language,
    members,
    all,
    supervisors,
    parents,
    workers,
    goals,
    confirmed: confirmed !== null,
    decisions: supervisors.filter(
      (thread) => thread.hasPendingApprovals || thread.hasPendingUserInput,
    ),
    disruptions: [...supervisors, ...parents, ...workers].filter(
      (thread) => projectOverviewWorkerState(thread) === "disrupted",
    ),
    kpis,
    merged,
    history,
    lastMeeting,
    recurring: project.configuration?.jourFixe ?? null,
    supervisorLumaId: project.configuration?.supervisorLumaId ?? null,
    ownerDecisions: confirmed?.confirmed_at_ms
      ? [
          language === "de"
            ? "Du hast die To-do-Liste des Jour fixe bestätigt."
            : "You confirmed the Jour fixe's to-do list.",
        ]
      : [],
    links: [
      { label: text.repository, url: overview.repositoryUrl },
      { label: text.website, url: overview.websiteUrl },
    ].flatMap((link) => (link.url ? [{ label: link.label, url: link.url }] : [])),
  };
}
export type ProjectOwnerOverview = ReturnType<typeof buildProjectOwnerOverview>;
