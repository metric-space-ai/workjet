import { describe, expect, it } from "vite-plus/test";

import { resolveAppSidebarSurface } from "./AppSidebarLayout";

describe("AppSidebarLayout mode ownership", () => {
  it("never renders Code settings while Business OS owns the shell", () => {
    expect(resolveAppSidebarSurface({ productMode: "ctox", isOnSettings: false })).toBe(
      "business-os",
    );
    expect(resolveAppSidebarSurface({ productMode: "ctox", isOnSettings: true })).toBe(
      "business-os",
    );
  });

  it("keeps the existing Code and Code-settings surfaces separate", () => {
    expect(resolveAppSidebarSurface({ productMode: "code", isOnSettings: false })).toBe("code");
    expect(resolveAppSidebarSurface({ productMode: "code", isOnSettings: true })).toBe("settings");
  });
});
