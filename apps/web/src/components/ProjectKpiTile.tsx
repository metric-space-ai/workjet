import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { UNDO_DELETE_MS } from "../lib/undoableDelete";
import { ChevronUpIcon, RefreshCwIcon, XIcon } from "lucide-react";
import {
  projectKpiPresentation,
  projectKpiPromptInputs,
  type PromptedProjectKpis,
  type SaveProjectKpiPrompts,
} from "../projectKpis";
import { workjetUiLanguage } from "../workjetProjectControl";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";

export const KPI_PROMPT_MAX = 1_024;

const TEXT = {
  de: {
    edit: (n: number) => `Kennzahl ${n} bearbeiten`,
    title: (n: number) => `Kennzahl ${n}`,
    close: "Schließen",
    prompt: (n: number) => `Satz für Kennzahl ${n}`,
    placeholder: "Was soll diese Kennzahl messen?",
    saving: "Wird gespeichert …",
    saved: (n: number) => `Kennzahl ${n} gespeichert`,
    undo: "Rückgängig",
    refresh: "Neu berechnen",
    refreshing: "Wird berechnet …",
    saveFailed: "Nicht gespeichert.",
    refreshFailed: "Neuberechnung nicht erreichbar.",
    status: "Status",
    ready: "Aktuell",
    unsaved: "Nicht gespeichert",
  },
  en: {
    edit: (n: number) => `Edit metric ${n}`,
    title: (n: number) => `Metric ${n}`,
    close: "Close",
    prompt: (n: number) => `Sentence for metric ${n}`,
    placeholder: "What should this metric measure?",
    saving: "Saving …",
    saved: (n: number) => `Metric ${n} saved`,
    undo: "Undo",
    refresh: "Recalculate",
    refreshing: "Calculating …",
    saveFailed: "Not saved.",
    refreshFailed: "Recalculation not reachable.",
    status: "Status",
    ready: "Current",
    unsaved: "Not saved",
  },
} as const;

/**
 * Card label for a native KPI slot: the resolved label, else the KPI's own sentence
 * while it is not calculated yet, else nothing. Never a sentence about a state.
 */
export function projectKpiTileLabel(
  kpis: PromptedProjectKpis,
  projectId: string,
  index: number,
): string {
  const record = kpis.items[index];
  if (!record) return "";
  return projectKpiPresentation(record, projectId, index + 1).label ?? record.prompt.prompt.trim();
}

/**
 * One KPI tile on the project card. Clicking it expands the tile in place to edit
 * its sentence, see its status and recalculate; Esc, the chevron or saving collapse it.
 */
export function ProjectKpiTile({
  projectId,
  index,
  kpis,
  expanded,
  onExpandedChange,
  onSave,
  onRefresh,
}: {
  readonly projectId: string;
  readonly index: number;
  readonly kpis: PromptedProjectKpis;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onSave?: SaveProjectKpiPrompts | undefined;
  readonly onRefresh?: (() => Promise<boolean>) | undefined;
}) {
  const text = TEXT[workjetUiLanguage()];
  const position = index + 1;
  const record = kpis.items[index];
  const saved = record?.prompt.prompt ?? "";
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState<"save" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (expanded) fieldRef.current?.focus({ preventScroll: true });
  }, [expanded]);
  // Opening starts from the saved sentence; a background re-read must not overwrite typing.
  const expand = () => {
    setDraft(saved);
    setError(null);
    onExpandedChange(true);
  };
  const metric = record ? projectKpiPresentation(record, projectId, position, draft) : null;
  const label = projectKpiTileLabel(kpis, projectId, index);
  const editable = onSave !== undefined;
  const dirty = draft.trim() !== saved.trim();
  // Sofortspeichern (UI-Regel, #798): kein „Speichern“-Knopf. Der Satz wird kurz nach dem
  // Tippen und beim Zuklappen geschrieben; der Toast bietet „Rückgängig“ zum alten Satz.
  const latestKpis = useRef(kpis);
  latestKpis.current = kpis;
  const writePrompt = async (sentence: string, withUndo: boolean) => {
    if (!onSave) return false;
    const before = kpis.items.map((item) => item.prompt.prompt);
    const prompts = [...before];
    while (prompts.length <= index) prompts.push("");
    const previous = prompts[index] ?? "";
    prompts[index] = sentence;
    setBusy("save");
    setError(null);
    const ok = await onSave(projectKpiPromptInputs(prompts, kpis), kpis.revision);
    setBusy(null);
    if (!ok) {
      setError(text.saveFailed);
      return false;
    }
    if (withUndo) {
      const save = onSave;
      const restore = [...prompts];
      restore[index] = previous;
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: text.saved(position),
          timeout: UNDO_DELETE_MS,
          actionProps: {
            children: text.undo,
            onClick: () =>
              void save(
                projectKpiPromptInputs(restore, latestKpis.current),
                latestKpis.current.revision,
              ),
          },
        }),
      );
    }
    return true;
  };
  const save = async () => {
    if (!onSave || busy || !dirty) return;
    await writePrompt(draft, true);
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!expanded || !dirty) return;
    const timer = setTimeout(() => void saveRef.current(), 1_200);
    return () => clearTimeout(timer);
  }, [draft, expanded, dirty]);
  const collapse = () => {
    if (dirty) void save();
    onExpandedChange(false);
    toggleRef.current?.focus();
  };
  const refresh = async () => {
    if (!onRefresh || busy) return;
    setBusy("refresh");
    setError(null);
    const ok = await onRefresh();
    setBusy(null);
    if (!ok) setError(text.refreshFailed);
  };
  // Status only when something is wrong (Audit A-28); a healthy KPI needs no status line.
  const status: ReactNode = dirty
    ? null
    : metric?.status === "failed" || metric?.status === "missing_source"
      ? metric.detail
      : null;
  const shown = metric && !dirty ? metric.value : "—";
  const hasValue = shown !== "—";
  // UI-Vertrag §7 (#773): kein Zustandstext als Wert. Während der Berechnung steht ein
  // dezentes Skelett; nach Fehler oder ohne Wert fallen Wert und Beschriftung weg.
  const loading = !hasValue && record !== undefined && metric?.status === "resolving";
  const value = hasValue ? (
    <dd
      className="order-first min-w-0 break-words pe-4 text-[22px] leading-7 font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]"
      data-workjet-kpi-status={metric?.status ?? "unconfigured"}
      title={metric?.message ?? undefined}
    >
      {shown}
    </dd>
  ) : loading ? (
    <dd className="order-first min-w-0 pe-4" data-workjet-kpi-status="resolving" aria-busy="true">
      <Skeleton className="h-7 w-16 rounded" />
    </dd>
  ) : null;
  const nearLimit = draft.length >= KPI_PROMPT_MAX * 0.9;
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 rounded-md"
      data-workjet-project-card-slot={position}
      data-workjet-kpi-tile-expanded={expanded ? "" : undefined}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape") {
          event.stopPropagation();
          collapse();
        }
      }}
    >
      <div className="relative flex min-h-11.5 min-w-0 flex-col gap-0.5">
        {/* The label uses the full column width and up to two lines instead of an
            ellipsis; only the value keeps room for the chevron. */}
        {hasValue ? (
          <dt
            className="min-h-4 min-w-0 break-words text-[11px] leading-4 text-muted-foreground line-clamp-2"
            title={label || undefined}
          >
            {label}
          </dt>
        ) : loading ? (
          <dt className="min-h-4 min-w-0">
            <Skeleton className="h-3 w-20 rounded" />
          </dt>
        ) : null}
        {value}
        {editable && (
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={expanded}
            aria-controls={editorId}
            aria-label={label ? `${text.edit(position)}: ${label}` : text.edit(position)}
            onClick={() => (expanded ? collapse() : expand())}
            className="group absolute inset-0 flex cursor-pointer items-start justify-end rounded hover:bg-muted/40 focus-visible:outline focus-visible:outline-ring"
            data-workjet-action={`project.kpis.tile:${projectId}:${position}`}
          >
            <ChevronUpIcon
              aria-hidden="true"
              className={`mt-1 size-3.5 text-muted-foreground motion-safe:transition-[transform,opacity] motion-safe:duration-200 ${
                expanded
                  ? ""
                  : "rotate-180 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              }`}
            />
          </button>
        )}
      </div>
      {editable && (
        // Overlay on the project card (its nearest positioned ancestor): the editor never
        // grows the card or the gallery row (Audit A-30).
        <div
          id={editorId}
          className={`absolute inset-0 z-20 flex flex-col gap-2 overflow-y-auto bg-card p-3 motion-safe:transition-opacity motion-safe:duration-200 ${
            expanded ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          data-workjet-kpi-tile-editor=""
          inert={!expanded}
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted-foreground">
              {text.title(position)}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={collapse}
              aria-label={text.close}
              title={text.close}
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
          <Textarea
            ref={fieldRef}
            value={draft}
            maxLength={KPI_PROMPT_MAX}
            rows={3}
            aria-label={text.prompt(position)}
            placeholder={text.placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void save();
              }
            }}
          />
          {status !== null || nearLimit ? (
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              {status !== null ? (
                <span data-workjet-kpi-tile-status="" className="text-destructive-foreground">
                  {status}
                </span>
              ) : null}
              {nearLimit ? (
                <span className="ms-auto tabular-nums">
                  {draft.length}/{KPI_PROMPT_MAX}
                </span>
              ) : null}
            </div>
          ) : null}
          {error && (
            <p role="alert" className="text-[12px] text-destructive-foreground">
              {error}
            </p>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-2">
            {busy === "save" ? (
              <span className="text-[12px] text-muted-foreground" aria-live="polite">
                {text.saving}
              </span>
            ) : null}
            {onRefresh && record && (
              <Button
                size="xs"
                variant="outline"
                disabled={dirty || busy !== null}
                onClick={() => void refresh()}
                data-workjet-action={`project.kpis.refresh:${projectId}`}
              >
                <RefreshCwIcon
                  aria-hidden="true"
                  className={`size-3.5 ${busy === "refresh" ? "motion-safe:animate-spin" : ""}`}
                />
                {busy === "refresh" ? text.refreshing : text.refresh}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
