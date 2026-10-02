import type { CtoxManagedInstance } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveSettingsInstanceContext } from "./settingsInstanceContext";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";

const healthSummary = {
  dataPlane: "rxdb-webrtc" as const,
  dataPlaneReady: true,
  httpDataProxy: false as const,
  nativePeerObserved: true,
};
const instance = (id: string, displayName: string): CtoxManagedInstance => ({
  id,
  displayName,
  source: "ctox_dev",
  status: "available",
  healthSummary,
});

describe("settings instance context", () => {
  it("keeps a single instance quiet and reveals the active name for multiple instances", () => {
    const alpha = instance("alpha", "Alpha");
    const beta = instance("beta", "Beta");
    expect(
      resolveSettingsInstanceContext({ _tag: "ready", instances: [alpha] }, "alpha"),
    ).toMatchObject({ isMultiInstance: false, hasActiveInstance: true });
    expect(
      resolveSettingsInstanceContext({ _tag: "ready", instances: [alpha, beta] }, "beta"),
    ).toMatchObject({ isMultiInstance: true, activeInstanceName: "Beta" });
    expect(
      resolveSettingsInstanceContext({ _tag: "ready", instances: [alpha, beta] }, "alpha")
        .activeInstanceName,
    ).toBe("Alpha");
  });

  it("does not expose instance editing for missing, stale or unresolved selections", () => {
    const discovery = { _tag: "ready" as const, instances: [instance("alpha", "Alpha")] };
    for (const id of [null, "removed-instance"]) {
      expect(resolveSettingsInstanceContext(discovery, id)).toMatchObject({
        hasActiveInstance: false,
        activeInstanceName: null,
      });
    }
    expect(resolveSettingsInstanceContext("loading", "alpha").hasActiveInstance).toBe(false);
    expect(
      resolveSettingsInstanceContext({ _tag: "failed", code: "network_error" }, "alpha")
        .hasActiveInstance,
    ).toBe(false);
  });

  it("counts identities, even when discovery repeats an instance or labels coincide", () => {
    const alpha = instance("alpha", "Same name");
    expect(
      resolveSettingsInstanceContext({ _tag: "ready", instances: [alpha, alpha] }, "alpha")
        .isMultiInstance,
    ).toBe(false);
    expect(
      resolveSettingsInstanceContext(
        { _tag: "ready", instances: [alpha, instance("beta", "Same name")] },
        "beta",
      ).isMultiInstance,
    ).toBe(true);
  });

  it("shows the instance in scoped breadcrumbs and leaves management and single-instance breadcrumbs simple", () => {
    const render = (pathname: string, activeInstanceName: string | null = null) =>
      renderToStaticMarkup(SettingsBreadcrumb({ pathname, activeInstanceName }));
    expect(render("/settings/models", "Beta")).toContain("Beta");
    expect(render("/settings/models")).not.toContain("Beta");
    expect(render("/settings/business-os", "Beta")).not.toContain("Beta");
  });
});
