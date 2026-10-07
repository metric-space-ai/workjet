import { PROVIDER_DISPLAY_NAMES, type WorkjetThreadConfig } from "@workjet/contracts";

type TeamThread = { readonly workjetConfig: WorkjetThreadConfig };

export type ProjectTeamSection = "supervisor" | "parents" | "workers" | "other";

/** Sidebar order for an opened project: its supervisor, the long-lived parents, then one-time PR workers. */
export const PROJECT_TEAM_SECTIONS = [
  {
    section: "supervisor",
    label: "Supervisor",
    empty: "Opening the project creates its supervisor.",
  },
  { section: "parents", label: "Parents", empty: "No parent workers yet." },
  { section: "workers", label: "Workers", empty: "No running workers." },
] as const satisfies ReadonlyArray<{
  readonly section: Exclude<ProjectTeamSection, "other">;
  readonly label: string;
  readonly empty: string;
}>;

export function projectTeamSectionOf(thread: TeamThread): ProjectTeamSection {
  const config = thread.workjetConfig;
  const role = config.schemaVersion === 2 ? config.team?.role : undefined;
  if (role === "supervisor") return "supervisor";
  if (role === "specialist") return "parents";
  if (role === "worker") return "workers";
  return "other";
}

/** Keeps the incoming order inside each section. */
export function groupThreadsByProjectTeam<T extends TeamThread>(
  threads: readonly T[],
): Record<ProjectTeamSection, T[]> {
  const groups: Record<ProjectTeamSection, T[]> = {
    supervisor: [],
    parents: [],
    workers: [],
    other: [],
  };
  for (const thread of threads) groups[projectTeamSectionOf(thread)].push(thread);
  return groups;
}

/** One native-state status mapping shared by the project overview and sidebar. */
export function projectTeamStatus(thread: {
  readonly session: { readonly status: string } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly backgroundLiveness?: string | null | undefined;
}) {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput)
    return { label: "Needs attention", dot: "bg-rose-400" };
  if (thread.session?.status === "error") return { label: "Error", dot: "bg-red-400" };
  if (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.backgroundLiveness === "working"
  )
    return { label: "Working", dot: "bg-amber-400" };
  if (thread.backgroundLiveness === "monitoring")
    return { label: "Monitoring", dot: "bg-blue-400" };
  return { label: "Idle", dot: "bg-muted-foreground/50" };
}

export function projectTeamProgressPreview(thread: {
  readonly latestTurn?: { readonly assistantMessagePreview?: string | undefined } | null;
  readonly planProgress?: { readonly step: string } | null;
}) {
  const assistant = thread.latestTurn?.assistantMessagePreview?.replace(/\s+/gu, " ").trim();
  return assistant || thread.planProgress?.step.trim() || "";
}

export function projectTeamHarnessLabel(thread: {
  readonly session?: { readonly providerName?: string | null } | null;
  readonly modelSelection: { readonly instanceId: string };
}) {
  const name = thread.session?.providerName ?? thread.modelSelection.instanceId;
  return Object.entries(PROVIDER_DISPLAY_NAMES).find(([provider]) => provider === name)?.[1] ?? name;
}

export function duplicateProjectTeamTitles(threads: readonly { readonly title: string }[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const thread of threads) {
    if (seen.has(thread.title)) duplicates.add(thread.title);
    seen.add(thread.title);
  }
  return duplicates;
}
