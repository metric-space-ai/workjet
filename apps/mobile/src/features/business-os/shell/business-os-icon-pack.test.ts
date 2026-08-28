import { describe, expect, it } from "vite-plus/test";

import { BUSINESS_OS_ICON_PACK_TYPE, decodeBusinessOsIconPack } from "./business-os-icon-pack";

const app = {
  appId: "threads",
  iconAssetId: "workjet.business-os.threads",
  accessibilityLabel: "Threads",
  format: "png",
  pixelSize: { width: 1024, height: 1024 },
  ios: {
    standard: "icons/threads/ios-standard.png",
    dark: "icons/threads/ios-dark.png",
    tinted: "icons/threads/ios-tinted.png",
  },
  android: {
    foreground: "icons/threads/android-foreground.png",
    background: "icons/threads/android-background.png",
    monochrome: "icons/threads/android-monochrome.png",
  },
  web: { standard: "icons/threads/web.png" },
} as const;

const pack = (entry: object = app) => ({
  type: BUSINESS_OS_ICON_PACK_TYPE,
  familyVersion: 1,
  apps: [entry],
});

describe("Business OS signed icon pack", () => {
  it("accepts bounded local platform assets", () => {
    expect(decodeBusinessOsIconPack(pack()).apps[0]).toMatchObject(app);
  });

  it.each([
    { ...app, appId: "desktop" },
    { ...app, format: "svg" },
    { ...app, pixelSize: { width: 1024, height: 512 } },
    { ...app, ios: { ...app.ios, standard: "../remote.png" } },
    { ...app, web: { standard: "https://example.com/icon.png" } },
    { ...app, html: "<svg/>" },
  ])("rejects desktop, markup, remote, traversal, and malformed assets", (entry) => {
    expect(() => decodeBusinessOsIconPack(pack(entry))).toThrow();
  });
});
