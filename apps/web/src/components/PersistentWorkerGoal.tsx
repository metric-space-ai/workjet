import type { WorkjetThreadConfig, WorkjetThreadGoal } from "@workjet/contracts";

type LoopState = {
  readonly sessionStatus?: string | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
};

export function persistentWorkerGoalState(goal: WorkjetThreadGoal, state: LoopState): string {
  if (goal.status === "complete") return "Complete";
  if (goal.status === "paused") return "Paused";
  if (goal.status === "blocked") return "Blocked";
  if (state.hasPendingApprovals) return "Awaiting approval";
  if (state.hasPendingUserInput) return "Waiting for input";
  if (state.sessionStatus === "running") return "Running";
  return goal.pendingContinuation ? "Queued" : "Active";
}

/** Displays persisted goal/loop facts only; a completed turn is not verification. */
export function PersistentWorkerGoal({
  config,
  compact = false,
  ...state
}: LoopState & {
  readonly config: WorkjetThreadConfig | null;
  readonly compact?: boolean;
}) {
  if (config?.schemaVersion !== 2 || config.team?.role !== "specialist" || !config.goal) {
    return null;
  }
  const goal = config.goal;
  const status = persistentWorkerGoalState(goal, state);
  const counter = goal.kanban
    ? `Iteration ${goal.kanban.iteration}`
    : `Continuations ${goal.continuationCount}`;
  const summary = `${status} · ${counter}`;
  if (compact) {
    return (
      <span className="mt-1 block min-w-0 text-xs font-normal" data-workjet-persistent-goal="compact">
        <span className="block line-clamp-2 text-foreground/80" title={goal.objective}>{goal.objective}</span>
        <span className="block text-[11px] text-muted-foreground">{summary}</span>
      </span>
    );
  }
  return (
    <details className="shrink-0 border-b border-border px-3 py-2 sm:px-5" data-workjet-persistent-goal="thread">
      <summary className="cursor-pointer text-xs marker:text-muted-foreground">
        <span className="ml-1 font-medium">Goal</span>
        <span className="ml-2 text-muted-foreground">{summary} · Workjet loop</span>
        <span className="mt-1 block line-clamp-2 text-sm" title={goal.objective}>{goal.objective}</span>
      </summary>
      <div className="mt-2 max-h-36 space-y-1 overflow-y-auto text-xs text-muted-foreground">
        <p className="whitespace-pre-wrap text-foreground/80">{goal.objective}</p>
        <p>Saved goal · r{goal.revision} · <time dateTime={goal.updatedAt}>{new Intl.DateTimeFormat("en-GB", {
          dateStyle: "medium", timeStyle: "short",
        }).format(new Date(goal.updatedAt))}</time></p>
        {goal.reason ? <p className="whitespace-pre-wrap">Reported result / reason: {goal.reason}</p> : null}
        {goal.lastCompletedTurnId ? <p title={goal.lastCompletedTurnId}>Last recorded turn · {goal.lastCompletedTurnId}</p> : null}
      </div>
    </details>
  );
}
