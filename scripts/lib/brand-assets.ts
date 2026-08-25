export const BRAND_ASSET_PATHS = {
  workjetAppIconPng: "assets/workjet/workjet-app-icon.png",
  workjetMacIconIcns: "assets/workjet/workjet-app-icon.icns",
  workjetWindowsIconIco: "assets/workjet/workjet-windows.ico",
  workjetWebFaviconIco: "assets/workjet/workjet-web-favicon.ico",
  workjetWebFavicon16Png: "assets/workjet/workjet-web-favicon-16x16.png",
  workjetWebFavicon32Png: "assets/workjet/workjet-web-favicon-32x32.png",
  workjetWebAppleTouchIconPng: "assets/workjet/workjet-web-apple-touch-180.png",

  developmentIconComposerProject: "assets/dev/app-icon.icon",
  developmentIosIconPng: "assets/dev/blueprint-ios-1024.png",
  developmentUniversalIconPng: "assets/dev/blueprint-universal-1024.png",

  productionIconComposerProject: "assets/prod/app-icon.icon",
  productionIosIconPng: "assets/prod/black-ios-1024.png",
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  productionLinuxIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/t3-black-windows.ico",
  productionWebFaviconIco: "assets/prod/t3-black-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/t3-black-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/t3-black-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/t3-black-web-apple-touch-180.png",

  nightlyIconComposerProject: "assets/nightly/app-icon.icon",
  nightlyIosIconPng: "assets/nightly/nightly-ios-1024.png",
  nightlyMacIconPng: "assets/nightly/nightly-macos-1024.png",
  nightlyLinuxIconPng: "assets/nightly/nightly-universal-1024.png",
  nightlyWindowsIconIco: "assets/nightly/nightly-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/nightly-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/nightly/nightly-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/nightly/nightly-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/nightly-web-apple-touch-180.png",

  ctoxAppIconPng: "assets/ctox/ctox-app-icon.png",
  ctoxMacIconIcns: "assets/ctox/ctox-app-icon.icns",
  // Mobile derivatives of the CTOX mark (generated from ctox-app-icon.png):
  // full-bleed 1024 for iOS icon + splash, safe-zone padded adaptive
  // foreground, and white-on-transparent monochrome/notification marks.
  ctoxIosIconPng: "assets/ctox/ctox-ios-1024.png",
  ctoxAndroidAdaptiveForegroundPng: "assets/ctox/ctox-android-adaptive-foreground.png",
  ctoxAndroidMonochromePng: "assets/ctox/ctox-android-monochrome.png",
  ctoxAndroidNotificationPng: "assets/ctox/ctox-android-notification.png",
  ctoxWindowsIconIco: "assets/ctox/ctox-windows.ico",
  ctoxWebFaviconIco: "assets/ctox/ctox-web-favicon.ico",
  ctoxWebFavicon16Png: "assets/ctox/ctox-web-favicon-16x16.png",
  ctoxWebFavicon32Png: "assets/ctox/ctox-web-favicon-32x32.png",
  ctoxWebAppleTouchIconPng: "assets/ctox/ctox-web-apple-touch-180.png",

  developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
} as const;

export type WebAssetBrand = "workjet";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  void channel;
  return "workjet";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  void version;
  return "workjet";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  workjet: {
    faviconIco: BRAND_ASSET_PATHS.workjetWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.workjetWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.workjetWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.workjetWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("workjet", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "workjet",
  "apps/web/public",
);
