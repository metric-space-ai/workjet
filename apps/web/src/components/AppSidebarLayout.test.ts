import { describe, expect, it } from "vite-plus/test";

import appSidebarLayoutSource from "./AppSidebarLayout.tsx?raw";
import { resolveAppSidebarSurface } from "./AppSidebarLayout";

describe("AppSidebarLayout mode ownership", () => {
  it("uses the same settings surface in Code and Business OS", () => {
    expect(resolveAppSidebarSurface({ productMode: "ctox", isOnSettings: false })).toBe(
      "business-os",
    );
    expect(resolveAppSidebarSurface({ productMode: "ctox", isOnSettings: true })).toBe("settings");
    expect(resolveAppSidebarSurface({ productMode: "code", isOnSettings: true })).toBe("settings");
  });

  it("keeps the existing Code and Code-settings surfaces separate", () => {
    expect(resolveAppSidebarSurface({ productMode: "code", isOnSettings: false })).toBe("code");
    expect(resolveAppSidebarSurface({ productMode: "code", isOnSettings: true })).toBe("settings");
  });

  it("does not render either product surface before persisted settings hydrate", () => {
    expect(appSidebarLayoutSource).toContain("useClientSettingsHydrated()");
    expect(appSidebarLayoutSource).toContain('data-product-mode-shell="loading"');
    expect(appSidebarLayoutSource).toContain(
      "return <HydratedAppSidebarLayout>{children}</HydratedAppSidebarLayout>",
    );
  });

  it("keeps pairing and mode-specific settings dialogs out of the global layout", () => {
    expect(appSidebarLayoutSource).not.toContain("WorkjetDevicePairingDialog");
    expect(appSidebarLayoutSource).not.toContain("businessOsSettingsRequestKey");
    expect(appSidebarLayoutSource).not.toContain("openSettingsRequestKey=");
    expect(appSidebarLayoutSource).toContain("<SettingsSidebarNav pathname={pathname} />");
  });

  it("mounts one shared active-instance selector above every mode-specific sidebar", () => {
    expect(appSidebarLayoutSource.split("<ActiveCtoxInstanceSelector").length - 1).toBe(1);
    expect(appSidebarLayoutSource).toContain(
      "<ActiveCtoxInstanceSelector productMode={productMode} />",
    );
    expect(appSidebarLayoutSource).toContain("[&_[data-slot=sidebar-header]]:order-[-2]");
  });
});
