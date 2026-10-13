import { useId, useState, type ReactNode } from "react";
import {
  CtoxWorkjetProjectControlRequest,
  DEFAULT_SUPERVISOR_TICK_CONFIGURATION,
  type CtoxWorkjetProjectMetadataProjection,
  type ProjectOverview,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { decodeOverviewDraft, overviewDraft, websiteDraftChange } from "../projectOverview";
import { parseTokenBudgetBillions } from "@workjet/shared/projectTokenBudget";
import { deferTokenBudgetCalendarSource } from "../projectTokenBudgetSource";
import {
  projectKpiPromptInputs,
  type PromptedProjectKpis,
  type SaveProjectKpiPrompts,
} from "../projectKpis";
import { ProjectKpiResult } from "./ProjectKpiResult";
import { ProjectMeetingPreparationField } from "./ProjectMeetingPreparationField";
import { ProjectSupervisorLumaSelect, type LumaFieldProps } from "./ProjectSupervisorLumaField";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { workjetUiLanguage } from "../workjetProjectControl";

const decodeProjectConfiguration = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, {
  onExcessProperty: "error",
});

/** Werte der Karten-Rückseite „Projekt konfigurieren“ (Name, Website, Repository, Regeltermin). */
export type ProjectCardConfigurationValues = {
  readonly title: string;
  readonly websiteUrl: string | null;
  readonly repositoryUrl: string | null;
  readonly jourFixe: { weekday: number; time: string; timezone: string } | null;
};

const WEEKDAY_LABELS = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
] as const;

/**
 * Dichte Rückseite der Galeriekarte. Speichert über denselben Pfad wie
 * Einstellungen › Projekt (project.configure bzw. Projektübersicht).
 */
export function ProjectCardConfigEditor({
  title,
  websiteUrl,
  repositoryUrl,
  jourFixe,
  canEditTitle = false,
  onSave,
  onCancel,
}: {
  readonly title: string;
  readonly websiteUrl: string | null;
  readonly repositoryUrl: string | null;
  readonly jourFixe: { weekday: number; time: string; timezone: string } | null;
  /** Nur der Instanz-Pfad (project.configure) trägt den Namen; sonst gesperrt. */
  readonly canEditTitle?: boolean | undefined;
  readonly onSave: (values: ProjectCardConfigurationValues) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ProjectCardConfigurationValues>(() => ({
    title,
    websiteUrl,
    repositoryUrl,
    jourFixe,
  }));
  const [state, setState] = useState({ pending: false, message: "" });
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex size-full min-h-0 flex-col"
      data-workjet-project-card-config=""
      onSubmit={async (event) => {
        event.preventDefault();
        if (state.pending) return;
        for (const url of [draft.websiteUrl, draft.repositoryUrl])
          if (url)
            try {
              new URL(url);
            } catch {
              setError("Vollständige Adresse mit https:// eintragen.");
              return;
            }
        if (draft.title.trim() === "") {
          setError("Name eintragen.");
          return;
        }
        setError(null);
        setState({ pending: true, message: "" });
        try {
          const saved = await onSave({
            title: draft.title.trim(),
            websiteUrl: draft.websiteUrl?.trim() ? draft.websiteUrl.trim() : null,
            repositoryUrl: draft.repositoryUrl?.trim() ? draft.repositoryUrl.trim() : null,
            jourFixe: draft.jourFixe,
          });
          setState({ pending: false, message: saved ? "Gespeichert" : "Nicht gespeichert" });
          if (saved) onCancel();
        } catch {
          setState({ pending: false, message: "Nicht gespeichert" });
        }
      }}
    >
      {/* Dicht: Felder tragen ihre Bezeichnung als Platzhalter; die Knopfzeile
          bleibt unten stehen, auch wenn der Inhalt intern scrollt. */}
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        <div className="grid grid-cols-2 gap-1.5 pr-8">
          <Input
            aria-label="Projektname"
            size="sm"
            maxLength={256}
            required
            placeholder="Name"
            disabled={state.pending || !canEditTitle}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
          <Input
            aria-label="Website"
            size="sm"
            type="url"
            maxLength={2048}
            placeholder="https://example.com"
            disabled={state.pending}
            value={draft.websiteUrl ?? ""}
            onChange={(event) => setDraft({ ...draft, websiteUrl: event.target.value || null })}
          />
        </div>
        <Input
          aria-label="Repository"
          size="sm"
          type="url"
          maxLength={2048}
          placeholder="https://github.com/owner/repository"
          disabled={state.pending}
          value={draft.repositoryUrl ?? ""}
          onChange={(event) => setDraft({ ...draft, repositoryUrl: event.target.value || null })}
        />
        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-1.5">
          <select
            aria-label="Regeltermin Wochentag"
            className="h-7.5 min-w-0 rounded-md border border-input bg-background px-2 text-xs sm:h-6.5"
            disabled={state.pending}
            value={draft.jourFixe?.weekday ?? "none"}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                jourFixe:
                  event.target.value === "none"
                    ? null
                    : {
                        weekday: Number(event.target.value),
                        time: current.jourFixe?.time ?? "09:00",
                        timezone: current.jourFixe?.timezone ?? "Europe/Berlin",
                      },
              }))
            }
          >
            <option value="none">Kein Termin</option>
            {WEEKDAY_LABELS.map((day, index) => (
              <option key={day} value={index + 1}>
                {day}
              </option>
            ))}
          </select>
          <Input
            aria-label="Regeltermin Uhrzeit"
            size="sm"
            type="time"
            required={draft.jourFixe !== null}
            disabled={state.pending || draft.jourFixe === null}
            value={draft.jourFixe?.time ?? ""}
            onChange={(event) =>
              setDraft((current) =>
                current.jourFixe === null
                  ? current
                  : { ...current, jourFixe: { ...current.jourFixe, time: event.target.value } },
              )
            }
          />
        </div>
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <div
        className="flex flex-none items-center gap-1.5 border-t border-border px-2 py-1.5"
        data-workjet-project-card-config-actions=""
      >
        <Button type="submit" size="xs" disabled={state.pending}>
          {state.pending ? "Speichern …" : "Speichern"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={state.pending}
          onClick={onCancel}
        >
          Abbrechen
        </Button>
        <p
          className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground"
          role="status"
        >
          {state.message}
        </p>
      </div>
    </form>
  );
}

export type ProjectConfigurationValues = Pick<
  Extract<CtoxWorkjetProjectControlRequest, { readonly action: "project.configure" }>,
  "repoUrl" | "publicUrl" | "info" | "jourFixe" | "supervisorLumaId"
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
  kpisLoadFailed = false,
  renderLumaField,
}: {
  readonly overview: ProjectOverview | null | undefined;
  readonly onSave: (next: ProjectOverview) => Promise<boolean>;
  readonly onArchive?: (() => Promise<boolean>) | undefined;
  readonly archived?: boolean;
  readonly onCancel?: (() => void) | undefined;
  readonly kpis?: PromptedProjectKpis | undefined;
  readonly onSaveKpis?: SaveProjectKpiPrompts | undefined;
  /** Lesen über project.kpis.read ist fehlgeschlagen: Felder bleiben gesperrt, mit Hinweis. */
  readonly kpisLoadFailed?: boolean | undefined;
  readonly configuration?: CtoxWorkjetProjectMetadataProjection | undefined;
  readonly renderLumaField?: ((props: LumaFieldProps) => ReactNode) | undefined;
  readonly onSaveConfiguration?:
    | ((next: ProjectConfigurationValues) => Promise<boolean>)
    | undefined;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => overviewDraft(overview));
  const [budget, setBudget] = useState(() =>
    overview?.tokenBudget?.limitBillions == null
      ? ""
      : overview.tokenBudget.limitBillions.toFixed(1).replace(".", ","),
  );
  const [state, setState] = useState({ pending: false, message: "" });
  const [errors, setErrors] = useState<{ budget?: string; urls?: string; meeting?: string }>({});
  const [supervisorLumaId, setSupervisorLumaId] = useState<string | null>(
    configuration?.supervisorLumaId ?? null,
  );
  const [info, setInfo] = useState(() => ({
    ...configuration?.info,
    summary: configuration?.info?.summary ?? configuration?.info?.description ?? "",
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
  const [initialKpis, setInitialKpis] = useState(scopedKpis);
  const initialPrompts = () =>
    [0, 1, 2].map((index) => initialKpis?.items[index]?.prompt.prompt ?? "");
  const [prompts, setPrompts] = useState(initialPrompts);
  if (initialKpis === undefined && scopedKpis !== undefined) {
    setInitialKpis(scopedKpis);
    setPrompts([0, 1, 2].map((index) => scopedKpis.items[index]?.prompt.prompt ?? ""));
  }
  const canConfigureKpis = !!(configuration && initialKpis && scopedKpis && onSaveKpis);
  const promptsChanged = prompts.some((prompt, index) => prompt !== initialPrompts()[index]);
  const cancel = () => {
    if (onCancel) return onCancel();
    setDraft(overviewDraft(overview));
    setBudget(
      overview?.tokenBudget?.limitBillions == null
        ? ""
        : overview.tokenBudget.limitBillions.toFixed(1).replace(".", ","),
    );
    setSupervisorLumaId(configuration?.supervisorLumaId ?? null);
    setInfo({
      ...configuration?.info,
      summary: configuration?.info?.summary ?? configuration?.info?.description ?? "",
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
    setErrors({});
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
        const fieldErrors: { budget?: string; urls?: string; meeting?: string } = {};
        try {
          parseTokenBudgetBillions(budget);
        } catch {
          fieldErrors.budget = "Zahl mit einer Dezimalstelle, z. B. 2,3.";
        }
        for (const url of [draft.repositoryUrl, draft.websiteUrl])
          if (url)
            try {
              new URL(url);
            } catch {
              fieldErrors.urls = "Vollständige Adresse mit https:// eintragen.";
            }
        if (meeting.enabled)
          try {
            new Intl.DateTimeFormat("de-DE", { timeZone: meeting.timezone.trim() });
          } catch {
            fieldErrors.meeting = "Zeitzone wie Europe/Berlin eintragen.";
          }
        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);
          setState({ pending: false, message: "" });
          return;
        }
        setErrors({});
        try {
          next = {
            ...decodeOverviewDraft(draft),
            tokenBudget: {
              limitBillions: parseTokenBudgetBillions(budget),
              revision: overview?.tokenBudget?.revision ?? 0,
              jourFixe:
                configuration && onSaveConfiguration
                  ? meeting.enabled
                    ? {
                        weekday: meeting.weekday,
                        time: meeting.time,
                        timezone: meeting.timezone.trim(),
                      }
                    : null
                  : (overview?.tokenBudget?.jourFixe ?? null),
            },
          };
          if (configuration && onSaveConfiguration) {
            const validated = decodeProjectConfiguration({
              action: "project.configure",
              commandId: "validate-project-configuration",
              projectId: configuration.id,
              title: configuration.title,
              ...(supervisorLumaId !== (configuration.supervisorLumaId ?? null)
                ? { supervisorLumaId }
                : {}),
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
            if (validated.action !== "project.configure")
              throw new Error("Ungültige Einstellungen");
            metadata = {
              ...(validated.supervisorLumaId !== undefined
                ? { supervisorLumaId: validated.supervisorLumaId }
                : {}),
              repoUrl: validated.repoUrl ?? null,
              publicUrl: validated.publicUrl ?? null,
              info: validated.info ?? null,
              jourFixe: validated.jourFixe ?? null,
            };
            next = { ...next, regularMeeting: metadata.jourFixe ?? null };
          }
        } catch {
          setState({
            pending: false,
            message: "Eingaben prüfen",
          });
          return;
        }
        setState({ pending: true, message: "" });
        const resumeCalendarSource = deferTokenBudgetCalendarSource(configuration?.id);
        try {
          if (metadata && onSaveConfiguration && !(await onSaveConfiguration(metadata))) {
            setState({
              pending: false,
              message: "Projekteinstellungen nicht gespeichert",
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
                message: workjetUiLanguage() === "en" ? "KPIs not saved" : "KPIs nicht gespeichert",
              });
              return;
            }
          }
          const saved = await onSave(next);
          if (saved) onCancel?.();
          setState({
            pending: false,
            message: saved ? "Projekt gespeichert" : "Übersicht nicht gespeichert",
          });
        } catch {
          setState({
            pending: false,
            message: "Übersicht nicht gespeichert",
          });
        } finally {
          resumeCalendarSource();
        }
      }}
    >
      <div className="grid items-center gap-x-3 gap-y-2 sm:grid-cols-[6rem_minmax(0,1fr)]">
        <label className="text-xs text-muted-foreground" htmlFor={`${id}-token-budget`}>
          Token-Budget
        </label>
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <Input
              id={`${id}-token-budget`}
              inputMode="decimal"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              placeholder="2,3"
              title="Milliarden Tokens je Regeltermin-Zyklus · leer = kein Limit"
              disabled={state.pending}
              aria-invalid={errors.budget !== undefined}
            />
            <span className="shrink-0 text-xs text-muted-foreground">Mrd. je Zyklus</span>
          </div>
          {errors.budget !== undefined && (
            <p className="text-xs text-red-400" role="alert">
              {errors.budget}
            </p>
          )}
        </div>
        <label className="text-xs text-muted-foreground" htmlFor={`${id}-repository`}>
          Git-Quelle
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
          Webseite
        </label>
        <Input
          id={`${id}-website`}
          type="url"
          maxLength={2048}
          value={draft.websiteUrl}
          onChange={(event) =>
            setDraft((current) => websiteDraftChange(current, event.target.value))
          }
          placeholder="https://example.com"
          disabled={state.pending}
          aria-invalid={errors.urls !== undefined}
        />
        {errors.urls !== undefined && (
          <p className="text-xs text-red-400 sm:col-start-2" role="alert">
            {errors.urls}
          </p>
        )}
        <label className="text-xs text-muted-foreground" htmlFor={`${id}-supervisor-tick`}>
          Supervisor-Takt
        </label>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs">
            <input
              id={`${id}-supervisor-tick`}
              type="checkbox"
              checked={(draft.supervisorTick ?? DEFAULT_SUPERVISOR_TICK_CONFIGURATION).enabled}
              disabled={state.pending}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  supervisorTick: {
                    ...(current.supervisorTick ?? DEFAULT_SUPERVISOR_TICK_CONFIGURATION),
                    enabled: event.target.checked,
                  },
                }))
              }
            />
            An
          </label>
          <label className="flex min-w-0 items-center gap-2 text-xs">
            Alle
            <Input
              aria-label="Supervisor-Takt in Minuten"
              className="w-20"
              type="number"
              min={1}
              max={10080}
              step={1}
              required
              disabled={state.pending}
              value={
                (draft.supervisorTick ?? DEFAULT_SUPERVISOR_TICK_CONFIGURATION).intervalMinutes
              }
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  supervisorTick: {
                    ...(current.supervisorTick ?? DEFAULT_SUPERVISOR_TICK_CONFIGURATION),
                    intervalMinutes: Number(event.target.value),
                  },
                }))
              }
            />
            Minuten
          </label>
        </div>
        {configuration && onSaveConfiguration && (
          <>
            <label className="text-xs text-muted-foreground" htmlFor={`${id}-supervisor-luma`}>
              Supervisor Luma
            </label>
            {renderLumaField ? (
              renderLumaField({
                id: `${id}-supervisor-luma`,
                value: supervisorLumaId,
                onChange: setSupervisorLumaId,
                disabled: state.pending,
              })
            ) : (
              <ProjectSupervisorLumaSelect
                id={`${id}-supervisor-luma`}
                value={supervisorLumaId}
                onChange={setSupervisorLumaId}
                disabled={state.pending}
                phase="unavailable"
                profiles={[]}
              />
            )}
            <span className="text-xs text-muted-foreground">Regeltermin</span>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_7.5rem_minmax(0,1.2fr)] gap-2 max-sm:grid-cols-1">
              <select
                aria-label="Regeltermin Wochentag"
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
                <option value="none">Kein Termin</option>
                {[
                  "Montag",
                  "Dienstag",
                  "Mittwoch",
                  "Donnerstag",
                  "Freitag",
                  "Samstag",
                  "Sonntag",
                ].map((day, index) => (
                  <option key={day} value={index + 1}>
                    {day}
                  </option>
                ))}
              </select>
              <Input
                aria-label="Regeltermin Uhrzeit"
                type="time"
                required={meeting.enabled}
                disabled={state.pending || !meeting.enabled}
                value={meeting.time}
                onChange={(event) =>
                  setMeeting((current) => ({ ...current, time: event.target.value }))
                }
              />
              <Input
                aria-label="Regeltermin Zeitzone"
                required={meeting.enabled}
                disabled={state.pending || !meeting.enabled}
                value={meeting.timezone}
                onChange={(event) =>
                  setMeeting((current) => ({ ...current, timezone: event.target.value }))
                }
              />
            </div>
            {errors.meeting !== undefined && (
              <p className="text-xs text-red-400 sm:col-start-2" role="alert">
                {errors.meeting}
              </p>
            )}
            <div className="sm:col-span-2">
              <ProjectMeetingPreparationField
                id={`${id}-preparation`}
                value={draft.meetingPreparation}
                disabled={state.pending || !meeting.enabled}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, meetingPreparation: value }))
                }
              />
            </div>
            <label className="text-xs text-muted-foreground" htmlFor={`${id}-description`}>
              Beschreibung
            </label>
            <Input
              id={`${id}-description`}
              maxLength={4096}
              value={info.summary}
              disabled={state.pending}
              onChange={(event) =>
                setInfo((current) => ({ ...current, summary: event.target.value }))
              }
            />
            <span className="text-xs text-muted-foreground">Stand</span>
            <div className="grid min-w-0 gap-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="col-span-full grid gap-1 text-xs sm:col-span-2">
                  Ziel
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
            </div>
          </>
        )}
      </div>
      <div className="grid gap-2 border-t border-border pt-3" data-workjet-prompted-kpis="">
        {kpisLoadFailed ? (
          <p role="alert" className="text-xs text-destructive" data-workjet-kpis-load-failed="">
            {workjetUiLanguage() === "en"
              ? "KPIs could not be loaded from the instance. Reopen the settings to try again."
              : "KPIs konnten nicht von der Instanz geladen werden. Einstellungen erneut öffnen, um es noch einmal zu versuchen."}
          </p>
        ) : null}
        {([0, 1, 2] as const).map((index) => (
          <div
            key={index}
            className="grid items-center gap-2 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(8rem,0.6fr)]"
          >
            <label htmlFor={`${id}-kpi-${index}`} className="text-xs text-muted-foreground">
              KPI {index + 1}
            </label>
            <Textarea
              id={`${id}-kpi-${index}`}
              maxLength={1024}
              rows={2}
              value={prompts[index]}
              placeholder={
                workjetUiLanguage() === "en"
                  ? "Describe the KPI in one sentence"
                  : "Kennzahl in einem Satz"
              }
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
                  message: saved ? "" : "Projekt nicht gespeichert",
                });
              } catch {
                setState({ pending: false, message: "Speichern fehlgeschlagen" });
              }
            }}
          >
            {archived ? "Projekt wiederherstellen" : "Projekt archivieren"}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={state.pending}
          className="ml-auto"
          onClick={cancel}
        >
          Abbrechen
        </Button>
        <Button type="submit" size="sm" disabled={state.pending}>
          {state.pending ? "Speichern …" : "Projekt speichern"}
        </Button>
        <p className="text-xs text-muted-foreground" role="status">
          {state.message}
        </p>
      </div>
    </form>
  );
}
