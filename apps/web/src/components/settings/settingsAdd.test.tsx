import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CALENDAR_INTEGRATION_SLUGS } from "./CalendarAccountsSettings";
import { SettingsAddButton, SettingsLoadingRow } from "./settingsAdd";
import { searchSettings } from "./settingsSearch";

describe("settings add pattern (Audit C 4)", () => {
  it("opens a single kind directly as a primary button", () => {
    const markup = renderToStaticMarkup(
      <SettingsAddButton action="x.add" options={[{ label: "Gerät", onSelect: () => {} }]} />,
    );
    expect(markup).toContain('data-workjet-action="x.add"');
    expect(markup).toContain("Hinzufügen");
    expect(markup).not.toContain('aria-haspopup="menu"');
  });

  it("renders nothing when no kind can be added, never a dead button", () => {
    const markup = renderToStaticMarkup(
      <SettingsAddButton
        options={[
          { label: "A", onSelect: () => {}, disabled: true },
          { label: "B", onSelect: () => {}, disabled: true },
        ]}
      />,
    );
    expect(markup).toBe("");
  });
});

describe("settings loading row (Audit C 5)", () => {
  it("shows a quiet skeleton instead of a dash", () => {
    const markup = renderToStaticMarkup(<SettingsLoadingRow onRetry={() => {}} />);
    expect(markup).toContain('data-slot="settings-loading"');
    expect(markup).not.toContain("—");
  });
});

describe("calendar accounts (Audit C 10)", () => {
  it("are found by the search „Kalender“ without developer mode", () => {
    const hits = searchSettings("Kalender", { developerMode: false });
    expect(hits.map((item) => item.id)).toContain("instance-calendar-accounts");
    expect(hits.find((item) => item.id === "instance-calendar-accounts")?.to).toBe(
      "/settings/business-os",
    );
  });

  it("know the catalog's calendar apps", () => {
    expect(CALENDAR_INTEGRATION_SLUGS).toContain("google-calendar");
  });
});
