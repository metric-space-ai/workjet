import {
  DEFAULT_MEETING_PREPARATION_CONFIGURATION,
  oneShotHarnessUnavailableReason,
  type MeetingPreparationConfiguration,
  type WorkjetHarness,
  type WorkjetWorkerProfile,
} from "@workjet/contracts";
import { Checkbox } from "./ui/checkbox";
import { OptionSelect } from "./ui/option-select";
import {
  PresetsUnavailableLine,
  useLoadingEndsAfter10s,
  useProjectSupervisorLumas,
} from "./ProjectSupervisorLumaField";
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
  retry,
}: PreparationFieldProps & {
  readonly profiles?: readonly WorkjetWorkerProfile[];
  readonly phase?: "loading" | "ready" | "unavailable";
  readonly retry?: (() => void) | undefined;
}) {
  const config = value ?? DEFAULT_MEETING_PREPARATION_CONFIGURATION;
  const matching = profiles.filter((p) => p.harness === config.harness);
  const models = [...new Set(matching.map((p) => p.modelId))];
  const available = matching.filter((p) => p.modelId === config.model);
  const change = (patch: Partial<MeetingPreparationConfiguration>) =>
    onChange({ ...config, ...patch });
  // Laden endet nach 10 s in einer Statuszeile statt endlos zu warten.
  const loadingSlow = useLoadingEndsAfter10s(phase);
  return (
    <fieldset
      className="grid min-w-0 gap-2 rounded-md border border-border p-3"
      disabled={disabled}
    >
      <legend className="px-1 text-xs font-medium">Regeltermin-Vorbereitung</legend>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          id={id}
          checked={config.enabled}
          onCheckedChange={(checked) => change({ enabled: checked })}
        />
        Vorbereitung aktiv
      </label>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1 text-xs">
          Harness
          <OptionSelect
            aria-label="Vorbereitungs-Harness"
            className="w-auto min-w-0"
            value={config.harness}
            options={harnesses.map((h) => ({
              value: h,
              label: `${workjetHarnessDisplayLabel(h)}${oneShotHarnessUnavailableReason(h) ? " · Worktree-Begrenzung fehlt" : ""}`,
              disabled: oneShotHarnessUnavailableReason(h) !== null,
            }))}
            onValueChange={(harness) => {
              const { workerProfileId: _profile, ...rest } = config;
              onChange({ ...rest, harness });
            }}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-xs">
          Modell
          <OptionSelect
            aria-label="Vorbereitungs-Modell"
            className="w-auto min-w-0"
            value={config.model}
            options={[
              ...(models.includes(config.model)
                ? []
                : [{ value: config.model, label: config.model }]),
              ...models.map((model) => ({ value: model, label: model })),
            ]}
            onValueChange={(model) => {
              const { workerProfileId: _profile, ...rest } = config;
              onChange({ ...rest, model });
            }}
          />
        </label>
      </div>
      <label className="grid min-w-0 gap-1 text-xs">
        Preset
        <OptionSelect<string>
          aria-label="Vorbereitungs-Preset"
          className="w-auto min-w-0"
          value={config.workerProfileId ?? ""}
          options={[
            { value: "", label: "Passendes Preset" },
            ...(config.workerProfileId && !available.some((p) => p.id === config.workerProfileId)
              ? [{ value: config.workerProfileId, label: "Gespeichertes Preset" }]
              : []),
            ...available.map((p) => ({ value: p.id, label: `${p.name} · ${p.computerId}` })),
          ]}
          onValueChange={(id) => {
            const { workerProfileId: _profile, ...rest } = config;
            const selected = available.find((p) => p.id === id);
            onChange({ ...rest, ...(selected ? { workerProfileId: selected.id } : {}) });
          }}
        />
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
                variant="outline"
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
      {oneShotHarnessUnavailableReason(config.harness) === null &&
      (phase === "unavailable" || (phase === "loading" && loadingSlow)) ? (
        <PresetsUnavailableLine retry={retry} />
      ) : (
        <p className="break-words text-xs text-muted-foreground" role="status">
          {oneShotHarnessUnavailableReason(config.harness) ??
            (phase === "ready" && available.length === 0 ? "Kein passendes Preset" : "")}
        </p>
      )}
    </fieldset>
  );
}
