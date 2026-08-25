export const BUSINESS_OS_ICON_PACK_TYPE = "ctox.business-os-icon-pack.v1" as const;

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_ASSET_PATH = /^icons\/[a-z0-9][a-z0-9._/-]{0,220}\.png$/u;

export interface BusinessOsIconPackEntry {
  readonly appId: string;
  readonly iconAssetId: string;
  readonly accessibilityLabel: string;
  readonly format: "png";
  readonly pixelSize: { readonly width: number; readonly height: number };
  readonly ios: {
    readonly standard: string;
    readonly dark: string;
    readonly tinted: string;
  };
  readonly android: {
    readonly foreground: string;
    readonly background: string;
    readonly monochrome: string;
  };
  readonly web: { readonly standard: string };
}

export interface BusinessOsIconPackV1 {
  readonly type: typeof BUSINESS_OS_ICON_PACK_TYPE;
  readonly familyVersion: 1;
  readonly apps: readonly BusinessOsIconPackEntry[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function assetPath(value: unknown): value is string {
  return typeof value === "string" && SAFE_ASSET_PATH.test(value) && !value.includes("../");
}

export function decodeBusinessOsIconPack(value: unknown): BusinessOsIconPackV1 {
  const pack = record(value);
  if (
    !pack ||
    !onlyKeys(pack, ["type", "familyVersion", "apps"]) ||
    pack.type !== BUSINESS_OS_ICON_PACK_TYPE ||
    pack.familyVersion !== 1 ||
    !Array.isArray(pack.apps) ||
    pack.apps.length > 256
  ) {
    throw new Error("Business OS icon pack is invalid.");
  }

  const appIds = new Set<string>();
  const assetIds = new Set<string>();
  const paths = new Set<string>();
  const apps = pack.apps.map((raw) => {
    const app = record(raw);
    const ios = record(app?.ios);
    const android = record(app?.android);
    const web = record(app?.web);
    const pixelSize = record(app?.pixelSize);
    if (
      !app ||
      !onlyKeys(app, [
        "appId",
        "iconAssetId",
        "accessibilityLabel",
        "format",
        "pixelSize",
        "ios",
        "android",
        "web",
      ]) ||
      typeof app.appId !== "string" ||
      !SAFE_ID.test(app.appId) ||
      app.appId === "desktop" ||
      appIds.has(app.appId) ||
      typeof app.iconAssetId !== "string" ||
      !SAFE_ID.test(app.iconAssetId) ||
      assetIds.has(app.iconAssetId) ||
      typeof app.accessibilityLabel !== "string" ||
      app.accessibilityLabel.length < 1 ||
      app.accessibilityLabel.length > 80 ||
      app.format !== "png" ||
      !pixelSize ||
      !onlyKeys(pixelSize, ["width", "height"]) ||
      !Number.isSafeInteger(pixelSize.width) ||
      !Number.isSafeInteger(pixelSize.height) ||
      (pixelSize.width as number) < 64 ||
      (pixelSize.width as number) > 4_096 ||
      pixelSize.width !== pixelSize.height ||
      !ios ||
      !onlyKeys(ios, ["standard", "dark", "tinted"]) ||
      !android ||
      !onlyKeys(android, ["foreground", "background", "monochrome"]) ||
      !web ||
      !onlyKeys(web, ["standard"])
    ) {
      throw new Error("Business OS icon entry is invalid.");
    }
    const entryPaths = [
      ios.standard,
      ios.dark,
      ios.tinted,
      android.foreground,
      android.background,
      android.monochrome,
      web.standard,
    ];
    if (entryPaths.some((path) => !assetPath(path) || paths.has(path))) {
      throw new Error("Business OS icon asset path is invalid or duplicated.");
    }
    appIds.add(app.appId);
    assetIds.add(app.iconAssetId);
    for (const path of entryPaths as string[]) paths.add(path);
    return Object.freeze({
      appId: app.appId,
      iconAssetId: app.iconAssetId,
      accessibilityLabel: app.accessibilityLabel,
      format: "png" as const,
      pixelSize: Object.freeze({
        width: pixelSize.width as number,
        height: pixelSize.height as number,
      }),
      ios: Object.freeze({
        standard: ios.standard as string,
        dark: ios.dark as string,
        tinted: ios.tinted as string,
      }),
      android: Object.freeze({
        foreground: android.foreground as string,
        background: android.background as string,
        monochrome: android.monochrome as string,
      }),
      web: Object.freeze({ standard: web.standard as string }),
    });
  });

  return Object.freeze({
    type: BUSINESS_OS_ICON_PACK_TYPE,
    familyVersion: 1,
    apps: Object.freeze(apps),
  });
}

export function iconPackAssetPaths(pack: BusinessOsIconPackV1): readonly string[] {
  return Object.freeze(
    pack.apps.flatMap((app) => [
      app.ios.standard,
      app.ios.dark,
      app.ios.tinted,
      app.android.foreground,
      app.android.background,
      app.android.monochrome,
      app.web.standard,
    ]),
  );
}
