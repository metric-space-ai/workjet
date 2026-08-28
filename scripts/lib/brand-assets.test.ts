import { describe, expect, it } from "vite-plus/test";

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_ICON_OVERRIDES,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  resolveWebAssetBrandForChannel,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

describe("brand-assets", () => {
  it("maps Workjet web assets into the server package", () => {
    expect(resolveWebIconOverrides("workjet", "dist/client")).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.workjetWebFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.workjetWebFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.workjetWebFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.workjetWebAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
    ]);
  });

  it("maps the desktop renderer to Workjet icons", () => {
    expect(DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.workjetWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    });
  });

  it("maps Workjet web assets to the development splash and favicon files", () => {
    expect(DEVELOPMENT_PUBLIC_ICON_OVERRIDES).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.workjetWebFaviconIco,
        targetRelativePath: "apps/web/public/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.workjetWebFavicon16Png,
        targetRelativePath: "apps/web/public/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.workjetWebFavicon32Png,
        targetRelativePath: "apps/web/public/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.workjetWebAppleTouchIconPng,
        targetRelativePath: "apps/web/public/apple-touch-icon.png",
      },
    ]);
  });

  it("can target hosted web dist directly", () => {
    expect(resolveWebIconOverrides("workjet", "apps/web/dist")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.workjetWebAppleTouchIconPng,
      targetRelativePath: "apps/web/dist/apple-touch-icon.png",
    });
  });

  it("maps every hosted release channel to Workjet assets", () => {
    expect(resolveWebAssetBrandForChannel("latest")).toBe("workjet");
    expect(resolveWebAssetBrandForChannel("nightly")).toBe("workjet");
  });

  it("maps every package version to Workjet assets", () => {
    expect(resolveWebAssetBrandForPackageVersion("0.0.29")).toBe("workjet");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29-nightly.20260723.882")).toBe("workjet");
  });

  it("declares Workjet desktop and renderer artwork", () => {
    expect(BRAND_ASSET_PATHS.workjetAppIconPng).toBe("assets/workjet/workjet-app-icon.png");
    expect(BRAND_ASSET_PATHS.workjetMacIconIcns).toBe("assets/workjet/workjet-app-icon.icns");
    expect(BRAND_ASSET_PATHS.workjetWindowsIconIco).toBe("assets/workjet/workjet-windows.ico");
    expect(resolveWebIconOverrides("workjet", "dist/client")).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.workjetWebAppleTouchIconPng,
      targetRelativePath: "dist/client/apple-touch-icon.png",
    });
  });

  it("retains legacy icon-composer inputs only for compatibility exports", () => {
    expect([
      BRAND_ASSET_PATHS.developmentIconComposerProject,
      BRAND_ASSET_PATHS.nightlyIconComposerProject,
      BRAND_ASSET_PATHS.productionIconComposerProject,
    ]).toEqual([
      "assets/dev/app-icon.icon",
      "assets/nightly/app-icon.icon",
      "assets/prod/app-icon.icon",
    ]);
    expect(BRAND_ASSET_PATHS.developmentDesktopIconPng).toMatch(/^assets\/dev\/blueprint-/);
    expect(BRAND_ASSET_PATHS.nightlyMacIconPng).toMatch(/^assets\/nightly\/nightly-/);
    expect(BRAND_ASSET_PATHS.productionMacIconPng).toMatch(/^assets\/prod\/black-/);
  });
});
