import type { WorkjetThreadConfig } from "@workjet/contracts";

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
    return { label: "Needs attention", dot: "bg-amber-400" };
  if (thread.session?.status === "error") return { label: "Error", dot: "bg-red-400" };
  if (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.backgroundLiveness === "working"
  )
    return { label: "Working", dot: "bg-emerald-400" };
  if (thread.backgroundLiveness === "monitoring")
    return { label: "Monitoring", dot: "bg-blue-400" };
  return { label: "Idle", dot: "bg-muted-foreground/50" };
}
