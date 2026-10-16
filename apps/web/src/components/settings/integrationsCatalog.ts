// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Kalender-Apps, die die Instanz selbst anmeldet. Name und Logo stammen aus den
// Activepieces-Piece-Metadaten (MIT); das Logo liegt lokal unter /integrations.
/** calendar-oauth = native Kalender-Anmeldung der Instanz (ctox #875, Instanz › Kalender-Konten). */
export type IntegrationConnect = "calendar-oauth";

export interface IntegrationEntry {
  readonly slug: string;
  readonly name: string;
  readonly logo: string | null;
  readonly connect: IntegrationConnect;
}

export const INTEGRATIONS: ReadonlyArray<IntegrationEntry> = [
  {
    slug: "google-calendar",
    name: "Google Kalender",
    logo: "/integrations/google-calendar.png",
    connect: "calendar-oauth",
  },
];

/** Kalender, die die Instanz selbst anmeldet (start → Anmeldefenster → complete). */
export const CALENDAR_OAUTH_INTEGRATIONS: ReadonlyArray<IntegrationEntry> = INTEGRATIONS.filter(
  (entry) => entry.connect === "calendar-oauth",
);
