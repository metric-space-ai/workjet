import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronUpIcon, RefreshCwIcon } from "lucide-react";
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
    edit: (n: number) => `KPI ${n} bearbeiten`,
    close: "Schließen",
    prompt: (n: number) => `Satz für KPI ${n}`,
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
    edit: (n: number) => `Edit KPI ${n}`,
    close: "Close",
    prompt: (n: number) => `Sentence for KPI ${n}`,
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
  const status: ReactNode = !record
    ? "—"
    : dirty
      ? text.unsaved
      : metric?.status === "ready"
        ? text.ready
        : metric?.detail || "—";
  const shown = metric && !dirty ? metric.value : "—";
  const value = (
    <dd
      className={`order-first min-w-0 break-words text-[22px] leading-7 font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere] ${
        shown === "—" ? "text-muted-foreground" : ""
      }`}
      data-workjet-kpi-status={metric?.status ?? "unconfigured"}
      title={metric?.message ?? undefined}
    >
      {shown}
    </dd>
  );
  return (
    <div
      className={`flex min-w-0 flex-col gap-0.5 rounded-md motion-safe:transition-colors motion-safe:duration-200 ${
        expanded ? "col-span-3 -mx-1 bg-muted/50 px-1 py-1" : ""
      }`}
      data-workjet-project-card-slot={position}
      data-workjet-kpi-tile-expanded={expanded ? "" : undefined}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape") {
          event.stopPropagation();
          collapse();
        }
      }}
    >
      <div className="relative flex h-11.5 min-w-0 flex-col gap-0.5 pe-4">
        {/* One label line and a fixed slot height (48 px incl. the editor gap): the KPI
            strip has the same height on every card, so a gallery row stays flush. */}
        <dt
          className="min-h-4 min-w-0 break-words text-[11px] leading-4 text-muted-foreground line-clamp-1"
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
        <div
          id={editorId}
          className={`grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-200 motion-safe:ease-out ${
            expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
          inert={!expanded}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex flex-col gap-2 pt-2">
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
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span data-workjet-kpi-tile-status="">
                  {text.status}: {status}
                </span>
                <span className="ms-auto tabular-nums">
                  {draft.length}/{KPI_PROMPT_MAX}
                </span>
              </div>
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
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
                <Button
                  size="xs"
                  variant="ghost"
                  className="ms-auto"
                  onClick={collapse}
                  aria-label={text.close}
                >
                  <ChevronUpIcon aria-hidden="true" className="size-3.5" />
                  {text.close}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
