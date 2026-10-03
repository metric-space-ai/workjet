import type { CtoxManagedInstance } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { resolveInstanceOnboardingState, InstanceOnboardingView } from "./InstanceOnboarding";
import { instanceAppsLabel, instanceHostLabel } from "./InstanceNetworkOverview";
import { closeInstanceSetup, instanceSetupStore, openInstanceSetup } from "../../instanceSetup";

vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const alpha: CtoxManagedInstance = {
  id: "alpha",
  displayName: "Alpha",
  source: "local_daemon",
  status: "available",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: true,
    httpDataProxy: false,
    nativePeerObserved: true,
  },
};

describe("instance-first network navigation", () => {
  it("keeps projects inaccessible with no selection, including when another connection was ready", () => {
    expect(
      resolveInstanceOnboardingState({ _tag: "ready", instances: [alpha] }, null, "ready"),
    ).toBe("select");
    expect(
      resolveInstanceOnboardingState(
        { _tag: "ready", instances: [alpha] },
        "removed-instance",
        "ready",
      ),
    ).toBe("select");
    expect(resolveInstanceOnboardingState({ _tag: "ready", instances: [] }, null, "ready")).toBe(
      "create-or-connect",
    );
  });
  it("distinguishes a selected master from a failed, unavailable or still-loading selection", () => {
    expect(resolveInstanceOnboardingState("loading", "alpha", "ready")).toBe("loading");
    expect(
      resolveInstanceOnboardingState({ _tag: "ready", instances: [alpha] }, "alpha", "ready"),
    ).toBe("ready");
    expect(
      resolveInstanceOnboardingState({ _tag: "ready", instances: [alpha] }, "alpha", "revoked"),
    ).toBe("failed");
    expect(
      resolveInstanceOnboardingState(
        {
          _tag: "ready",
          instances: [
            { ...alpha, healthSummary: { ...alpha.healthSummary, dataPlaneReady: false } },
          ],
        },
        "alpha",
        "connecting",
      ),
    ).toBe("connecting");
  });
  it("shows every first-start entry on the main screen without a project action", () => {
    const html = renderToStaticMarkup(
      <InstanceOnboardingView
        state="create-or-connect"
        instances={[]}
        onSelect={() => {}}
        onRefresh={() => {}}
        network={<div>Network fixture</div>}
      />,
    );
    for (const label of [
      "Dieser Computer",
      "SSH-Rechner",
      "Tailscale-Rechner",
      "QR-Code scannen",
      "Link eingeben",
      "Server, Raum und Passwort",
      "ctox.dev",
    ])
      expect(html).toContain(label);
    expect(html).not.toContain("project.add");
    expect(html).not.toContain("Add project");
    expect(html).not.toContain("Business OS hinzufügen");
  });
  it("routes different entry points through one resettable setup request", () => {
    openInstanceSetup("ssh");
    const first = instanceSetupStore.getSnapshot();
    expect(first?.intent).toBe("ssh");
    closeInstanceSetup();
    expect(instanceSetupStore.getSnapshot()).toBeNull();
    openInstanceSetup("manual");
    expect(instanceSetupStore.getSnapshot()?.intent).toBe("manual");
    expect(instanceSetupStore.getSnapshot()?.revision).toBeGreaterThan(first!.revision);
    closeInstanceSetup();
  });
});

describe("network evidence labels", () => {
  it("does not infer an SSH host from a display name or a pairing label", () => {
    expect(instanceHostLabel(alpha)).toBe("Dieser Computer");
    expect(instanceHostLabel({ ...alpha, source: "pairing_invite", displayName: "gpu3" })).toBe(
      "Hostname noch nicht gemeldet",
    );
  });
  it("does not turn an empty cache or a failed query into zero live apps", () => {
    expect(instanceAppsLabel(null)).toBe("Apps: noch nicht geprüft");
    expect(
      instanceAppsLabel({ _tag: "completed", instanceId: "alpha", source: "cache", apps: [] }),
    ).toBe("Apps: noch nicht geprüft");
    expect(
      instanceAppsLabel({ _tag: "completed", instanceId: "alpha", source: "live", apps: [] }),
    ).toBe("0 Apps");
  });
});
