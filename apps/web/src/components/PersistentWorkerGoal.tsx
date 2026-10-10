import { lazy, Suspense, useState } from "react";
import type { WorkjetThreadConfig, WorkjetThreadGoal } from "@workjet/contracts";

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
  ...state
}: LoopState & {
  readonly config: WorkjetThreadConfig | null;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly onChangeGoal?: (change: PersistentGoalChange) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (config?.schemaVersion !== 2 || config.team?.role !== "specialist") return null;
  const goal = config.goal;
  const text = goal?.objective ?? config.team.goal;
  const counter = goal ? `Durchlauf ${goal.continuationCount}` : "Schleife nicht gestartet";
  const summary = `${goal ? persistentWorkerGoalState(goal, state) : "Ziel noch nicht gesetzt"} · ${counter}`;
  if (compact) {
    return (
      <span className="mt-1 block min-w-0 text-xs font-normal" data-workjet-persistent-goal="compact">
        <span className="block line-clamp-2 text-foreground/80" title={text}>{text}</span>
        <span className="block text-[11px] text-muted-foreground">{summary}</span>
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
        setError("Das Ziel konnte nicht gespeichert werden. Der Entwurf bleibt erhalten.");
      }
    } catch {
      setError("Das Ziel konnte nicht gespeichert werden. Der Entwurf bleibt erhalten.");
    } finally {
      setBusy(false);
    }
  };
  const currentBoard = goal?.kanban?.goalRevision === goal?.revision &&
    goal?.kanban?.iteration === goal?.continuationCount;
  return (
    <section className="shrink-0 border-b border-border px-3 py-2 sm:px-5" aria-label="Persistent-Worker-Ziel"
      data-workjet-persistent-goal="thread">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">Ziel · <span className="text-muted-foreground">{summary}</span></p>
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm" title={text}>{text}</p>
        </div>
        {onChangeGoal ? (
          <div className="flex shrink-0 flex-wrap gap-2 text-xs">
            <button type="button" disabled={busy || disabled} className="underline underline-offset-2"
              onClick={() => { setEditing(!editing); setError(null); }}>
              {editing ? "Abbrechen" : goal ? "Ziel ändern" : "Ziel festlegen"}
            </button>
            {goal ? (
              <button type="button" disabled={busy || disabled} className="underline underline-offset-2"
                onClick={() => void change({
                  status: goal.status === "active" ? "paused" : "active", expectedRevision: goal.revision,
                })}>
                {goal.status === "active" ? "Pausieren" : "Fortsetzen"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {editing ? (
        <form className="mt-2 grid gap-2" onSubmit={(event) => {
          event.preventDefault();
          void change({
            objective: (objective ?? text).trim(),
            status: goal?.status === "paused" ? "paused" : "active",
            ...(goal ? { expectedRevision: goal.revision } : {}),
          });
        }}>
          <label className="text-xs">
            Zieldefinition
            <textarea className="mt-1 block w-full rounded border border-border bg-background p-2 text-sm"
              aria-label="Zieldefinition" maxLength={4096} required rows={3} disabled={busy || disabled}
              value={objective ?? text} onChange={(event) => setObjective(event.target.value)} />
          </label>
          <div className="flex items-center gap-3 text-xs">
            <button type="submit" className="rounded border border-border px-2 py-1"
              disabled={busy || disabled || !(objective ?? text).trim()}>
              {busy ? "Wird gespeichert…" : goal ? "Ziel speichern" : "Ziel setzen und starten"}
            </button>
            <span className="text-muted-foreground">Gespeichert für diesen Worker; kein Abschlussnachweis.</span>
          </div>
        </form>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
      {goal ? (
        <details open className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Mini-Kanban · {goal.kanban ? `Durchlauf ${goal.kanban.iteration}` : "noch nicht aktualisiert"}
            {goal.kanban && !currentBoard ? " · vorheriger Stand" : ""}
          </summary>
          <div className="mt-2 max-h-72 overflow-y-auto">
            {goal.kanban?.slideDocument ? (
              <Suspense fallback={<p role="status">Mini-Kanban wird geladen…</p>}>
                <WorkerKanban snapshot={goal.kanban.slideDocument} />
              </Suspense>
            ) : (
              <p className="text-muted-foreground">
                Für diesen Durchlauf liegt noch kein Slide-Engine-Board vor. Der Worker aktualisiert es am Beginn des Durchlaufs.
              </p>
            )}
            <p className="mt-2 text-muted-foreground">
              Ziel gespeichert · Revision {goal.revision} · <time dateTime={goal.updatedAt}>
                {new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(goal.updatedAt))}
              </time>
            </p>
            {goal.reason ? <p className="mt-1 whitespace-pre-wrap">{goal.reason}</p> : null}
          </div>
        </details>
      ) : <p className="mt-1 text-xs text-muted-foreground">Der gespeicherte Team-Auftrag startet noch keine Zielschleife.</p>}
    </section>
  );
}
