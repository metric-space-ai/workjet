import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronUpIcon, RefreshCwIcon, XIcon } from "lucide-react";
import {
  projectKpiPresentation,
  projectKpiPromptInputs,
  type PromptedProjectKpis,
  type SaveProjectKpiPrompts,
} from "../projectKpis";
import { workjetUiLanguage } from "../workjetProjectControl";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export const KPI_PROMPT_MAX = 1_024;

const TEXT = {
  de: {
    edit: (n: number) => `Kennzahl ${n} bearbeiten`,
    title: (n: number) => `Kennzahl ${n}`,
    close: "Schließen",
    checking: "prüft…",
    prompt: (n: number) => `Satz für Kennzahl ${n}`,
    placeholder: "Was soll diese Kennzahl messen?",
    save: "Speichern",
    saving: "Speichern …",
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
    checking: "checking…",
    prompt: (n: number) => `Sentence for metric ${n}`,
    placeholder: "What should this metric measure?",
    save: "Save",
    saving: "Saving …",
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
  const collapse = () => {
    onExpandedChange(false);
    toggleRef.current?.focus();
  };
  const save = async () => {
    if (!onSave || busy) return;
    const prompts = kpis.items.map((item) => item.prompt.prompt);
    while (prompts.length <= index) prompts.push("");
    prompts[index] = draft;
    setBusy("save");
    setError(null);
    const ok = await onSave(projectKpiPromptInputs(prompts, kpis), kpis.revision);
    setBusy(null);
    if (ok) collapse();
    else setError(text.saveFailed);
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
  // Without a value a defined KPI shows the stable chip „prüft…“ instead of a bare label
  // (UI contract §7, Audit A-27); an undefined slot shows nothing.
  const value =
    shown === "—" ? (
      record ? (
        <dd className="order-first min-w-0" data-workjet-kpi-status={metric?.status ?? "pending"}>
          <span className="inline-flex h-7 items-center text-[11px] text-muted-foreground">
            {text.checking}
          </span>
        </dd>
      ) : null
    ) : (
      <dd
        className="order-first min-w-0 break-words pe-4 text-[22px] leading-7 font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]"
        data-workjet-kpi-status={metric?.status ?? "unconfigured"}
        title={metric?.message ?? undefined}
      >
        {shown}
      </dd>
    );
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
        <dt
          className={`min-h-4 min-w-0 break-words text-[11px] leading-4 text-muted-foreground line-clamp-2 ${
            value === null ? "pe-4" : ""
          }`}
          title={label || undefined}
        >
          {label}
        </dt>
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
            <Button size="xs" disabled={!dirty || busy !== null} onClick={() => void save()}>
              {busy === "save" ? text.saving : text.save}
            </Button>
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
