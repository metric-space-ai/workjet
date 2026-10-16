// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Google Kalender verbinden (ctox #875) über die Projektsteuerung der gewählten
 * Instanz: start → Anmeldefenster → complete. Die Instanz besitzt Client,
 * Zustand und Tokens; hier laufen nur `authorizeUrl` hinein und `callbackUrl`
 * hinaus. Jede Antwort muss zur eigenen commandId gehören.
 */
import * as Schema from "effect/Schema";
import {
  CtoxWorkjetProjectControlResponse,
  WORKJET_CALENDAR_CONNECT_COMPLETE,
  WORKJET_CALENDAR_CONNECT_PROBE_PROVIDER,
  WORKJET_CALENDAR_CONNECT_START,
  type DesktopBridge,
  type WorkjetCalendarConnectErrorCode,
  type WorkjetCalendarConnectRequest,
  type WorkjetCalendarConnectResponse,
  type WorkjetCalendarConnectedAccount,
} from "@workjet/contracts";

import { newCommandId } from "../lib/utils";
import { requestWorkjetProjectControl } from "../workjetProjectControl";

export type CalendarAuthorizePort = NonNullable<DesktopBridge["calendarAuthorize"]>;
type Control = typeof requestWorkjetProjectControl;

/** Fehler, die die Zeile zeigt: Core-Codes plus Abbruch des Anmeldefensters. */
export type CalendarConnectFailure =
  | WorkjetCalendarConnectErrorCode
  | "authorize_failed"
  | "instance_unavailable";

export type CalendarConnectOutcome =
  | { readonly _tag: "connected"; readonly account: WorkjetCalendarConnectedAccount }
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "failed"; readonly code: CalendarConnectFailure };

/** Genau eine Aktion je Fehlerzeile: erneut anmelden oder die Zeile schließen. */
export const CALENDAR_CONNECT_FAILURES: Readonly<
  Record<CalendarConnectFailure, { readonly text: string; readonly action: "retry" | "dismiss" }>
> = {
  provider_unsupported: {
    text: "Google wird von der Instanz nicht unterstützt.",
    action: "dismiss",
  },
  oauth_client_missing: {
    text: "Google-Anmeldung ist auf der Instanz nicht eingerichtet.",
    action: "dismiss",
  },
  redirect_unavailable: {
    text: "Rückleitung der Instanz ist nicht erreichbar.",
    action: "dismiss",
  },
  permission_denied: { text: "Keine Berechtigung für Kalender-Konten.", action: "dismiss" },
  rate_limited: { text: "Zu viele Versuche. Gleich erneut versuchen.", action: "retry" },
  attempt_expired: { text: "Anmeldung abgelaufen.", action: "retry" },
  state_mismatch: { text: "Anmeldung passt nicht zu diesem Versuch.", action: "retry" },
  consent_denied: { text: "Zugriff bei Google abgelehnt.", action: "retry" },
  scope_missing: { text: "Nicht alle Kalenderrechte freigegeben.", action: "retry" },
  token_exchange_failed: { text: "Google hat die Anmeldung nicht bestätigt.", action: "retry" },
  account_exists: { text: "Konto ist bereits verbunden.", action: "dismiss" },
  authorize_failed: { text: "Anmeldefenster konnte nicht geöffnet werden.", action: "retry" },
  instance_unavailable: { text: "Instanz antwortet nicht.", action: "retry" },
};

const decodeResponse = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
  onExcessProperty: "error",
});

type Receipt =
  | { readonly _tag: "ok"; readonly response: WorkjetCalendarConnectResponse }
  | { readonly _tag: "error"; readonly code: WorkjetCalendarConnectErrorCode }
  | { readonly _tag: "unavailable" };

async function send(
  instanceId: string,
  request: WorkjetCalendarConnectRequest,
  control: Control,
): Promise<Receipt> {
  const result = await control(instanceId, request);
  if (result._tag !== "completed") return { _tag: "unavailable" };
  let response: CtoxWorkjetProjectControlResponse;
  try {
    response = decodeResponse(result.response);
  } catch {
    return { _tag: "unavailable" };
  }
  if (
    response.action !== request.action ||
    !("commandId" in response) ||
    response.commandId !== request.commandId
  )
    return { _tag: "unavailable" };
  const receipt = response as WorkjetCalendarConnectResponse;
  if ("error" in receipt) return { _tag: "error", code: receipt.error };
  return { _tag: "ok", response: receipt };
}

/**
 * Kennt der Core die Anmeldung? Ein Probe-Start mit fremdem Anbieter endet nativ
 * vor jedem Versuch, Geheimnis und Ratenlimit mit `provider_unsupported`. Alles
 * andere (alte Shell, alter Core, fehlende Berechtigung) blendet den Eintrag aus.
 */
export async function probeCalendarConnect(
  instanceId: string,
  control: Control = requestWorkjetProjectControl,
): Promise<boolean> {
  try {
    const receipt = await send(
      instanceId,
      {
        action: WORKJET_CALENDAR_CONNECT_START,
        commandId: newCommandId(),
        provider: WORKJET_CALENDAR_CONNECT_PROBE_PROVIDER,
      },
      control,
    );
    return receipt._tag === "error" && receipt.code === "provider_unsupported";
  } catch {
    return false;
  }
}

/** start → Anmeldefenster → complete; `current` sperrt späte Antworten nach Instanzwechsel. */
export async function connectGoogleCalendar(
  instanceId: string,
  options: {
    readonly authorize: CalendarAuthorizePort;
    readonly current: () => boolean;
    readonly control?: Control;
  },
): Promise<CalendarConnectOutcome> {
  const control = options.control ?? requestWorkjetProjectControl;
  const stale = new Error("Calendar instance changed.");
  const start = await send(
    instanceId,
    { action: WORKJET_CALENDAR_CONNECT_START, commandId: newCommandId(), provider: "google" },
    control,
  );
  if (!options.current()) throw stale;
  if (start._tag === "error") return { _tag: "failed", code: start.code };
  if (start._tag !== "ok" || !("attemptId" in start.response))
    return { _tag: "failed", code: "instance_unavailable" };
  const { attemptId, authorizeUrl, redirectUri } = start.response;
  const window = await options.authorize({ instanceId, authorizeUrl, redirectUri });
  if (!options.current()) throw stale;
  if (window._tag === "cancelled") return { _tag: "cancelled" };
  if (window._tag !== "captured" || window.callbackUrl === undefined)
    return { _tag: "failed", code: "authorize_failed" };
  const complete = await send(
    instanceId,
    {
      action: WORKJET_CALENDAR_CONNECT_COMPLETE,
      commandId: newCommandId(),
      attemptId,
      callbackUrl: window.callbackUrl,
    },
    control,
  );
  if (!options.current()) throw stale;
  if (complete._tag === "error") return { _tag: "failed", code: complete.code };
  if (complete._tag !== "ok" || !("account" in complete.response))
    return { _tag: "failed", code: "instance_unavailable" };
  return { _tag: "connected", account: complete.response.account };
}
