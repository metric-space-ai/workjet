import { lazy, Suspense, useState } from "react";
import type { WorkjetThreadConfig, WorkjetThreadGoal } from "@workjet/contracts";
import { PauseIcon, PencilIcon, PlayIcon } from "lucide-react";

import { Button } from "./ui/button";
import { InlinePanel } from "./ui/inline-panel";
import { Textarea } from "./ui/textarea";

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
        setError("Ziel nicht gespeichert, Entwurf bleibt erhalten");
      }
    } catch {
      setError("Ziel nicht gespeichert, Entwurf bleibt erhalten");
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
          aria-label={expanded ? "Ziel einklappen" : "Ziel aufklappen"}
          onClick={() => setExpanded((open) => !open)}
        >
          <span
            className={
              expanded ? "block whitespace-pre-wrap break-words text-sm" : "block truncate text-sm"
            }
            title={expanded ? undefined : text}
          >
            {text}
          </span>
        </button>
        {onChangeGoal ? (
          <div className="flex shrink-0 items-center gap-2">
            {editing ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={goal ? "Ziel ändern" : "Ziel festlegen"}
                disabled={busy || disabled}
                onClick={() => {
                  setEditing(true);
                  setError(null);
                }}
              >
                <PencilIcon aria-hidden="true" />
                {goal ? "Ändern" : "Ziel festlegen"}
              </Button>
            )}
            {goal ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
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
                {goal.status === "active" ? "Pausieren" : "Fortsetzen"}
              </Button>
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
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {board ? (
        <div className="mt-2 max-h-72 overflow-y-auto text-xs">
          <Suspense fallback={<p role="status">Mini-Kanban wird geladen…</p>}>
            <WorkerKanban snapshot={board} />
          </Suspense>
          {goal?.reason ? <p className="mt-1 whitespace-pre-wrap">{goal.reason}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
