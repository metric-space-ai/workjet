import { useId, useState } from "react";
import {
  CtoxWorkjetProjectControlRequest,
  type CtoxWorkjetProjectMetadataProjection,
  type ProjectOverview,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { decodeOverviewDraft, overviewDraft } from "../projectOverview";
import { projectKpiPromptInputs, type PromptedProjectKpis, type SaveProjectKpiPrompts } from "../projectKpis";
import { ProjectKpiResult } from "./ProjectKpiResult";
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
  onCancel,
  kpis,
  onSaveKpis,
}: {
  readonly overview: ProjectOverview | null | undefined;
  readonly onSave: (next: ProjectOverview) => Promise<boolean>;
  readonly onArchive?: (() => Promise<boolean>) | undefined;
  readonly archived?: boolean;
  readonly onCancel?: (() => void) | undefined;
  readonly kpis?: PromptedProjectKpis | undefined;
  readonly onSaveKpis?: SaveProjectKpiPrompts | undefined;
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
  const scopedKpis = configuration?.id === kpis?.project_id ? kpis : undefined;
  const [initialKpis] = useState(scopedKpis);
  const initialPrompts = () => [0, 1, 2].map((index) => initialKpis?.items[index]?.prompt.prompt ?? "");
  const [prompts, setPrompts] = useState(initialPrompts);
  const canConfigureKpis = !!(
    configuration &&
    initialKpis &&
    scopedKpis &&
    onSaveKpis
  );
  const promptsChanged = prompts.some((prompt, index) => prompt !== initialPrompts()[index]);
  const cancel = () => {
    if (onCancel) return onCancel();
    setDraft(overviewDraft(overview));
    setInfo({
      description: configuration?.info?.description ?? "",
      goal: configuration?.info?.goal ?? "",
      phase: configuration?.info?.phase ?? "",
      status: configuration?.info?.status ?? "",
    });
    setMeeting({
      enabled: configuration?.jourFixe != null,
      weekday: configuration?.jourFixe?.weekday ?? 1,
      time: configuration?.jourFixe?.time ?? "09:00",
      timezone: configuration?.jourFixe?.timezone ?? "Europe/Berlin",
    });
    setPrompts(initialPrompts());
    setState({ pending: false, message: "" });
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
            message: "Check the URLs and meeting settings.",
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
          if (canConfigureKpis && promptsChanged && initialKpis && onSaveKpis) {
            const savedKpis = await onSaveKpis(
              projectKpiPromptInputs(prompts, initialKpis),
              initialKpis.revision,
            );
            if (!savedKpis) {
              setState({
                pending: false,
                message:
                  "Couldn’t save KPI prompts. Reopen project settings and try again.",
              });
              return;
            }
          }
          const saved = await onSave(next);
          if (saved) onCancel?.();
          setState({
            pending: false,
            message: saved
              ? "Project saved."
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
      <div className="grid items-center gap-x-3 gap-y-2 sm:grid-cols-[6rem_minmax(0,1fr)]">
        <label className="text-xs text-muted-foreground" htmlFor={`${id}-repository`}>
          Repository
        </label>
        <Input
          id={`${id}-repository`}
          type="url"
          maxLength={2048}
          value={draft.repositoryUrl ?? ""}
          onChange={(event) =>
            setDraft((current) => ({ ...current, repositoryUrl: event.target.value }))
          }
          placeholder="https://github.com/owner/repository"
          disabled={state.pending}
        />
        <label className="text-xs text-muted-foreground" htmlFor={`${id}-website`}>
          Website
        </label>
        <Input
          id={`${id}-website`}
          type="url"
          maxLength={2048}
          value={draft.websiteUrl}
          onChange={(event) =>
            setDraft((current) => ({ ...current, websiteUrl: event.target.value }))
          }
          placeholder="https://example.com"
          disabled={state.pending}
        />
        {configuration && onSaveConfiguration && (
          <>
            <span className="text-xs text-muted-foreground">Jour fixe</span>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem_minmax(0,1.2fr)] gap-2">
              <select
                aria-label="Jour fixe weekday"
                className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
                disabled={state.pending}
                value={meeting.enabled ? meeting.weekday : "none"}
                onChange={(event) =>
                  setMeeting((current) => ({
                    ...current,
                    enabled: event.target.value !== "none",
                    weekday:
                      event.target.value === "none" ? current.weekday : Number(event.target.value),
                  }))
                }
              >
                <option value="none">No meeting</option>
                {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map(
                  (day, index) => (
                    <option key={day} value={index + 1}>
                      {day}
                    </option>
                  ),
                )}
              </select>
              <Input
                aria-label="Jour fixe time"
                type="time"
                required={meeting.enabled}
                disabled={state.pending || !meeting.enabled}
                value={meeting.time}
                onChange={(event) =>
                  setMeeting((current) => ({ ...current, time: event.target.value }))
                }
              />
              <Input
                aria-label="Jour fixe timezone"
                required={meeting.enabled}
                disabled={state.pending || !meeting.enabled}
                value={meeting.timezone}
                onChange={(event) =>
                  setMeeting((current) => ({ ...current, timezone: event.target.value }))
                }
              />
            </div>
            <label className="text-xs text-muted-foreground" htmlFor={`${id}-description`}>
              Description
            </label>
            <Input
              id={`${id}-description`}
              maxLength={4096}
              value={info.description}
              disabled={state.pending}
              onChange={(event) =>
                setInfo((current) => ({ ...current, description: event.target.value }))
              }
            />
            <details className="sm:col-start-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Goal, phase and status
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="col-span-2 grid gap-1 text-xs">
                  Goal
                  <Input
                    maxLength={4096}
                    value={info.goal}
                    disabled={state.pending}
                    onChange={(event) =>
                      setInfo((current) => ({ ...current, goal: event.target.value }))
                    }
                  />
                </label>
                <label className="grid gap-1 text-xs">
                  Phase
                  <Input
                    maxLength={128}
                    value={info.phase}
                    disabled={state.pending}
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
                    disabled={state.pending}
                    onChange={(event) =>
                      setInfo((current) => ({ ...current, status: event.target.value }))
                    }
                  />
                </label>
              </div>
            </details>
          </>
        )}
      </div>
      <div className="grid gap-2 border-t border-border pt-3" data-workjet-prompted-kpis="">
        {([0, 1, 2] as const).map((index) => (
          <div
            key={index}
            className="grid items-center gap-2 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(8rem,0.6fr)]"
          >
            <label htmlFor={`${id}-kpi-${index}`} className="text-xs text-muted-foreground">
              KPI {index + 1}
            </label>
            <Input
              id={`${id}-kpi-${index}`}
              maxLength={1024}
              value={prompts[index]}
              placeholder="Describe the metric in one sentence"
              disabled={state.pending || !canConfigureKpis}
              onChange={(event) =>
                setPrompts((current) =>
                  current.map((prompt, slot) => (slot === index ? event.target.value : prompt)),
                )
              }
            />
            <ProjectKpiResult
              record={canConfigureKpis ? kpis?.items[index] : undefined}
              projectId={configuration?.id ?? ""}
              position={index + 1}
              draftPrompt={prompts[index] ?? ""}
            />
          </div>
        ))}
        {!canConfigureKpis && (
          <p className="text-xs text-muted-foreground" role="status">
            KPI prompts need the CTOX KPI service. Existing card values are retained.
          </p>
        )}
      </div>
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
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={state.pending}
          className="ml-auto"
          onClick={cancel}
        >
          Cancel
        </Button>
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
