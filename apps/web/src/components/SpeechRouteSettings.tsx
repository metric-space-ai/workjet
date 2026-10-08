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
    <div>
      {SPEECH_SESSION_KINDS.map((sessionKind) => {
        const route = routeFor(routes, sessionKind);
        return (
          <fieldset key={sessionKind} disabled={disabled}>
            <legend>{speechSessionKindLabel(sessionKind)}</legend>
            {(["stt", "tts"] as const).map((direction) => {
              const selected =
                direction === "stt" ? route.sttEnvironmentId : route.ttsEnvironmentId;
              const selectedComputer = computers.find(
                (computer) => computer.environmentId === selected,
              );
              const selectId = `speech-${sessionKind}-${direction}`;
              return (
                <div key={direction}>
                  <label htmlFor={selectId}>{DIRECTION_LABEL[direction]}</label>
                  <select
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
                    <p role="status">
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
