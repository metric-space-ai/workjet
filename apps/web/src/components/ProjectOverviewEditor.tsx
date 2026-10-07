import { useId, useState } from "react";
import type { ProjectOverview } from "@workjet/contracts";
import { decodeOverviewDraft, overviewDraft, type OverviewSlotDraft } from "../projectOverview";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function ProjectOverviewEditor({ overview, onSave, onArchive, archived = false }: {
  readonly overview: ProjectOverview | null | undefined;
  readonly onSave: (next: ProjectOverview) => Promise<boolean>;
  readonly onArchive?: (() => Promise<boolean>) | undefined;
  readonly archived?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => overviewDraft(overview));
  const [state, setState] = useState({ pending: false, message: "" });
  const editSlot = (index: 0 | 1 | 2, change: Partial<OverviewSlotDraft>) => {
    setState({ pending: false, message: "" });
    setDraft((current) => {
      const slots = [...current.slots] as typeof current.slots;
      slots[index] = { ...slots[index], ...change };
      return { ...current, slots };
    });
  };
  return (
    <form className="grid gap-3" data-workjet-project-overview-editor="" onSubmit={async (event) => {
      event.preventDefault();
      if (state.pending) return;
      let next: ProjectOverview;
      try { next = decodeOverviewDraft(draft); }
      catch { setState({ pending: false, message: "Check labels, values and URLs. Metrics need a finite number." }); return; }
      setState({ pending: true, message: "" });
      try {
        const saved = await onSave(next);
        setState({ pending: false, message: saved ? "Overview saved." : "Couldn’t save the overview. Reconnect and try again." });
      } catch { setState({ pending: false, message: "Couldn’t save the overview. Reconnect and try again." }); }
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs" htmlFor={`${id}-repository`}>
          Repository
          <Input id={`${id}-repository`} type="url" maxLength={2048} value={draft.repositoryUrl ?? ""}
            onChange={(event) => { setState({ pending: false, message: "" }); setDraft((current) => ({ ...current, repositoryUrl: event.target.value })); }}
            placeholder="https://github.com/owner/repository" disabled={state.pending} />
        </label>
        <label className="grid gap-1 text-xs" htmlFor={`${id}-website`}>
          Website
          <Input id={`${id}-website`} type="url" maxLength={2048} value={draft.websiteUrl}
            onChange={(event) => { setState({ pending: false, message: "" }); setDraft((current) => ({ ...current, websiteUrl: event.target.value })); }}
            placeholder="https://example.com" disabled={state.pending} />
        </label>
      </div>
      {([0, 1, 2] as const).map((index) => {
        const slot = draft.slots[index];
        const prefix = `${id}-${index}`;
        return (
          <fieldset key={index} className="grid grid-cols-2 gap-2 border-t border-border pt-2 sm:grid-cols-[8rem_1fr_1fr]" disabled={state.pending}>
            <legend className="text-xs font-medium">KPI {index + 1}</legend>
            <label htmlFor={`${prefix}-type`} className="grid gap-1 text-xs">
              Type
              <select id={`${prefix}-type`} aria-label={`KPI ${index + 1} type`} className="h-8 rounded-md border border-input bg-background px-2" value={slot.kind}
                onChange={(event) => editSlot(index, { kind: event.target.value as OverviewSlotDraft["kind"] })}>
                <option value="empty">Empty</option><option value="text">Text</option><option value="link">Link</option>
                <option value="updated">Project update age</option><option value="metric">Entered metric</option>
              </select>
            </label>
            {slot.kind !== "empty" && (
              <label htmlFor={`${prefix}-label`} className="grid gap-1 text-xs">
                Label
                <Input id={`${prefix}-label`} aria-label={`KPI ${index + 1} label`} maxLength={96} value={slot.label} required
                  onChange={(event) => editSlot(index, { label: event.target.value })} />
              </label>
            )}
            {slot.kind !== "empty" && slot.kind !== "updated" && (
              <label htmlFor={`${prefix}-value`} className="col-span-2 grid gap-1 text-xs sm:col-span-1">
                {slot.kind === "link" ? "URL" : "Value"}
                <Input id={`${prefix}-value`} aria-label={`KPI ${index + 1} value`} type={slot.kind === "link" ? "url" : slot.kind === "metric" ? "number" : "text"}
                  step={slot.kind === "metric" ? "any" : undefined} maxLength={slot.kind === "link" ? 2048 : 512} value={slot.value} required
                  onChange={(event) => editSlot(index, { value: event.target.value })} />
              </label>
            )}
            {slot.kind === "metric" && (
              <label htmlFor={`${prefix}-unit`} className="col-start-2 grid gap-1 text-xs sm:col-start-3">
                Unit
                <Input id={`${prefix}-unit`} aria-label={`KPI ${index + 1} unit`} maxLength={32} value={slot.unit}
                  onChange={(event) => editSlot(index, { unit: event.target.value })} />
              </label>
            )}
          </fieldset>
        );
      })}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-popover pt-3">
        {onArchive && (
          <Button type="button" size="sm" variant="outline" disabled={state.pending} onClick={async () => {
            setState({ pending: true, message: "" });
            try {
              const saved = await onArchive();
              setState({ pending: false, message: saved ? "" : "Couldn’t save the project. Try again." });
            } catch { setState({ pending: false, message: "Couldn’t save the project. Try again." }); }
          }}>{archived ? "Restore project" : "Archive project"}</Button>
        )}
        <Button type="submit" size="sm" disabled={state.pending}>{state.pending ? "Saving…" : "Save overview"}</Button>
        <p className="text-xs text-muted-foreground" role="status">{state.message}</p>
      </div>
    </form>
  );
}
