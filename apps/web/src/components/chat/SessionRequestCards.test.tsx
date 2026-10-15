import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useClientSettings } from "../../hooks/useSettings";
import { settingsNavItems } from "../settings/settingsNavigation";
import { searchSettings } from "../settings/settingsSearch";
import {
  CONNECTABLE_INTEGRATIONS,
  IntegrationsSettingsPanel,
} from "../settings/IntegrationsSettings";
import { INTEGRATIONS } from "../settings/integrationsCatalog";
import { canSubmitCredential } from "../toolhub/ToolhubCards";
import {
  cacheable,
  SessionRequestCards,
  visibleRequests,
  type SessionUiRequest,
} from "./SessionRequestCards";

vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../hooks/useSettings")>();
  return { ...original, useClientSettings: vi.fn() };
});

const developerMode = (enabled: boolean) =>
  vi
    .mocked(useClientSettings)
    .mockImplementation(((selector?: (settings: { developerMode: boolean }) => unknown) =>
      selector
        ? selector({ developerMode: enabled })
        : { developerMode: enabled }) as unknown as typeof useClientSettings);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Schnittstellen without developer mode", () => {
  it("offers no entry in settings navigation or search", () => {
    const navPaths = (developer: boolean) => settingsNavItems(developer).map((item) => item.to);
    const searchHits = (developer: boolean) =>
      searchSettings("Schnittstellen", { developerMode: developer }).filter(
        (item) => item.to === "/settings/integrations",
      );
    expect(navPaths(false)).not.toContain("/settings/integrations");
    expect(navPaths(true)).toContain("/settings/integrations");
    expect(navPaths(false)).toContain("/settings/general");
    expect(searchHits(false)).toHaveLength(0);
    expect(searchHits(true)).not.toHaveLength(0);
  });

  it("mounts neither the store nor the pinned request cards", () => {
    developerMode(false);
    expect(IntegrationsSettingsPanel()).toBeNull();
    expect(SessionRequestCards({ sessionId: "t1" })).toBeNull();
    developerMode(true);
    expect(IntegrationsSettingsPanel()).not.toBeNull();
    expect(SessionRequestCards({ sessionId: "t1" })).not.toBeNull();
  });

  it("never polls the guest or calls the desktop bridge", () => {
    vi.useFakeTimers();
    const toolhubRequest = vi.fn(async () => ({ status: 200, body: { requests: [] } }));
    const toolhubAuthorize = vi.fn();
    vi.stubGlobal("window", { desktopBridge: { toolhubRequest, toolhubAuthorize } });
    developerMode(false);
    expect(renderToStaticMarkup(<SessionRequestCards sessionId="t1" />)).toBe("");
    expect(renderToStaticMarkup(<IntegrationsSettingsPanel />)).toBe("");
    vi.advanceTimersByTime(30_000);
    expect(toolhubRequest).not.toHaveBeenCalled();
    expect(toolhubAuthorize).not.toHaveBeenCalled();
  });
});

const base: SessionUiRequest = {
  id: "a",
  kind: "credential",
  status: "open",
  toolkit: "slack",
  fields: [{ name: "token", secret: true }],
  created_at: 1000,
};

describe("visibleRequests", () => {
  it("pins open requests for this session and unscoped ones, hides other sessions", () => {
    const all = [
      { ...base, id: "mine", session: "t1" },
      { ...base, id: "any" },
      { ...base, id: "other", session: "t2" },
    ];
    expect(visibleRequests(all, "t1").map((r) => r.id)).toEqual(["mine", "any"]);
  });
  it("keeps open requests pinned no matter how old, oldest first", () => {
    const all = [
      { ...base, id: "new", created_at: 5000 },
      { ...base, id: "old", created_at: 10 },
    ];
    expect(visibleRequests(all, null).map((r) => r.id)).toEqual(["old", "new"]);
  });
  it("drops resolved cards right away (no status pill)", () => {
    const done = { ...base, status: "done" as const, resolved_at: 1000 };
    expect(visibleRequests([done], null)).toHaveLength(0);
  });
});

describe("cacheable", () => {
  it("keeps only open request metadata for the restart cache", () => {
    const list = [base, { ...base, id: "b", status: "declined" as const }];
    expect(cacheable(list).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("canSubmitCredential", () => {
  const secrets = [{ name: "token", secret: true }];
  const params = [
    { key: "subdomain", required: true },
    { key: "region", required: false },
  ];
  it("needs every secret and every required param", () => {
    expect(canSubmitCredential(secrets, params, { token: "x" })).toBe(false);
    expect(canSubmitCredential(secrets, params, { token: " ", subdomain: "acme" })).toBe(false);
    expect(canSubmitCredential(secrets, params, { token: "x", subdomain: "acme" })).toBe(true);
  });
});

describe("store tiles", () => {
  it("shows only entries that can be connected", () => {
    expect(CONNECTABLE_INTEGRATIONS.length).toBeGreaterThan(0);
    expect(CONNECTABLE_INTEGRATIONS.every((e) => e.connect !== null)).toBe(true);
    expect(CONNECTABLE_INTEGRATIONS).toHaveLength(
      INTEGRATIONS.filter((e) => e.connect !== null).length,
    );
  });
});
