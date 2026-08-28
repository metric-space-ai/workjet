import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_IN_BUSINESS_OS_MOBILE_CATALOG,
  BUSINESS_OS_MOBILE_CATALOG_TYPE,
  decodeBusinessOsMobileAppCatalog,
} from "./business-os-app-catalog";

const descriptor = {
  id: "runtime-app",
  title: "Runtime App",
  category: "Workspace",
  iconAssetId: "runtime.runtime-app",
  iconFamilyVersion: 1,
  iconRequired: false,
  accent: "#2563eb",
  mobilePresentation: "list-detail",
  phoneReady: true,
  tabletReady: true,
} as const;

describe("Business OS mobile app catalog", () => {
  it("contains exactly 34 stable signed icon identities", () => {
    const apps = BUILT_IN_BUSINESS_OS_MOBILE_CATALOG.apps;
    expect(apps).toHaveLength(34);
    expect(apps.some((app) => app.id === "desktop")).toBe(false);
    expect(new Set(apps.map((app) => app.iconAssetId)).size).toBe(34);
    expect(apps.every((app) => app.iconFamilyVersion === 1 && app.iconRequired)).toBe(true);
  });

  it("accepts only the bounded signed-asset descriptor", () => {
    expect(
      decodeBusinessOsMobileAppCatalog({
        type: BUSINESS_OS_MOBILE_CATALOG_TYPE,
        revision: "test",
        apps: [descriptor],
      }).apps[0],
    ).toMatchObject(descriptor);
  });

  it.each([
    { ...descriptor, id: "desktop" },
    { ...descriptor, iconSvg: "<svg/>" },
    { ...descriptor, iconUrl: "https://example.com/icon.png" },
    { ...descriptor, iconFamilyVersion: 2 },
    { ...descriptor, iconAssetId: "../icon" },
  ])("rejects desktop, markup, remote, or untrusted icon descriptors", (app) => {
    expect(() =>
      decodeBusinessOsMobileAppCatalog({
        type: BUSINESS_OS_MOBILE_CATALOG_TYPE,
        revision: "test",
        apps: [app],
      }),
    ).toThrow();
  });
});
