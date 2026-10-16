import type { EnvironmentConnectionPresentation } from "@workjet/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import { presentSavedCloudEnvironmentConnection } from "./cloudEnvironmentConnectionPresentation";

function connection(
  phase: EnvironmentConnectionPresentation["phase"],
  error: string | null = null,
): EnvironmentConnectionPresentation {
  return { phase, error, traceId: null };
}

describe("saved cloud environment connection presentation", () => {
  it("only labels a live connection as connected", () => {
    expect(presentSavedCloudEnvironmentConnection(connection("connected"))).toEqual({
      buttonLabel: "Verbunden",
      statusText: "Verbunden",
      tone: "connected",
    });

    expect(presentSavedCloudEnvironmentConnection(connection("connecting"))).toEqual({
      buttonLabel: "Verbindet …",
      statusText: "Verbindet …",
      tone: "connecting",
    });
  });

  it("surfaces a failed attempt while the supervisor reconnects", () => {
    expect(
      presentSavedCloudEnvironmentConnection(
        connection("reconnecting", "Relay environment endpoint is unavailable."),
      ),
    ).toEqual({
      buttonLabel: "Verbindet erneut …",
      statusText: "Verbindet erneut …",
      tone: "connecting",
    });
  });

  it.each([
    ["error", "Verbindung fehlgeschlagen", "Verbindung fehlgeschlagen", "error"],
    ["offline", "Offline", "Offline", "idle"],
    ["available", "Nicht verbunden", "Verfügbar", "idle"],
  ] as const)(
    "presents %s without claiming the environment is connected",
    (phase, buttonLabel, statusText, tone) => {
      expect(
        presentSavedCloudEnvironmentConnection(
          connection(phase, phase === "error" ? "Access denied." : null),
        ),
      ).toEqual({ buttonLabel, statusText, tone });
    },
  );
});
