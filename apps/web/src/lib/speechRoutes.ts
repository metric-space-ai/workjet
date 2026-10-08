import {
  type EnvironmentId,
  type WorkjetSpeechCapability,
  type WorkjetSpeechRoute,
  type WorkjetSpeechSessionKind,
} from "@workjet/contracts";

export type SpeechDirection = "stt" | "tts";

/** A connected computer as the picker sees it, with capabilities the server confirmed. */
export interface SpeechComputerOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly capability: Record<SpeechDirection, WorkjetSpeechCapability>;
}

export const SPEECH_SESSION_KINDS: ReadonlyArray<WorkjetSpeechSessionKind> = [
  "regeltermin",
  "spontan",
];

export const speechSessionKindLabel = (kind: WorkjetSpeechSessionKind): string =>
  kind === "regeltermin" ? "Regeltermin mit dem Jour fixe" : "Spontane Sprachsitzung";

export const speechCapabilityLabel = (capability: WorkjetSpeechCapability): string => {
  switch (capability) {
    case "available":
      return "verfügbar";
    case "unavailable":
      return "nicht verfügbar";
    case "unknown":
      return "Verfügbarkeit unbekannt";
  }
};

/** Returns the route for a kind, or an empty standard route when none is stored yet. */
export const routeFor = (
  routes: ReadonlyArray<WorkjetSpeechRoute>,
  sessionKind: WorkjetSpeechSessionKind,
): WorkjetSpeechRoute =>
  routes.find((route) => route.sessionKind === sessionKind) ?? {
    sessionKind,
    sttEnvironmentId: null,
    ttsEnvironmentId: null,
  };

/** Replaces one direction for one kind. The other values stay untouched. */
export const withSpeechComputer = (
  route: WorkjetSpeechRoute,
  direction: SpeechDirection,
  environmentId: EnvironmentId | null,
): WorkjetSpeechRoute =>
  direction === "stt"
    ? { ...route, sttEnvironmentId: environmentId }
    : { ...route, ttsEnvironmentId: environmentId };

/** A computer the server does not report as available is still choosable, but the UI warns. */
export const isSpeechComputerConfirmed = (
  computer: SpeechComputerOption | undefined,
  direction: SpeechDirection,
): boolean => computer?.capability[direction] === "available";
