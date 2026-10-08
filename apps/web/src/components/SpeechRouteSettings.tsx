import { EnvironmentId, type WorkjetSpeechRoute } from "@workjet/contracts";

import {
  SPEECH_SESSION_KINDS,
  isSpeechComputerConfirmed,
  routeFor,
  speechCapabilityLabel,
  speechSessionKindLabel,
  withSpeechComputer,
  type SpeechComputerOption,
  type SpeechDirection,
} from "../lib/speechRoutes";

export interface SpeechRouteSettingsProps {
  readonly routes: ReadonlyArray<WorkjetSpeechRoute>;
  readonly computers: ReadonlyArray<SpeechComputerOption>;
  readonly disabled?: boolean;
  readonly onChange: (route: WorkjetSpeechRoute) => void;
}

const DIRECTION_LABEL: Record<SpeechDirection, string> = {
  stt: "Spracherkennung (STT) auf",
  tts: "Sprachausgabe (TTS) auf",
};

const STANDARD_VALUE = "";

export function SpeechRouteSettings({
  routes,
  computers,
  disabled = false,
  onChange,
}: SpeechRouteSettingsProps) {
  return (
    <div className="space-y-4">
      {SPEECH_SESSION_KINDS.map((sessionKind) => {
        const route = routeFor(routes, sessionKind);
        return (
          <fieldset key={sessionKind} disabled={disabled} className="space-y-2">
            <legend className="text-xs font-medium text-muted-foreground">
              {speechSessionKindLabel(sessionKind)}
            </legend>
            {(["stt", "tts"] as const).map((direction) => {
              const selected =
                direction === "stt" ? route.sttEnvironmentId : route.ttsEnvironmentId;
              const selectedComputer = computers.find(
                (computer) => computer.environmentId === selected,
              );
              const selectId = `speech-${sessionKind}-${direction}`;
              return (
                <div key={direction} className="space-y-1">
                  <label htmlFor={selectId} className="block text-xs text-muted-foreground">
                    {DIRECTION_LABEL[direction]}
                  </label>
                  <select
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    id={selectId}
                    value={selected ?? STANDARD_VALUE}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      onChange(
                        withSpeechComputer(
                          route,
                          direction,
                          value === STANDARD_VALUE ? null : EnvironmentId.make(value),
                        ),
                      );
                    }}
                  >
                    <option value={STANDARD_VALUE}>Standardauflösung des Servers</option>
                    {computers.map((computer) => (
                      <option key={computer.environmentId} value={computer.environmentId}>
                        {computer.label}, {speechCapabilityLabel(computer.capability[direction])}
                      </option>
                    ))}
                  </select>
                  {selected !== null && !isSpeechComputerConfirmed(selectedComputer, direction) ? (
                    <p role="status" className="text-xs text-warning">
                      Für diese Richtung ist auf dem gewählten Rechner noch keine Verfügbarkeit
                      bestätigt. Die Sitzung schlägt fehl, statt auf einen anderen Rechner
                      auszuweichen.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
