import { lazy, Suspense, useState, type ReactNode } from "react";
import type { WorkjetThreadConfig, WorkjetThreadGoal } from "@workjet/contracts";
import { PauseIcon, PencilIcon, PlayIcon } from "lucide-react";

import { Button } from "./ui/button";
import { InlinePanel } from "./ui/inline-panel";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const WorkerKanban = lazy(() => import("./PersistentWorkerKanban"));

type LoopState = {
  readonly sessionStatus?: string | null | undefined;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
};
export type PersistentGoalChange = {
  readonly status: "active" | "paused";
  readonly objective?: string;
  readonly expectedRevision?: number;
};

export function persistentWorkerGoalState(goal: WorkjetThreadGoal, state: LoopState): string {
  if (goal.status === "complete") return "Abgeschlossen";
  if (goal.status === "paused") return "Pausiert";
  if (goal.status === "blocked") return "Blockiert";
  if (state.hasPendingApprovals) return "Wartet auf Freigabe";
  if (state.hasPendingUserInput) return "Wartet auf Eingabe";
  if (state.sessionStatus === "running") return "Läuft";
  if (state.sessionStatus === "error") return "Fehler";
  return goal.pendingContinuation ? "Eingereiht" : "Aktiv";
}

/** Feste Fehlerzeile neben dem Speichern; der Entwurf bleibt im Feld stehen. */
export const PERSISTENT_GOAL_SAVE_FAILED = "Ziel nicht gespeichert";

/** A retained team assignment is visible even before an explicit goal starts its loop. */
export function PersistentWorkerGoal({
  config,
  compact = false,
  onChangeGoal,
  disabled = false,
}: LoopState & {
  readonly config: WorkjetThreadConfig | null;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly onChangeGoal?: ((change: PersistentGoalChange) => Promise<boolean>) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [objective, setObjective] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (config?.schemaVersion !== 2 || config.team?.role !== "specialist") return null;
  const goal = config.goal;
  const text = goal?.objective ?? config.team.goal;
  if (compact) {
    return (
      <span
        className="mt-1 block min-w-0 text-xs font-normal"
        data-workjet-persistent-goal="compact"
      >
        <span className="block line-clamp-2 text-foreground/80" title={text}>
          {text}
        </span>
      </span>
    );
  }
  const change = async (input: PersistentGoalChange) => {
    if (busy || disabled || !onChangeGoal) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await onChangeGoal(input);
      if (saved) {
        setEditing(false);
        setObjective(null);
      } else {
        setError(PERSISTENT_GOAL_SAVE_FAILED);
      }
    } catch {
      setError(PERSISTENT_GOAL_SAVE_FAILED);
    } finally {
      setBusy(false);
    }
  };
  const board = goal?.kanban?.slideDocument ?? null;
  return (
    <section
      className="shrink-0 border-b border-border px-3 py-2 sm:px-5"
      aria-label="Ziel des Workers"
      data-workjet-persistent-goal="thread"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          className={expanded ? "order-last basis-full text-left" : "min-w-0 flex-1 text-left"}
          aria-expanded={expanded}
          aria-label={expanded ? "Ziel einklappen" : "Ziel aufklappen"}
          onClick={() => setExpanded((open) => !open)}
        >
          <span
            className={
              expanded
                ? "block whitespace-pre-wrap break-words text-[13.5px]"
                : "block truncate text-[13.5px]"
            }
            title={expanded ? undefined : text}
          >
            {text}
          </span>
        </button>
        {onChangeGoal ? (
          <div className="ms-auto flex shrink-0 items-center gap-0.5">
            {editing ? null : (
              <GoalIconButton
                label={goal ? "Ziel ändern" : "Ziel festlegen"}
                disabled={busy || disabled}
                onClick={() => {
                  setEditing(true);
                  setError(null);
                }}
              >
                <PencilIcon aria-hidden="true" />
              </GoalIconButton>
            )}
            {goal ? (
              <GoalIconButton
                label={goal.status === "active" ? "Pausieren" : "Fortsetzen"}
                disabled={busy || disabled}
                onClick={() =>
                  void change({
                    status: goal.status === "active" ? "paused" : "active",
                    expectedRevision: goal.revision,
                  })
                }
              >
                {goal.status === "active" ? (
                  <PauseIcon aria-hidden="true" />
                ) : (
                  <PlayIcon aria-hidden="true" />
                )}
              </GoalIconButton>
            ) : null}
          </div>
        ) : null}
      </div>
      {editing && onChangeGoal ? (
        <InlinePanel
          className="mt-2"
          triggerLabel={goal ? "Ziel ändern" : "Ziel festlegen"}
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditing(false);
              setObjective(null);
              setError(null);
            }
          }}
          submitLabel={busy ? "Speichert…" : goal ? "Ziel speichern" : "Ziel setzen und starten"}
          submitDisabled={disabled || !(objective ?? text).trim()}
          busy={busy}
          hideCollapseControl
          status={error}
          statusTone="error"
          onSubmit={() =>
            void change({
              objective: (objective ?? text).trim(),
              status: goal?.status === "paused" ? "paused" : "active",
              ...(goal ? { expectedRevision: goal.revision } : {}),
            })
          }
        >
          <Textarea
            autoFocus
            aria-label="Zieldefinition"
            maxLength={4096}
            rows={3}
            disabled={busy || disabled}
            value={objective ?? text}
            onChange={(event) => setObjective(event.target.value)}
          />
        </InlinePanel>
      ) : null}
      {error && !editing ? (
        <p className="mt-2 text-[12px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {board ? (
        <div className="mt-2 max-h-72 overflow-y-auto text-[12px]">
          <Suspense fallback={null}>
            <WorkerKanban snapshot={board} />
          </Suspense>
          {goal?.reason ? <p className="mt-1 whitespace-pre-wrap">{goal.reason}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function GoalIconButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
