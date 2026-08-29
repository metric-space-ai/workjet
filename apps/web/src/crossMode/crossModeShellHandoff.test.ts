import type { CtoxManagedInstance } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import appSidebarLayoutSource from "../components/AppSidebarLayout.tsx?raw";
import { resolveCrossModeBusinessOsActivation } from "../components/ctox/CtoxModeShell";
import type { CrossModeBusinessOsRequest } from "./crossModeBusinessOsHandoff";

const healthy = {
  dataPlane: "rxdb-webrtc" as const,
  dataPlaneReady: true,
  httpDataProxy: false as const,
  nativePeerObserved: true,
};

function instance(
  input: Partial<CtoxManagedInstance> & Pick<CtoxManagedInstance, "id" | "source" | "displayName">,
): CtoxManagedInstance {
  return { status: "available", healthSummary: healthy, ...input };
}

const available = instance({
  id: "instance-alpha",
  source: "ctox_dev",
  displayName: "Alpha",
});
const offline = instance({
  id: "instance-beta",
  source: "ctox_dev",
  displayName: "Beta",
  status: "offline",
});

const request = (
  overrides: Partial<CrossModeBusinessOsRequest> = {},
): CrossModeBusinessOsRequest => ({ instanceId: "instance-alpha", ...overrides });

describe("resolveCrossModeBusinessOsActivation", () => {
  it("selects the requested instance", () => {
    expect(resolveCrossModeBusinessOsActivation(request(), [available, offline])).toEqual({
      instance: available,
    });
  });

  it("carries the app module through when the link named one", () => {
    expect(resolveCrossModeBusinessOsActivation(request({ moduleId: "crm" }), [available])).toEqual(
      { instance: available, moduleId: "crm" },
    );
  });

  it("leaves the request pending while its instance is still undiscovered", () => {
    // Not "drops it": discovery refreshes, the effect re-runs, and the link is
    // honoured then. A link that arrives before its instance is listed must
    // not silently do nothing forever.
    expect(resolveCrossModeBusinessOsActivation(request(), [])).toBeNull();
    expect(resolveCrossModeBusinessOsActivation(request(), [offline])).toBeNull();
  });

  it("refuses an instance that cannot be activated", () => {
    expect(
      resolveCrossModeBusinessOsActivation(request({ instanceId: "instance-beta" }), [offline]),
    ).toBeNull();
  });

  it("does nothing without a request", () => {
    expect(resolveCrossModeBusinessOsActivation(null, [available])).toBeNull();
  });
});

describe("the two main surfaces are structurally exclusive", () => {
  /**
   * The navigator guarantees the ORDER of teardown and mount. This guards the
   * other half of "without mounting both surfaces simultaneously": the shell
   * must not have a state in which the Business OS main surface and the Code
   * route outlet are both in the tree. `AppSidebarLayout` expresses that as a
   * single ternary, and a refactor that split it into two independent
   * conditions would silently allow both — so the shape is asserted here, the
   * way `DesktopDeepLinkRouter.test.ts` asserts its registration ordering
   * against the source.
   */
  it("renders CtoxMainShell and the Code outlet in one ternary", () => {
    expect(appSidebarLayoutSource).toContain("{isCtoxShell ? <CtoxMainShell /> : children}");
    // Exactly one place mounts either main surface.
    expect(appSidebarLayoutSource.split("<CtoxMainShell").length - 1).toBe(1);
  });

  it("keeps one CTOX scope mounted while only the native surface follows the mode", () => {
    // Selection, discovery and the pooled WebRTC guest are Workjet-shell
    // state. Tearing the provider down on Code/Settings changes used to create
    // a second selection authority and reconnect the guest. Visibility is now
    // the only mode-dependent part.
    expect(appSidebarLayoutSource).toContain("<CtoxModeProvider businessOsVisible={isCtoxShell}>");
    expect(appSidebarLayoutSource).not.toContain("function CtoxModeBoundary");
    expect(appSidebarLayoutSource.split("<CtoxModeProvider").length - 1).toBe(1);
  });
});
