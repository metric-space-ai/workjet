import { FALLBACK_UI_LANGUAGE, type ProjectOverviewLanguage } from "../projectOverviewText";

/**
 * Calendar UI strings per UI language. A new language adds one entry with the
 * same keys; the type keeps every language complete.
 */
export const CALENDAR_TEXT = {
  de: {
    calendar: "Projektkalender",
    viewGroup: "Kalenderansicht",
    views: { day: "Tag", week: "Woche", month: "Monat", year: "Jahr" },
    today: "Heute",
    previous: "Zurück",
    next: "Weiter",
    weekNumber: "KW",
    allDay: "ganztägig",
    allDayEvents: "Ganztägige Termine",
    more: (count: number) => `${count} weitere`,
    project: "Projekt",
    projectSelect: "Kalenderprojekt",
    allProjects: "Alle Projekte",
    calendars: "Kalender",
    regularMeetings: "Regeltermine",
    projectSessions: "Projektsitzungen",
    session: "Sitzung",
    connectedAccounts: "Verbundene Konten",
    accountsTruncated: "Kontenliste unvollständig",
    synced: "Abgeglichen",
    syncedAt: (time: string) => `Abgeglichen ${time}`,
    syncing: "Wird abgeglichen …",
    unsupported: "Nicht unterstützt",
    syncFailed: "Abgleich fehlgeschlagen",
    syncedPartially: "Teilweise abgeglichen",
    refresh: "Aktualisieren",
    notLoaded: "Nicht geladen",
    retry: "Erneut versuchen",
    withoutRegularMeetingLabel: "Projekte ohne Regeltermin",
    withoutRegularMeeting: "Ohne Regeltermin",
    setMeeting: (project: string) => `${project}: Termin festlegen`,
    eventDetails: "Termindetails",
    close: "Schließen",
    accountEventReadOnly: "Kontotermin · nur lesen",
  },
  en: {
    calendar: "Project calendar",
    viewGroup: "Calendar view",
    views: { day: "Day", week: "Week", month: "Month", year: "Year" },
    today: "Today",
    previous: "Previous",
    next: "Next",
    weekNumber: "Week",
    allDay: "all-day",
    allDayEvents: "All-day events",
    more: (count: number) => `${count} more`,
    project: "Project",
    projectSelect: "Calendar project",
    allProjects: "All projects",
    calendars: "Calendars",
    regularMeetings: "Regular meetings",
    projectSessions: "Project sessions",
    session: "Session",
    connectedAccounts: "Connected accounts",
    accountsTruncated: "Account list incomplete",
    synced: "Synced",
    syncedAt: (time: string) => `Synced ${time}`,
    syncing: "Syncing …",
    unsupported: "Not supported",
    syncFailed: "Sync failed",
    syncedPartially: "Partially synced",
    refresh: "Refresh",
    notLoaded: "Not loaded",
    retry: "Retry",
    withoutRegularMeetingLabel: "Projects without a regular meeting",
    withoutRegularMeeting: "No regular meeting",
    setMeeting: (project: string) => `${project}: set meeting`,
    eventDetails: "Event details",
    close: "Close",
    accountEventReadOnly: "Account event · read-only",
  },
} as const satisfies Record<ProjectOverviewLanguage, unknown>;

export type CalendarText = (typeof CALENDAR_TEXT)[ProjectOverviewLanguage];

/** Strings for a UI language or BCP 47 locale ("en-GB" → en); falls back to the UI fallback (German). */
export function calendarText(languageOrLocale: string): CalendarText {
  const base = languageOrLocale.toLowerCase().split(/[-_]/)[0] ?? "";
  return base in CALENDAR_TEXT
    ? CALENDAR_TEXT[base as ProjectOverviewLanguage]
    : CALENDAR_TEXT[FALLBACK_UI_LANGUAGE];
}
