import { useId, useState } from "react";
import type { ProjectOverview } from "@workjet/contracts";
import { decodeOverviewDraft, overviewDraft, type OverviewSlotDraft } from "../projectOverview";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function ProjectOverviewEditor({
  overview,
  onSave,
}: {
  readonly overview: ProjectOverview | null | undefined;
  readonly onSave: (next: ProjectOverview) => Promise<boolean>;
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
    <form
      className="grid gap-4"
      data-workjet-project-overview-editor=""
      onSubmit={async (event) => {
        event.preventDefault();
        if (state.pending) return;
        let next: ProjectOverview;
        try {
          next = decodeOverviewDraft(draft);
        } catch {
          setState({
            pending: false,
            message:
              "Check the field labels, values and HTTP or HTTPS URLs. Metrics need a finite number.",
          });
          return;
        }
        setState({ pending: true, message: "" });
        try {
          const saved = await onSave(next);
          setState({
            pending: false,
            message: saved
              ? "Overview saved."
              : "Couldn’t save the overview. Reconnect and try again.",
          });
        } catch {
          setState({
            pending: false,
            message: "Couldn’t save the overview. Reconnect and try again.",
          });
        }
      }}
    >
      <label className="grid gap-1 text-sm" htmlFor={`${id}-repository`}>
        Repository (optional)
        <Input
          id={`${id}-repository`}
          type="url"
          maxLength={2048}
          value={draft.repositoryUrl ?? ""}
          onChange={(event) => {
            setState({ pending: false, message: "" });
            setDraft((current) => ({ ...current, repositoryUrl: event.target.value }));
          }}
          placeholder="https://github.com/owner/repository"
          disabled={state.pending}
        />
        <span className="text-xs text-muted-foreground">
          Save a repository link for this project. This does not change its checkout or website.
        </span>
      </label>
      <label className="grid gap-1 text-sm" htmlFor={`${id}-website`}>
        Website (optional)
        <Input
          id={`${id}-website`}
          type="url"
          maxLength={2048}
          value={draft.websiteUrl}
          onChange={(event) => {
            setState({ pending: false, message: "" });
            setDraft((current) => ({ ...current, websiteUrl: event.target.value }));
          }}
          placeholder="https://example.com"
          disabled={state.pending}
        />
      </label>
      {([0, 1, 2] as const).map((index) => {
        const slot = draft.slots[index];
        const prefix = `${id}-${index}`;
        return (
          <fieldset
            key={index}
            className="grid gap-2 rounded-lg border border-border p-3"
            disabled={state.pending}
          >
            <legend className="px-1 text-xs font-medium">KPI {index + 1}</legend>
            <label htmlFor={`${prefix}-type`} className="grid gap-1 text-sm">
              Type
              <select
                id={`${prefix}-type`}
                aria-label={`KPI ${index + 1} type`}
                className="h-8 rounded-md border border-input bg-background px-2"
                value={slot.kind}
                onChange={(event) =>
                  editSlot(index, { kind: event.target.value as OverviewSlotDraft["kind"] })
                }
              >
                <option value="empty">Empty</option>
                <option value="text">Text</option>
                <option value="link">Link</option>
                <option value="updated">Project update age</option>
                <option value="metric">Entered metric</option>
              </select>
            </label>
            {slot.kind !== "empty" && (
              <label htmlFor={`${prefix}-label`} className="grid gap-1 text-sm">
                Label
                <Input
                  id={`${prefix}-label`}
                  aria-label={`KPI ${index + 1} label`}
                  maxLength={96}
                  value={slot.label}
                  required
                  onChange={(event) => editSlot(index, { label: event.target.value })}
                />
              </label>
            )}
            {slot.kind !== "empty" && slot.kind !== "updated" && (
              <label htmlFor={`${prefix}-value`} className="grid gap-1 text-sm">
                {slot.kind === "link" ? "URL" : "Value"}
                <Input
                  id={`${prefix}-value`}
                  aria-label={`KPI ${index + 1} value`}
                  type={slot.kind === "link" ? "url" : slot.kind === "metric" ? "number" : "text"}
                  step={slot.kind === "metric" ? "any" : undefined}
                  maxLength={slot.kind === "link" ? 2048 : 512}
                  value={slot.value}
                  required
                  onChange={(event) => editSlot(index, { value: event.target.value })}
                />
              </label>
            )}
            {slot.kind === "metric" && (
              <label htmlFor={`${prefix}-unit`} className="grid gap-1 text-sm">
                Unit (optional)
                <Input
                  id={`${prefix}-unit`}
                  aria-label={`KPI ${index + 1} unit`}
                  maxLength={32}
                  value={slot.unit}
                  onChange={(event) => editSlot(index, { unit: event.target.value })}
                />
              </label>
            )}
          </fieldset>
        );
      })}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={state.pending}>
          {state.pending ? "Saving…" : "Save overview"}
        </Button>
        <p className="text-xs text-muted-foreground" role="status">
          {state.message}
        </p>
      </div>
    </form>
  );
}
