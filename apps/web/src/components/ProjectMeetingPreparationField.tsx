import {
  DEFAULT_MEETING_PREPARATION_CONFIGURATION,
  oneShotHarnessUnavailableReason,
  type MeetingPreparationConfiguration,
  type WorkjetHarness,
  type WorkjetWorkerProfile,
} from "@workjet/contracts";
import { useProjectSupervisorLumas } from "./ProjectSupervisorLumaField";
import { workjetHarnessDisplayLabel } from "./settings/WorkjetWorkerEditor";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface PreparationFieldProps {
  readonly id: string;
  readonly value: MeetingPreparationConfiguration | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: MeetingPreparationConfiguration) => void;
}
const emptyProfiles: readonly WorkjetWorkerProfile[] = [];
const harnesses: readonly WorkjetHarness[] = [
  "claude-code",
  "codex-cli",
  "cursor-agent",
  "grok-cli",
  "opencode",
  "pi-code",
  "greppy",
  "minimax-code",
];
export function ProjectMeetingPreparationField(props: PreparationFieldProps) {
  return <MeetingPreparationField {...props} {...useProjectSupervisorLumas()} />;
}
export function MeetingPreparationField({
  id,
  value,
  disabled,
  onChange,
  profiles = emptyProfiles,
  phase = "unavailable",
}: PreparationFieldProps & {
  readonly profiles?: readonly WorkjetWorkerProfile[];
  readonly phase?: "loading" | "ready" | "unavailable";
}) {
  const config = value ?? DEFAULT_MEETING_PREPARATION_CONFIGURATION;
  const matching = profiles.filter((p) => p.harness === config.harness);
  const models = [...new Set(matching.map((p) => p.modelId))];
  const available = matching.filter((p) => p.modelId === config.model);
  const change = (patch: Partial<MeetingPreparationConfiguration>) =>
    onChange({ ...config, ...patch });
  return (
    <fieldset
      className="grid min-w-0 gap-2 rounded-md border border-border p-3"
      disabled={disabled}
    >
      <legend className="px-1 text-xs font-medium">Regeltermin-Vorbereitung</legend>
      <label className="flex items-center gap-2 text-xs">
        <input
          id={id}
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => change({ enabled: e.target.checked })}
        />
        Vorbereitung aktiv
      </label>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1 text-xs">
          Harness
          <select
            aria-label="Vorbereitungs-Harness"
            className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
            value={config.harness}
            onChange={(e) => {
              const harness = e.target.value as WorkjetHarness;
              const { workerProfileId: _profile, ...rest } = config;
              onChange({ ...rest, harness });
            }}
          >
            {harnesses.map((h) => (
              <option key={h} value={h} disabled={oneShotHarnessUnavailableReason(h) !== null}>
                {workjetHarnessDisplayLabel(h)}
                {oneShotHarnessUnavailableReason(h) ? " · Worktree-Begrenzung fehlt" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-1 text-xs">
          Modell
          <select
            aria-label="Vorbereitungs-Modell"
            className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
            value={config.model}
            onChange={(e) => {
              const { workerProfileId: _profile, ...rest } = config;
              onChange({ ...rest, model: e.target.value });
            }}
          >
            {!models.includes(config.model) && (
              <option value={config.model}>{config.model} · Worker nicht konfiguriert</option>
            )}
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="grid min-w-0 gap-1 text-xs">
        Worker und Kontoroute
        <select
          aria-label="Vorbereitungs-Worker"
          className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
          value={config.workerProfileId ?? ""}
          onChange={(e) => {
            const { workerProfileId: _profile, ...rest } = config;
            const selected = available.find((p) => p.id === e.target.value);
            onChange({ ...rest, ...(selected ? { workerProfileId: selected.id } : {}) });
          }}
        >
          <option value="">Passenden Worker verwenden</option>
          {config.workerProfileId && !available.some((p) => p.id === config.workerProfileId) && (
            <option value={config.workerProfileId}>Gespeicherter Worker nicht verfügbar</option>
          )}
          {available.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.computerId}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-2">
        <span className="text-xs">Stunden vor dem Termin</span>
        {config.leadMinutes.map((minutes, index) => (
          // eslint-disable-next-line react/no-array-index-key -- Keep the editable slot mounted while its offset changes.
          <div key={index} className="flex min-w-0 items-center gap-2">
            <span className="text-xs">T−</span>
            <Input
              type="number"
              aria-label={`Vorbereitung ${index + 1} Stunden vorher`}
              min={1 / 60}
              max={168}
              step={1 / 60}
              value={minutes / 60}
              className="min-w-0 flex-1"
              onChange={(e) =>
                change({
                  leadMinutes: config.leadMinutes.map((n, i) =>
                    i === index ? Math.round(Number(e.target.value) * 60) : n,
                  ),
                })
              }
            />
            <span className="text-xs">h</span>
            {config.leadMinutes.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Vorbereitung ${index + 1} entfernen`}
                onClick={() =>
                  change({ leadMinutes: config.leadMinutes.filter((_, i) => i !== index) })
                }
              >
                Entfernen
              </Button>
            )}
          </div>
        ))}
        {config.leadMinutes.length < 4 && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="justify-self-start"
            onClick={() => {
              const lead = [60, 30, 15, 5, 1].find((n) => !config.leadMinutes.includes(n))!;
              change({ leadMinutes: [...config.leadMinutes, lead] });
            }}
          >
            Zeitpunkt hinzufügen
          </Button>
        )}
      </div>
      <p className="break-words text-xs text-muted-foreground" role="status">
        {oneShotHarnessUnavailableReason(config.harness) ??
          (phase === "loading"
            ? "Worker-Konfiguration wird geladen …"
            : available.length === 0
              ? "Kein passender Worker konfiguriert."
              : "")}
      </p>
    </fieldset>
  );
}
