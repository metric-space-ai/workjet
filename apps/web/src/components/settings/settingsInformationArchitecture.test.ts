import { describe, expect, it } from "vite-plus/test";

import appSidebarLayoutSource from "../AppSidebarLayout.tsx?raw";
import routeTreeSource from "../../routeTree.gen.ts?raw";
import settingsRouteSource from "../../routes/settings.tsx?raw";
import appearanceRouteSource from "../../routes/settings.appearance.tsx?raw";
import projectRouteSource from "../../routes/settings.projects.$projectKey.tsx?raw";
import sidebarChromeSource from "../sidebar/SidebarChrome.tsx?raw";
import {
  DEVELOPER_SETTINGS_NAV_ITEMS,
  SETTINGS_NAV_ITEMS,
  settingsNavItems,
} from "./settingsNavigation";

describe("Workjet settings information architecture (#568)", () => {
  it("has exactly eight pages, thirteen in developer mode", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).toEqual([
      "Allgemein",
      "Instanz",
      "Rechner",
      "Modelle",
      "Lumas",
      "Projekte",
      "Sprachausgabe",
      "Archiv",
    ]);
    expect(settingsNavItems(false)).toHaveLength(8);
    expect(settingsNavItems(true)).toHaveLength(13);
    expect(DEVELOPER_SETTINGS_NAV_ITEMS.slice(8).map((item) => item.label)).toEqual([
      "Diagnose",
      "Harnesses",
      "Schnittstellen",
      "Versionsverwaltung",
      "Tastenkürzel",
    ]);
  });

  it("keeps every former page reachable: old routes redirect or are subpages", () => {
    for (const path of [
      "/settings/appearance",
      "/settings/prompts",
      "/settings/usage",
      "/settings/business-os",
      "/settings/harnesses",
      "/settings/keybindings",
      "/settings/projects/$projectKey",
    ]) {
      expect(routeTreeSource).toContain(`fullPath: '${path}'`);
    }
    expect(appearanceRouteSource).toContain('redirect({ to: "/settings/general"');
    expect(projectRouteSource).toContain("ProjectCardRedirect");
    expect(settingsRouteSource).toContain('redirect({ to: "/settings/general"');
    expect(routeTreeSource).not.toContain("fullPath: '/settings/connections'");
  });

  it("uses the regular Settings route from either product mode", () => {
    expect(appSidebarLayoutSource).toContain('if (isOnSettings) return "settings"');
    expect(settingsRouteSource).toContain("<SettingsSidebarNav pathname={location.pathname} />");
    expect(settingsRouteSource).toContain("<SettingsCompactNav pathname={location.pathname} />");
  });

  it("has no pages outside Dev, Ops and Settings", () => {
    expect(routeTreeSource).not.toContain("fullPath: '/machines'");
    expect(routeTreeSource).not.toContain("fullPath: '/usage'");
  });

  it("keeps one labelled Settings footer entry and no global Machines navigation", () => {
    const footerSource = sidebarChromeSource.slice(
      sidebarChromeSource.indexOf("export const SidebarChromeFooter"),
    );
    expect(footerSource.split("<SidebarMenuItem").length - 1).toBe(1);
    expect(footerSource).toContain("<span>Einstellungen</span>");
    expect(footerSource).not.toContain('to: "/machines"');
  });
});
