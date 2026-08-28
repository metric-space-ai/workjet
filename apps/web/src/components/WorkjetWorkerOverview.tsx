import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { selectWorkersForOrchestrator } from "@t3tools/client-runtime/state/worker-overview";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ReactElement } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { cn } from "~/lib/utils";

/**
 * View model for one worker-thread row in the orchestrator overview. Everything
 * here is derived read-only from the thread shell already present in client
 * state — no server round-trip is added for this surface.
 */
export interface WorkerOverviewRow {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  /** Model id from the thread's model selection (always present). */
  readonly model: string;
  /**
   * Provider/harness binding from the live session, when the worker has one.
   * `null` when no session is bound yet — omitted honestly rather than guessed.
   */
  readonly providerName: string | null;
  /**
   * Environment/computer label. The client thread shell carries the
   * environment id but no separate computer name, so the environment id is the
   * honest label here.
   */
  readonly environmentLabel: string;
  readonly turnState: WorkerTurnState;
}

export type WorkerTurnState = "idle" | "running" | "interrupted" | "completed" | "error";

interface WorkerTurnPresentation {
  readonly label: string;
  readonly dotClass: string;
  readonly pulse: boolean;
}

const WORKER_TURN_PRESENTATION: Record<WorkerTurnState, WorkerTurnPresentation> = {
  idle: { label: "Idle", dotClass: "bg-muted-foreground/40", pulse: false },
  running: { label: "Running", dotClass: "bg-amber-500 dark:bg-amber-300/90", pulse: true },
  completed: {
    label: "Completed",
    dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
    pulse: false,
  },
  interrupted: {
    label: "Interrupted",
    dotClass: "bg-orange-500 dark:bg-orange-300/90",
    pulse: false,
  },
  error: { label: "Error", dotClass: "bg-red-500 dark:bg-red-300/90", pulse: false },
};

export function resolveWorkerTurnState(
  thread: Pick<EnvironmentThreadShell, "latestTurn" | "session">,
): WorkerTurnState {
  // A live session in flight is the strongest "running" signal, even before the
  // latest turn record catches up.
  const sessionStatus = thread.session?.status;
  if (sessionStatus === "running" || sessionStatus === "starting") {
    return "running";
  }
  const state = thread.latestTurn?.state;
  if (!state) {
    return "idle";
  }
  return state;
}

/**
 * Pure derivation of the orchestrator overview rows from the thread list. Kept
 * separate from the component so the mapping is unit-testable without a DOM.
 */
export function buildWorkerOverviewRows(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
  orchestratorThreadId: ThreadId,
): ReadonlyArray<WorkerOverviewRow> {
  return selectWorkersForOrchestrator(threads, environmentId, orchestratorThreadId).map(
    (worker) => ({
      environmentId: worker.environmentId,
      threadId: worker.id,
      title: worker.title,
      model: worker.modelSelection.model,
      providerName: worker.session?.providerName ?? null,
      environmentLabel: worker.environmentId,
      turnState: resolveWorkerTurnState(worker),
    }),
  );
}

export interface WorkjetWorkerOverviewProps {
  readonly environmentId: EnvironmentId;
  readonly orchestratorThreadId: ThreadId;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onOpenWorker: (ref: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
}

/**
 * Orchestrator-scoped worker overview: an additive, collapsible "Workers (N)"
 * section listing the child worker threads dispatched from the currently-open
 * orchestrator thread. Each row links to the ordinary worker thread.
 *
 * This surface never replaces the normal thread list — every worker remains an
 * ordinary thread in the sidebar. When the open thread is not an orchestrator
 * (or owns no workers), the section renders nothing.
 */
export function WorkjetWorkerOverview({
  environmentId,
  orchestratorThreadId,
  threads,
  onOpenWorker,
}: WorkjetWorkerOverviewProps): ReactElement | null {
  const rows = buildWorkerOverviewRows(threads, environmentId, orchestratorThreadId);
  if (rows.length === 0) {
    return null;
  }

  return (
    <Collapsible
      defaultOpen
      data-testid="workjet-worker-overview"
      className="border-border/60 border-b px-3 py-2"
    >
      <CollapsibleTrigger
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-xs font-medium tracking-wide uppercase"
        data-testid="workjet-worker-overview-trigger"
      >
        Workers ({rows.length})
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="mt-1.5 flex flex-col gap-0.5" data-testid="workjet-worker-overview-list">
          {rows.map((row) => {
            const presentation = WORKER_TURN_PRESENTATION[row.turnState];
            return (
              <li key={row.threadId} data-thread-item>
                <button
                  type="button"
                  data-testid="workjet-worker-row"
                  data-worker-thread-id={row.threadId}
                  onClick={() =>
                    onOpenWorker({ environmentId: row.environmentId, threadId: row.threadId })
                  }
                  className="hover:bg-sidebar-row-hover focus-visible:ring-ring flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left select-none focus-visible:ring-1 focus-visible:ring-inset"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        presentation.dotClass,
                        presentation.pulse && "animate-pulse",
                      )}
                    />
                    <span className="text-foreground truncate text-sm">{row.title}</span>
                    <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                      {presentation.label}
                    </span>
                  </span>
                  <span className="text-muted-foreground truncate pl-4 text-xs">
                    {row.providerName ? `${row.providerName} · ${row.model}` : row.model}
                    <span className="px-1">·</span>
                    {row.environmentLabel}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export default WorkjetWorkerOverview;
