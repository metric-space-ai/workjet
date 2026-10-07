import { useId, useState } from "react";
import {
  CtoxWorkjetProjectControlRequest,
  type CtoxWorkjetProjectMetadataProjection,
  type ProjectOverview,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { decodeOverviewDraft, overviewDraft, type OverviewSlotDraft } from "../projectOverview";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const decodeProjectConfiguration = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, {
  onExcessProperty: "error",
});

export type ProjectConfigurationValues = Pick<
  Extract<CtoxWorkjetProjectControlRequest, { readonly action: "project.configure" }>,
  "repoUrl" | "publicUrl" | "info" | "jourFixe"
>;

export function ProjectOverviewEditor({
  overview,
  onSave,
  onArchive,
  archived = false,
  configuration,
  onSaveConfiguration,
}: {
  readonly overview: ProjectOverview | null | undefined;
  readonly onSave: (next: ProjectOverview) => Promise<boolean>;
  readonly onArchive?: (() => Promise<boolean>) | undefined;
  readonly archived?: boolean;
  readonly configuration?: CtoxWorkjetProjectMetadataProjection | undefined;
  readonly onSaveConfiguration?:
    | ((next: ProjectConfigurationValues) => Promise<boolean>)
    | undefined;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => overviewDraft(overview));
  const [state, setState] = useState({ pending: false, message: "" });
  const [info, setInfo] = useState(() => ({
    description: configuration?.info?.description ?? "",
    goal: configuration?.info?.goal ?? "",
    phase: configuration?.info?.phase ?? "",
    status: configuration?.info?.status ?? "",
  }));
  const [meeting, setMeeting] = useState(() => ({
    enabled: configuration?.jourFixe != null,
    weekday: configuration?.jourFixe?.weekday ?? 1,
    time: configuration?.jourFixe?.time ?? "09:00",
    timezone: configuration?.jourFixe?.timezone ?? "Europe/Berlin",
  }));
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
      className="grid gap-3"
      data-workjet-project-overview-editor=""
      onSubmit={async (event) => {
        event.preventDefault();
        if (state.pending) return;
        let next: ProjectOverview;
        let metadata: ProjectConfigurationValues | undefined;
        try {
          next = decodeOverviewDraft(draft);
          if (configuration && onSaveConfiguration) {
            const validated = decodeProjectConfiguration({
              action: "project.configure",
              commandId: "validate-project-configuration",
              projectId: configuration.id,
              title: configuration.title,
              repoUrl: next.repositoryUrl ?? null,
              publicUrl: next.websiteUrl,
              info,
              jourFixe: meeting.enabled
                ? {
                    weekday: meeting.weekday,
                    time: meeting.time,
                    timezone: meeting.timezone.trim(),
                  }
                : null,
            });
            if (validated.action !== "project.configure") throw new Error("Invalid configuration");
            metadata = {
              repoUrl: validated.repoUrl ?? null,
              publicUrl: validated.publicUrl ?? null,
              info: validated.info ?? null,
              jourFixe: validated.jourFixe ?? null,
            };
          }
        } catch {
          setState({
            pending: false,
            message: "Check labels, values and URLs. Metrics need a finite number.",
          });
          return;
        }
        setState({ pending: true, message: "" });
        try {
          if (metadata && onSaveConfiguration && !(await onSaveConfiguration(metadata))) {
            setState({
              pending: false,
              message: "Couldn’t save project settings. Reconnect and try again.",
            });
            return;
          }
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
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs" htmlFor={`${id}-repository`}>
          Repository
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
        </label>
        <label className="grid gap-1 text-xs" htmlFor={`${id}-website`}>
          Website
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
      </div>
      {configuration && onSaveConfiguration && (
        <>
          <fieldset className="grid gap-2 border-t border-border pt-2" disabled={state.pending}>
            <legend className="text-xs font-medium">Project info</legend>
            <label className="grid gap-1 text-xs">
              Short description
              <Input
                maxLength={4096}
                value={info.description}
                onChange={(event) =>
                  setInfo((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>
            <label className="grid gap-1 text-xs">
              Goal
              <textarea
                className="min-h-16 rounded-md border border-input bg-background px-3 py-2 text-sm"
                maxLength={4096}
                value={info.goal}
                onChange={(event) =>
                  setInfo((current) => ({ ...current, goal: event.target.value }))
                }
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-xs">
                Phase
                <Input
                  maxLength={128}
                  value={info.phase}
                  onChange={(event) =>
                    setInfo((current) => ({ ...current, phase: event.target.value }))
                  }
                />
              </label>
              <label className="grid gap-1 text-xs">
                Status
                <Input
                  maxLength={128}
                  value={info.status}
                  onChange={(event) =>
                    setInfo((current) => ({ ...current, status: event.target.value }))
                  }
                />
              </label>
            </div>
          </fieldset>
          <fieldset className="grid gap-2 border-t border-border pt-2" disabled={state.pending}>
            <legend className="text-xs font-medium">Weekly meeting</legend>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={meeting.enabled}
                onChange={(event) =>
                  setMeeting((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
              Enable recurring meeting
            </label>
            {meeting.enabled && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <label className="grid gap-1 text-xs">
                  Weekday
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2"
                    value={meeting.weekday}
                    onChange={(event) =>
                      setMeeting((current) => ({ ...current, weekday: Number(event.target.value) }))
                    }
                  >
                    {[
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                      "Sunday",
                    ].map((day, index) => (
                      <option key={day} value={index + 1}>
                        {day}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs">
                  Time
                  <Input
                    type="time"
                    required
                    value={meeting.time}
                    onChange={(event) =>
                      setMeeting((current) => ({ ...current, time: event.target.value }))
                    }
                  />
                </label>
                <label className="col-span-2 grid gap-1 text-xs sm:col-span-1">
                  Timezone
                  <Input
                    required
                    value={meeting.timezone}
                    onChange={(event) =>
                      setMeeting((current) => ({ ...current, timezone: event.target.value }))
                    }
                  />
                </label>
              </div>
            )}
          </fieldset>
        </>
      )}
      {([0, 1, 2] as const).map((index) => {
        const slot = draft.slots[index];
        const prefix = `${id}-${index}`;
        return (
          <fieldset
            key={index}
            className="grid grid-cols-2 gap-2 border-t border-border pt-2 sm:grid-cols-[8rem_1fr_1fr]"
            disabled={state.pending}
          >
            <legend className="text-xs font-medium">KPI {index + 1}</legend>
            <label htmlFor={`${prefix}-type`} className="grid gap-1 text-xs">
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
              <label htmlFor={`${prefix}-label`} className="grid gap-1 text-xs">
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
              <label
                htmlFor={`${prefix}-value`}
                className="col-span-2 grid gap-1 text-xs sm:col-span-1"
              >
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
              <label
                htmlFor={`${prefix}-unit`}
                className="col-start-2 grid gap-1 text-xs sm:col-start-3"
              >
                Unit
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
      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-popover pt-3">
        {onArchive && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={state.pending}
            onClick={async () => {
              setState({ pending: true, message: "" });
              try {
                const saved = await onArchive();
                setState({
                  pending: false,
                  message: saved ? "" : "Couldn’t save the project. Try again.",
                });
              } catch {
                setState({ pending: false, message: "Couldn’t save the project. Try again." });
              }
            }}
          >
            {archived ? "Restore project" : "Archive project"}
          </Button>
        )}
        <Button type="submit" size="sm" disabled={state.pending}>
          {state.pending ? "Saving…" : "Save project"}
        </Button>
        <p className="text-xs text-muted-foreground" role="status">
          {state.message}
        </p>
      </div>
    </form>
  );
}
