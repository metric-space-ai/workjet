import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { Checkbox } from "./ui/checkbox";
import { OptionSelect } from "./ui/option-select";
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

/**
 * What a card save sends to `project.configure`: the name (the contract
 * requires it) plus only the fields that differ from the saved state. An
 * explicit null clears a field on the instance, so it appears only when the
 * user emptied a field that had a value.
 */
export type ProjectCardConfigurationPatch = {
  readonly title: string;
  readonly repoUrl?: string | null;
  readonly publicUrl?: string | null;
  readonly jourFixe?: { weekday: number; time: string; timezone: string } | null;
};

export function projectCardConfigurationPatch(
  saved: ProjectCardConfigurationValues,
  next: ProjectCardConfigurationValues,
): ProjectCardConfigurationPatch {
  const before = normalizedCardValues(saved);
  const after = normalizedCardValues(next);
  return {
    title: after.title,
    ...(after.repositoryUrl !== before.repositoryUrl ? { repoUrl: after.repositoryUrl } : {}),
    ...(after.websiteUrl !== before.websiteUrl ? { publicUrl: after.websiteUrl } : {}),
    ...(JSON.stringify(after.jourFixe) !== JSON.stringify(before.jourFixe)
      ? { jourFixe: after.jourFixe }
      : {}),
  };
}

/**
 * Per-card context from the gallery: the instance save that takes a patch,
 * and a repository address read from the project's folder (`origin`) that is
 * only proposed, never written without the user's click.
 */
export const ProjectCardConfigContext = createContext<{
  readonly savePatch?: ((patch: ProjectCardConfigurationPatch) => Promise<boolean>) | undefined;
  readonly repositorySuggestion?: string | null | undefined;
}>({});

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
function editorText(de: string, en: string): string {
  return workjetUiLanguage() === "en" ? en : de;
}

/** Uhrzeiten im 15-Minuten-Raster, beschriftet nach Sprache (DE 24 h, EN laut Locale). */
export function cardTimeOptions(
  current: string | null,
  locale: string,
): ReadonlyArray<{ value: string; label: string }> {
  const values = new Set<string>();
  for (let minutes = 0; minutes < 24 * 60; minutes += 15)
    values.add(
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
    );
  if (current && /^\d{2}:\d{2}$/.test(current)) values.add(current);
  const format = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    ...(locale.startsWith("de") ? { hourCycle: "h23" as const } : {}),
  });
  return [...values].sort().map((value) => {
    const [hours, minutes] = value.split(":").map(Number);
    return { value, label: format.format(new Date(Date.UTC(2000, 0, 1, hours, minutes))) };
  });
}

function cardTimeLocale(): string {
  if (workjetUiLanguage() !== "en") return "de-DE";
  return typeof navigator !== "undefined" && navigator.language.startsWith("en")
    ? navigator.language
    : "en-GB";
}

function normalizedCardValues(
  values: ProjectCardConfigurationValues,
): ProjectCardConfigurationValues {
  return {
    title: values.title.trim(),
    websiteUrl: values.websiteUrl?.trim() ? values.websiteUrl.trim() : null,
    repositoryUrl: values.repositoryUrl?.trim() ? values.repositoryUrl.trim() : null,
    jourFixe: values.jourFixe,
  };
}

/** A URL field changed when its trimmed text differs from what the form opened with. */
function changedUrl(value: string | null | undefined, initial: string | null | undefined) {
  return (value?.trim() || null) !== (initial?.trim() || null);
}

function sameCardValues(a: ProjectCardConfigurationValues, b: ProjectCardConfigurationValues) {
  return JSON.stringify(normalizedCardValues(a)) === JSON.stringify(normalizedCardValues(b));
}

function cardValidationError(values: ProjectCardConfigurationValues): string | null {
  for (const url of [values.websiteUrl, values.repositoryUrl])
    if (url?.trim())
      try {
        new URL(url.trim());
      } catch {
        return editorText(
          "Vollständige Adresse mit https:// eintragen.",
          "Enter a full address with https://.",
        );
      }
  if (values.title.trim() === "") return editorText("Name eintragen.", "Enter a name.");
  return null;
}

/** Nach einem abgelehnten Speichern: gespeicherter Stand zurück ins Feld, Wert zum Wiederholen (#736). */
export function failedCardSave(
  saved: ProjectCardConfigurationValues,
  next: ProjectCardConfigurationValues,
): {
  readonly draft: ProjectCardConfigurationValues;
  readonly retry: ProjectCardConfigurationValues;
  readonly message: string;
} {
  return {
    draft: saved,
    retry: next,
    message: editorText(
      "Nicht gespeichert – Instanz antwortet nicht. Alter Wert steht wieder.",
      "Not saved – the instance did not respond. The old value is back.",
    ),
  };
}

/**
 * Rückseite der Galeriekarte: jedes Feld speichert sofort (Text beim Verlassen,
 * Auswahl beim Wählen), danach „Gespeichert · Rückgängig“ (#728). Kein
 * Speichern/Abbrechen; „Fertig“ (oder Esc) schließt die Karte.
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
  /** Schließt die Karte (Fertig/Esc); Änderungen sind dann schon gespeichert. */
  readonly onCancel: () => void;
}) {
  const id = useId();
  const { savePatch, repositorySuggestion } = useContext(ProjectCardConfigContext);
  const [draft, setDraft] = useState<ProjectCardConfigurationValues>(() => ({
    title,
    websiteUrl,
    repositoryUrl,
    jourFixe,
  }));
  const [saved, setSaved] = useState<ProjectCardConfigurationValues>(() => ({
    title,
    websiteUrl,
    repositoryUrl,
    jourFixe,
  }));
  const [previous, setPrevious] = useState<ProjectCardConfigurationValues | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Last change the instance did not take; the fields show the saved state again. */
  const [failed, setFailed] = useState<ProjectCardConfigurationValues | null>(null);

  // Ein abgelehnter Wert darf nicht im Feld stehen bleiben, als wäre er
  // gespeichert (#736): Felder zurück auf den gespeicherten Stand, Wiederholen anbieten.
  const failSave = (next: ProjectCardConfigurationValues) => {
    const outcome = failedCardSave(saved, next);
    setDraft(outcome.draft);
    setFailed(outcome.retry);
    setMessage(outcome.message);
  };

  const commit = async (next: ProjectCardConfigurationValues, undo = false) => {
    if (pending || sameCardValues(next, saved)) return;
    const invalid = cardValidationError(next);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    setError(null);
    setPending(true);
    try {
      const ok = savePatch
        ? await savePatch(projectCardConfigurationPatch(saved, next))
        : await onSave(normalizedCardValues(next));
      if (ok) {
        setPrevious(undo ? null : saved);
        setSaved(next);
        setDraft(next);
        setMessage(
          undo ? editorText("Rückgängig gemacht", "Undone") : editorText("Gespeichert", "Saved"),
        );
        setFailed(null);
      } else failSave(next);
    } catch {
      failSave(next);
    } finally {
      setPending(false);
    }
  };

  const label = (htmlFor: string, text: string) => (
    <label htmlFor={htmlFor} className="text-[11px] font-medium text-muted-foreground">
      {text}
    </label>
  );

  return (
    <div
      className="flex size-full min-h-0 flex-col"
      data-workjet-project-card-config=""
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
          event.preventDefault();
          void commit(draft);
        }
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2 pr-16">
        <div className="grid grid-cols-2 gap-1.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            {label(`${id}-name`, editorText("Name", "Name"))}
            <Input
              id={`${id}-name`}
              aria-label="Projektname"
              size="sm"
              maxLength={256}
              required
              disabled={!canEditTitle}
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              onBlur={() => void commit(draft)}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            {label(`${id}-website`, editorText("Website", "Website"))}
            <Input
              id={`${id}-website`}
              size="sm"
              type="url"
              maxLength={2048}
              placeholder="https://example.com"
              value={draft.websiteUrl ?? ""}
              onChange={(event) => setDraft({ ...draft, websiteUrl: event.target.value || null })}
              onBlur={() => void commit(draft)}
            />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          {label(`${id}-repository`, editorText("Repository", "Repository"))}
          <Input
            id={`${id}-repository`}
            size="sm"
            type="url"
            maxLength={2048}
            placeholder="https://github.com/owner/repository"
            value={draft.repositoryUrl ?? ""}
            onChange={(event) => setDraft({ ...draft, repositoryUrl: event.target.value || null })}
            onBlur={() => void commit(draft)}
          />
          {repositorySuggestion && !draft.repositoryUrl?.trim() ? (
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 self-start rounded-full border border-border px-2 py-0.5 text-[11px] hover:bg-accent disabled:opacity-60"
              data-workjet-action="project.card.config.repo-suggestion"
              title={repositorySuggestion}
              disabled={pending}
              onClick={() => {
                const updated = { ...draft, repositoryUrl: repositorySuggestion };
                setDraft(updated);
                void commit(updated);
              }}
            >
              <span className="font-medium">{editorText("Repo übernehmen", "Use repository")}</span>
              <span className="min-w-0 truncate text-muted-foreground">
                {repositorySuggestion.replace(/^https:\/\//, "")}
              </span>
            </button>
          ) : null}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-1.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {editorText("Regeltermin", "Regular meeting")}
            </span>
            <OptionSelect
              aria-label={editorText("Regeltermin Wochentag", "Regular meeting weekday")}
              className="w-auto min-w-0"
              size="sm"
              disabled={pending}
              value={String(draft.jourFixe?.weekday ?? "none")}
              options={[
                { value: "none", label: editorText("Kein Termin", "No meeting") },
                ...WEEKDAY_LABELS.map((day, index) => ({
                  value: String(index + 1),
                  label: workjetUiLanguage() === "en" ? WEEKDAY_LABELS_EN[index]! : day,
                })),
              ]}
              onValueChange={(next) => {
                const updated: ProjectCardConfigurationValues = {
                  ...draft,
                  jourFixe:
                    next === "none"
                      ? null
                      : {
                          weekday: Number(next),
                          time: draft.jourFixe?.time ?? "09:00",
                          timezone: draft.jourFixe?.timezone ?? "Europe/Berlin",
                        },
                };
                setDraft(updated);
                void commit(updated);
              }}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {editorText("Uhrzeit", "Time")}
            </span>
            <OptionSelect
              aria-label={editorText("Regeltermin Uhrzeit", "Regular meeting time")}
              className="w-auto min-w-0"
              size="sm"
              disabled={pending || draft.jourFixe === null}
              value={draft.jourFixe?.time ?? "09:00"}
              options={cardTimeOptions(draft.jourFixe?.time ?? null, cardTimeLocale())}
              onValueChange={(time) => {
                if (draft.jourFixe === null) return;
                const updated = { ...draft, jourFixe: { ...draft.jourFixe, time } };
                setDraft(updated);
                void commit(updated);
              }}
            />
          </div>
        </div>
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <div
        className="flex flex-none items-center justify-end gap-2 border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground"
        data-workjet-project-card-config-actions=""
        role="status"
      >
        {pending ? editorText("Speichert …", "Saving …") : message}
        {!pending && failed !== null ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-workjet-action="project.card.config.retry"
            onClick={() => {
              setDraft(failed);
              void commit(failed);
            }}
          >
            {editorText("Erneut versuchen", "Retry")}
          </Button>
        ) : null}
        {!pending && failed === null && previous !== null ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-workjet-action="project.card.config.undo"
            onClick={() => void commit(previous, true)}
          >
            {editorText("Rückgängig", "Undo")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const WEEKDAY_LABELS_EN = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

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
  // What the form showed when it opened: only fields that differ from it are sent.
  const [initialDraft] = useState(() => overviewDraft(overview));
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
  const [initialInfo] = useState(() => info);
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
            const jourFixe = meeting.enabled
              ? { weekday: meeting.weekday, time: meeting.time, timezone: meeting.timezone.trim() }
              : null;
            const validated = decodeProjectConfiguration({
              action: "project.configure",
              commandId: "validate-project-configuration",
              projectId: configuration.id,
              title: configuration.title,
              ...(supervisorLumaId !== (configuration.supervisorLumaId ?? null)
                ? { supervisorLumaId }
                : {}),
              ...(changedUrl(draft.repositoryUrl, initialDraft.repositoryUrl)
                ? { repoUrl: next.repositoryUrl ?? null }
                : {}),
              ...(changedUrl(draft.websiteUrl, initialDraft.websiteUrl)
                ? { publicUrl: next.websiteUrl }
                : {}),
              ...(JSON.stringify(info) !== JSON.stringify(initialInfo) ? { info } : {}),
              ...(JSON.stringify(jourFixe) !== JSON.stringify(configuration.jourFixe ?? null)
                ? { jourFixe }
                : {}),
            });
            if (validated.action !== "project.configure")
              throw new Error("Ungültige Einstellungen");
            // Only changed fields: an explicit null would clear the stored value.
            metadata = {
              ...(validated.supervisorLumaId !== undefined
                ? { supervisorLumaId: validated.supervisorLumaId }
                : {}),
              ...(validated.repoUrl !== undefined ? { repoUrl: validated.repoUrl } : {}),
              ...(validated.publicUrl !== undefined ? { publicUrl: validated.publicUrl } : {}),
              ...(validated.info !== undefined ? { info: validated.info } : {}),
              ...(validated.jourFixe !== undefined ? { jourFixe: validated.jourFixe } : {}),
            };
            next = { ...next, regularMeeting: jourFixe };
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
          if (
            metadata &&
            Object.keys(metadata).length > 0 &&
            onSaveConfiguration &&
            !(await onSaveConfiguration(metadata))
          ) {
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
        <label
          className="flex items-baseline gap-1.5 text-xs text-muted-foreground"
          htmlFor={`${id}-token-budget`}
        >
          {editorText("Token-Budget", "Token budget")}
          {budget.trim().length === 0 ? (
            <span className="text-muted-foreground/70" data-project-field-default="">
              {editorText("kein Limit", "no limit")}
            </span>
          ) : null}
        </label>
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <Input
              id={`${id}-token-budget`}
              inputMode="decimal"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              disabled={state.pending}
              aria-invalid={errors.budget !== undefined}
            />
            <span className="shrink-0 text-xs text-muted-foreground">
              {editorText("Mrd. Tokens je Regeltermin-Zyklus", "bn tokens per meeting cycle")}
            </span>
          </div>
          {errors.budget !== undefined && (
            <p className="text-xs text-red-400" role="alert">
              {errors.budget}
            </p>
          )}
        </div>
        <label className="text-xs text-muted-foreground" htmlFor={`${id}-repository`}>
          {editorText("Git-Quelle", "Git source")}
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
          {editorText("Webseite", "Website")}
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
            <Checkbox
              id={`${id}-supervisor-tick`}
              checked={(draft.supervisorTick ?? DEFAULT_SUPERVISOR_TICK_CONFIGURATION).enabled}
              disabled={state.pending}
              onCheckedChange={(checked) =>
                setDraft((current) => ({
                  ...current,
                  supervisorTick: {
                    ...(current.supervisorTick ?? DEFAULT_SUPERVISOR_TICK_CONFIGURATION),
                    enabled: checked,
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
              Supervisor-Preset
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
              <OptionSelect
                aria-label="Regeltermin Wochentag"
                className="w-auto min-w-0"
                disabled={state.pending}
                value={meeting.enabled ? String(meeting.weekday) : "none"}
                options={[
                  { value: "none", label: "Kein Termin" },
                  ...[
                    "Montag",
                    "Dienstag",
                    "Mittwoch",
                    "Donnerstag",
                    "Freitag",
                    "Samstag",
                    "Sonntag",
                  ].map((day, index) => ({ value: String(index + 1), label: day })),
                ]}
                onValueChange={(next) =>
                  setMeeting((current) => ({
                    ...current,
                    enabled: next !== "none",
                    weekday: next === "none" ? current.weekday : Number(next),
                  }))
                }
              />
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
