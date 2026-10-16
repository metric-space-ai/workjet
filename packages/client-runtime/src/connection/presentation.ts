import type { ServerConfig } from "@workjet/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { NetworkStatus, SupervisorConnectionState } from "./model.ts";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId: string | null;
}

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: ServerConfig | null;
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "blocked":
      return {
        phase: "error",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
  }
}

/**
 * Kurzer deutscher Verbindungsstatus ohne Rohfehler (UI-Vertrag §2/§4,
 * Audit B#50). Der Rohtext bleibt in `connection.error` für die Diagnose.
 */
export function connectionStatusText(connection: EnvironmentConnectionPresentation): string {
  switch (connection.phase) {
    case "available":
      return "Verfügbar";
    case "offline":
      return "Offline";
    case "connecting":
      return "Verbindet …";
    case "reconnecting":
      return "Verbindet erneut …";
    case "connected":
      return "Verbunden";
    case "error":
      return "Verbindung fehlgeschlagen";
  }
}

/** Titel/Tooltip zum Status: dieselbe kurze Zeile, nie der Rohfehler. */
export function connectionStatusTitle(connection: EnvironmentConnectionPresentation): string {
  return connectionStatusText(connection);
}

export function presentEnvironmentConnection(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  return presentConnectionState(state);
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}

export function connectionPhaseMessage(
  phase: EnvironmentConnectionPhase,
  label: string,
  networkStatus: NetworkStatus,
): string {
  if (networkStatus === "offline" || phase === "offline") {
    return "Du bist offline";
  }
  switch (phase) {
    case "available":
      return "Verfügbar";
    case "connecting":
      return `Verbindet mit ${label} …`;
    case "reconnecting":
      return `Verbindet erneut mit ${label} …`;
    case "connected":
      return "Verbunden";
    case "error":
      return "Verbindung fehlgeschlagen";
  }
}
