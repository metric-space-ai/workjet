import { describe, expect, it } from "vite-plus/test";

import appSidebarLayoutSource from "../AppSidebarLayout.tsx?raw";
import connectionsRouteSource from "../../routes/settings.connections.tsx?raw";
import settingsRouteSource from "../../routes/settings.tsx?raw";
import sidebarChromeSource from "../sidebar/SidebarChrome.tsx?raw";
import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";

describe("Workjet settings information architecture", () => {
  it("puts Business OS first, keeps Computers, and hides Connections", () => {
    expect(SETTINGS_NAV_ITEMS[0]).toMatchObject({
      label: "Business OS",
      to: "/settings/business-os",
    });
    expect(SETTINGS_NAV_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Computers", to: "/settings/computers" }),
      ]),
    );
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).not.toContain("Connections");
  });

  it("uses the regular Settings route from either product mode", () => {
    expect(appSidebarLayoutSource).toContain('if (isOnSettings) return "settings"');
    expect(appSidebarLayoutSource).toContain("<SettingsSidebarNav pathname={pathname} />");
    expect(appSidebarLayoutSource).not.toContain("WorkjetDevicePairingDialog");
    expect(appSidebarLayoutSource).not.toContain("businessOsSettingsRequestKey");
  });

  it("redirects legacy settings entry points into the regular IA", () => {
    expect(settingsRouteSource).toContain('redirect({ to: "/settings/business-os"');
    expect(connectionsRouteSource).toContain('redirect({ to: "/settings/computers"');
    expect(connectionsRouteSource).not.toContain("ConnectionsSettings");
  });

  it("keeps one labelled Settings footer entry and no global Machines navigation", () => {
    const footerSource = sidebarChromeSource.slice(
      sidebarChromeSource.indexOf("export const SidebarChromeFooter"),
    );
    expect(footerSource.split("<SidebarMenuItem").length - 1).toBe(1);
    expect(footerSource).toContain("<span>Settings</span>");
    expect(footerSource).not.toContain('to: "/machines"');
    expect(footerSource).not.toContain("openWorkjetDevicePairing");
  });
});
