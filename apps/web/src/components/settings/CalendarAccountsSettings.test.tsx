import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { toolhubAuthorizeOrigins } from "@workjet/contracts";

vi.mock("../ctox/CtoxModeShell", () => ({
  useCtoxMode: () => ({ selectedId: "managed:tenant", discovery: "loading" }),
}));

import { CALENDAR_CONNECT_FAILURES } from "../../calendar/calendarConnect";
import { CalendarAccountsSection, GoogleDraftRow } from "./CalendarAccountsSettings";
import { CONNECTABLE_INTEGRATIONS } from "./IntegrationsSettings";
import { CALENDAR_OAUTH_INTEGRATIONS, INTEGRATIONS } from "./integrationsCatalog";

const google = INTEGRATIONS.find((entry) => entry.slug === "google-calendar")!;

describe("Katalog: Google Kalender (ctox #875)", () => {
  it("verbindet nativ über die Instanz, nicht über den Toolhub", () => {
    expect(google.connect).toBe("calendar-oauth");
    expect(CALENDAR_OAUTH_INTEGRATIONS.map((entry) => entry.slug)).toEqual(["google-calendar"]);
    expect(CONNECTABLE_INTEGRATIONS.some((entry) => entry.slug === "google-calendar")).toBe(false);
  });

  it("erlaubt im Anmeldefenster nur die feste Google-Login-Origin", () => {
    expect(toolhubAuthorizeOrigins("google-calendar")).toEqual(["https://accounts.google.com"]);
  });
});

describe("Instanz › Kalender-Konten", () => {
  it("zeigt ohne bestätigte Core-Fähigkeit keinen Hinzufügen-Eintrag", () => {
    const markup = renderToStaticMarkup(<CalendarAccountsSection instanceId="managed:tenant" />);
    expect(markup).not.toContain("calendar.accounts.add");
    expect(markup).not.toContain("Hinzufügen");
  });

  it("startet am Klickort eine Zeile mit Spinner, ohne Erklärtext", () => {
    const markup = renderToStaticMarkup(
      <GoogleDraftRow
        entry={google}
        draft={{ phase: "pending" }}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(markup).toContain('data-workjet-calendar-connect="pending"');
    expect(markup).toContain("Google Kalender");
    expect(markup).toContain("animate-spin");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain('role="alert"');
  });

  it("zeigt je Fehlercode eine deutsche Kurzzeile mit genau einer Aktion", () => {
    for (const [code, failure] of Object.entries(CALENDAR_CONNECT_FAILURES)) {
      const markup = renderToStaticMarkup(
        <GoogleDraftRow
          entry={google}
          draft={{ phase: "failed", code: code as keyof typeof CALENDAR_CONNECT_FAILURES }}
          onRetry={() => {}}
          onDismiss={() => {}}
        />,
      );
      const alert = markup.slice(markup.indexOf('role="alert"'));
      expect(alert).toContain(failure.text);
      expect(alert.match(/<button/g)).toHaveLength(1);
      expect(alert).toContain(failure.action === "retry" ? "Erneut versuchen" : "Schließen");
      expect(markup).not.toContain("animate-spin");
    }
  });
});
