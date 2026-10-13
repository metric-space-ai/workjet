import { describe, expect, it } from "vite-plus/test";

import appSidebarLayoutSource from "../AppSidebarLayout.tsx?raw";
import routeTreeSource from "../../routeTree.gen.ts?raw";
import settingsRouteSource from "../../routes/settings.tsx?raw";
import sidebarChromeSource from "../sidebar/SidebarChrome.tsx?raw";
import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";
import { searchSettings } from "./settingsSearch";

describe("Workjet settings information architecture", () => {
  it("puts instances first, keeps Computers, and hides Connections", () => {
    expect(SETTINGS_NAV_ITEMS[0]).toMatchObject({
      label: "Instanzen",
      to: "/settings/business-os",
    });
    expect(SETTINGS_NAV_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Rechner", to: "/settings/computers" }),
      ]),
    );
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).not.toContain("Connections");
    expect(SETTINGS_NAV_ITEMS.map((item) => item.to)).not.toContain("/settings/keybindings");
    expect(searchSettings("Keybindings")).toEqual([]);
  });

  it("uses the regular Settings route from either product mode", () => {
    expect(appSidebarLayoutSource).toContain('if (isOnSettings) return "settings"');
    expect(appSidebarLayoutSource).toContain("<SettingsSidebarNav pathname={pathname} />");
    expect(appSidebarLayoutSource).not.toContain("WorkjetDevicePairingDialog");
    expect(appSidebarLayoutSource).not.toContain("businessOsSettingsRequestKey");
  });

  it("redirects the settings root and has no hidden settings routes", () => {
    expect(settingsRouteSource).toContain('redirect({ to: "/settings/business-os"');
    expect(routeTreeSource).not.toContain("fullPath: '/settings/connections'");
    expect(routeTreeSource).not.toContain("fullPath: '/settings/keybindings'");
  });

  it("has no pages outside Dev, Ops and Settings: /machines is gone, usage is Settings › Verbrauch", () => {
    expect(routeTreeSource).not.toContain("fullPath: '/machines'");
    expect(routeTreeSource).not.toContain("fullPath: '/usage'");
    expect(routeTreeSource).toContain("fullPath: '/settings/usage'");
    expect(SETTINGS_NAV_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Verbrauch", to: "/settings/usage" }),
      ]),
    );
  });

  it("keeps one labelled Settings footer entry and no global Machines navigation", () => {
    const footerSource = sidebarChromeSource.slice(
      sidebarChromeSource.indexOf("export const SidebarChromeFooter"),
    );
    expect(footerSource.split("<SidebarMenuItem").length - 1).toBe(1);
    expect(footerSource).toContain("<span>Einstellungen</span>");
    expect(footerSource).not.toContain('to: "/machines"');
    expect(footerSource).not.toContain("openWorkjetDevicePairing");
  });
});
