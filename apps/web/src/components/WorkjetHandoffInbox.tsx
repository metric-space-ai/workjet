import type { ThreadId, WorkjetReceivedHandoff } from "@t3tools/contracts";
import type { ReactElement } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { cn } from "~/lib/utils";

/**
 * The RECEIVING side of the typed thread handoff (docs/workjet-plan.md → "…the
 * target machine continues in a new thread with any harness/LLM").
 *
 * A handoff arrives addressed to this MACHINE, not to a thread, so it has
 * nowhere to land in the thread list until somebody continues it. This section
 * is that waiting room, and it is deliberately small and literal:
 *
 * - It offers exactly one action, "Continue here", and only when the context
 *   snapshot is actually readable on this machine. A handoff whose bytes never
 *   arrived says so instead of showing a button that would fail.
 * - It never renders the snapshot. The text is seeded into the new thread by
 *   the server, from its own store; the client is not given a copy to preview.
 * - It states what the branch line can honestly state — a name, and whether the
 *   SOURCE repository had a remote configured — and never that anything was
 *   pushed or is fetchable.
 * - An already-continued handoff stays listed, showing the thread that
 *   continues it, because "this work moved there" is the fact an operator comes
 *   back looking for.
 */

export type WorkjetHandoffContinueState = "ready" | "busy" | "unavailable" | "continued";

export interface WorkjetHandoffRow {
  readonly handoffId: string;
  /** `workspace · environment · thread` of the thread that handed the work over. */
  readonly sourceLabel: string;
  readonly receivedAt: string;
  readonly note: string | null;
  readonly branchLabel: string | null;
  readonly snapshotByteLength: number;
  readonly continueState: WorkjetHandoffContinueState;
  readonly continuedThreadId: ThreadId | null;
}

/** `2026-08-19T10:00:00.000Z` → `2026-08-19`, the honest resolution for a list row. */
export function formatWorkjetHandoffDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/**
 * The branch line for a row.
 *
 * `remoteConfigured` is a statement about the SOURCE repository's configuration
 * and nothing else, so the label says that and stops. Claiming the branch is
 * "available" or "pushed" would be exactly the overstatement the contract was
 * shaped to avoid.
 */
export function formatWorkjetHandoffBranch(
  branch: WorkjetReceivedHandoff["branch"],
): string | null {
  if (branch === undefined) return null;
  const head = branch.headCommit === undefined ? "head unknown" : `head ${branch.headCommit}`;
  const remote = branch.remoteConfigured
    ? "source repo has a remote; nothing was pushed"
    : "source repo has no remote";
  return `${branch.branch} · ${head} · ${remote}`;
}

/** Bytes as a compact, honest size. A snapshot is small by construction. */
export function formatWorkjetSnapshotSize(byteLength: number): string {
  return byteLength < 1_024 ? `${byteLength} B` : `${Math.round(byteLength / 1_024)} KiB`;
}

/**
 * Pure derivation of the rows from the RPC result. Kept separate from the
 * component so the mapping — especially which handoffs are continuable — is
 * unit-testable without a DOM.
 */
export function buildWorkjetHandoffRows(input: {
  readonly handoffs: ReadonlyArray<WorkjetReceivedHandoff>;
  readonly busyHandoffId: string | null;
}): ReadonlyArray<WorkjetHandoffRow> {
  return input.handoffs.map((handoff) => {
    const continued = handoff.acceptedThreadId !== undefined;
    const continueState: WorkjetHandoffContinueState = continued
      ? "continued"
      : input.busyHandoffId === handoff.handoffId
        ? "busy"
        : handoff.snapshotAvailable
          ? "ready"
          : "unavailable";
    return {
      handoffId: handoff.handoffId,
      sourceLabel: `${handoff.sourceThread.environmentId} · ${handoff.sourceThread.threadId}`,
      receivedAt: formatWorkjetHandoffDate(handoff.receivedAt),
      note: handoff.note ?? null,
      branchLabel: formatWorkjetHandoffBranch(handoff.branch),
      snapshotByteLength: handoff.snapshotByteLength,
      continueState,
      continuedThreadId: handoff.acceptedThreadId ?? null,
    };
  });
}

export interface WorkjetHandoffInboxProps {
  readonly handoffs: ReadonlyArray<WorkjetReceivedHandoff>;
  /** The handoff whose continuation is in flight, if any. */
  readonly busyHandoffId?: string | null;
  /** The last refusal, rendered inline; the contract's own bounded sentence. */
  readonly error?: string | null;
  readonly onContinue: (handoffId: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

const CONTINUE_LABEL: Record<WorkjetHandoffContinueState, string> = {
  ready: "Continue here",
  busy: "Continuing…",
  unavailable: "Context missing",
  continued: "Open thread",
};

export function WorkjetHandoffInbox({
  handoffs,
  busyHandoffId = null,
  error = null,
  onContinue,
  onOpenThread,
}: WorkjetHandoffInboxProps): ReactElement | null {
  // Nothing arrived: the section renders nothing at all rather than an empty
  // box, exactly like the worker overview it sits beside.
  if (handoffs.length === 0) return null;
  const rows = buildWorkjetHandoffRows({ handoffs, busyHandoffId });

  return (
    <Collapsible
      defaultOpen
      data-testid="workjet-handoff-inbox"
      className="border-border/60 border-b px-3 py-2"
    >
      <CollapsibleTrigger
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-xs font-medium tracking-wide uppercase"
        data-testid="workjet-handoff-inbox-trigger"
      >
        Handoffs ({rows.length})
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="mt-1.5 flex flex-col gap-1" data-testid="workjet-handoff-inbox-list">
          {rows.map((row) => (
            <li
              key={row.handoffId}
              data-testid="workjet-handoff-row"
              data-handoff-id={row.handoffId}
              data-continue-state={row.continueState}
              className="flex flex-col gap-0.5 rounded-md px-2 py-1.5"
            >
              <span className="text-foreground truncate text-sm">{row.sourceLabel}</span>
              <span className="text-muted-foreground truncate text-xs">
                {`Received ${row.receivedAt} · snapshot ${formatWorkjetSnapshotSize(row.snapshotByteLength)}`}
              </span>
              {row.branchLabel ? (
                <span className="text-muted-foreground truncate font-mono text-[11px]">
                  {row.branchLabel}
                </span>
              ) : null}
              {row.note ? (
                <span className="text-muted-foreground line-clamp-2 text-xs">{row.note}</span>
              ) : null}
              {row.continueState === "unavailable" ? (
                <span className="text-muted-foreground text-[11px]">
                  The context snapshot did not arrive on this machine, so this handoff cannot be
                  continued here.
                </span>
              ) : null}
              <button
                type="button"
                data-testid="workjet-handoff-continue"
                disabled={row.continueState === "unavailable" || row.continueState === "busy"}
                onClick={() =>
                  row.continueState === "continued" && row.continuedThreadId !== null
                    ? onOpenThread(row.continuedThreadId)
                    : onContinue(row.handoffId)
                }
                className={cn(
                  "self-start rounded-md border px-2 py-0.5 text-[11px]",
                  "border-border/60 bg-card text-foreground hover:bg-accent/50",
                  "disabled:opacity-50",
                )}
              >
                {CONTINUE_LABEL[row.continueState]}
              </button>
            </li>
          ))}
        </ul>
        {error ? (
          <p data-testid="workjet-handoff-error" className="text-destructive pt-1 text-[11px]">
            {error}
          </p>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

export default WorkjetHandoffInbox;
