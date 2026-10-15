import type { CtoxManagedInstance } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  canMountSelectedInstance,
  INSTANCE_ONBOARDING_SLOW_MS,
  resolveInstanceOnboardingState,
  startInstanceOnboardingSlowTimer,
  InstanceOnboardingView,
  InstanceNavigationBoundary,
  InstanceSidebarBoundary,
  InstanceWorkspaceBoundary,
  WorkjetKeyRecoveryView,
} from "./InstanceOnboarding";
import { instanceAppsLabel, instanceHostLabel } from "./InstanceNetworkOverview";
import { closeInstanceSetup, instanceSetupStore, openInstanceSetup } from "../../instanceSetup";

vi.mock("./CtoxModeShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./CtoxModeShell")>()),
  useCtoxMode: () => ({
    bridge: {},
    discovery: {
      _tag: "ready",
      instances: [{ ...alpha, healthSummary: { ...alpha.healthSummary, dataPlaneReady: false } }],
    },
    selectedId: alpha.id,
    connection: "connecting",
  }),
}));

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
  it("shows exactly one recovery action and blocks the old workspace until sign-in", () => {
    const html = renderToStaticMarkup(
      <WorkjetKeyRecoveryView onLogin={() => undefined} catalogReset />,
    );
    expect(html).toContain("Neu anmelden");
    expect(html).toContain("Bei ctox.dev anmelden");
    expect(html).not.toContain("Schlüssel verloren");
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).not.toContain("Reconnect Workjet Desktop");
    expect(html).not.toContain("Back up and reset");
    expect(
      resolveInstanceOnboardingState(
        {
          _tag: "ready",
          instances: [alpha],
          keyRecovery: { pendingLogin: true, connectionCatalogReset: true },
        },
        alpha.id,
        "ready",
      ),
    ).toBe("create-or-connect");
  });
  it("renders the selected Code workspace and project sidebar before an Ops guest exists", () => {
    const html = renderToStaticMarkup(
      <InstanceWorkspaceBoundary surface="code">
        <main>Native project workspace</main>
        <InstanceSidebarBoundary surface="code">
          <InstanceNavigationBoundary>
            <button>Native project action</button>
          </InstanceNavigationBoundary>
        </InstanceSidebarBoundary>
      </InstanceWorkspaceBoundary>,
    );
    expect(html).toContain("Native project workspace");
    expect(html).toContain("Native project action");
    expect(html).not.toContain('data-workjet-onboarding="instance"');
  });

  it("mounts selected Code before Ops is opened without claiming native readiness", () => {
    const pending = {
      ...alpha,
      healthSummary: {
        ...alpha.healthSummary,
        dataPlaneReady: false,
        nativePeerObserved: false,
      },
    };
    const state = resolveInstanceOnboardingState(
      { _tag: "ready", instances: [pending] },
      pending.id,
      "connecting",
    );
    expect(state).toBe("connecting");
    expect(canMountSelectedInstance(state)).toBe(true);
    expect(pending.healthSummary.dataPlaneReady).toBe(false);
    expect(pending.healthSummary.nativePeerObserved).toBe(false);
  });
  it("does not mount a missing, foreign, unavailable, failed or revoked selection", () => {
    const discovery = { _tag: "ready" as const, instances: [alpha] };
    const states = [
      resolveInstanceOnboardingState("loading", alpha.id, "ready"),
      resolveInstanceOnboardingState(discovery, null, "ready"),
      resolveInstanceOnboardingState(discovery, "foreign-instance", "ready"),
      resolveInstanceOnboardingState(discovery, alpha.id, "error"),
      resolveInstanceOnboardingState(discovery, alpha.id, "revoked"),
      resolveInstanceOnboardingState(
        { _tag: "ready", instances: [{ ...alpha, status: "offline" }] },
        alpha.id,
        "ready",
      ),
      resolveInstanceOnboardingState({ _tag: "ready", instances: [] }, null, "ready"),
    ];
    for (const state of states) expect(canMountSelectedInstance(state)).toBe(false);
  });
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
  it("shows a calm first-start state with exactly one action and never the network", () => {
    const html = renderToStaticMarkup(
      <InstanceOnboardingView
        state="create-or-connect"
        instances={[]}
        onSelect={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).not.toContain("Instanz verbinden");
    expect(html).toContain("Instanz hinzufügen");
    expect(html.match(/<a\b|<button\b/g)).toHaveLength(1);
    expect(html).not.toContain("Netzwerk");
    expect(html).not.toContain("network");
  });
  it("offers exactly one retry when the selected instance fails", () => {
    const html = renderToStaticMarkup(
      <InstanceOnboardingView
        state="failed"
        instances={[alpha]}
        selectedId={alpha.id}
        onSelect={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("ist nicht erreichbar");
    expect(html).toContain("Erneut verbinden");
    expect(html).not.toContain("Instanzen verwalten");
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).not.toContain("Netzwerk");
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
    expect(instanceHostLabel(alpha)).toBe("Dieser Rechner");
    // D27: fehlender Wert fällt weg statt Zustandssatz.
    expect(instanceHostLabel({ ...alpha, source: "pairing_invite", displayName: "gpu3" })).toBe(
      null,
    );
  });
  it("does not turn an empty cache or a failed query into zero live apps", () => {
    expect(instanceAppsLabel(null)).toBe(null);
    expect(
      instanceAppsLabel({ _tag: "completed", instanceId: "alpha", source: "cache", apps: [] }),
    ).toBe(null);
    expect(
      instanceAppsLabel({ _tag: "completed", instanceId: "alpha", source: "live", apps: [] }),
    ).toBe("0 Apps");
  });
});

describe("instance onboarding ends every wait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["loading", "connecting"] as const)("reports %s as slow after exactly 10 s", (state) => {
    vi.useFakeTimers();
    const onSlow = vi.fn();
    const stop = startInstanceOnboardingSlowTimer(state, onSlow);
    expect(INSTANCE_ONBOARDING_SLOW_MS).toBe(10_000);
    vi.advanceTimersByTime(9_999);
    expect(onSlow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSlow).toHaveBeenCalledTimes(1);
    stop?.();
  });

  it("cancels the timer on cleanup and never waits in other states", () => {
    vi.useFakeTimers();
    const onSlow = vi.fn();
    startInstanceOnboardingSlowTimer("connecting", onSlow)?.();
    vi.advanceTimersByTime(20_000);
    expect(onSlow).not.toHaveBeenCalled();
    for (const state of ["select", "failed", "create-or-connect"] as const)
      expect(startInstanceOnboardingSlowTimer(state, onSlow)).toBeUndefined();
  });

  it.each(["loading", "connecting"] as const)(
    "offers only „Erneut verbinden“ once %s is slow",
    (state) => {
      const waiting = renderToStaticMarkup(
        <InstanceOnboardingView
          state={state}
          instances={[alpha]}
          selectedId={alpha.id}
          onSelect={() => {}}
          onRetry={() => {}}
        />,
      );
      expect(waiting).not.toContain("Erneut verbinden");
      const slow = renderToStaticMarkup(
        <InstanceOnboardingView
          state={state}
          instances={[alpha]}
          selectedId={alpha.id}
          onSelect={() => {}}
          onRetry={() => {}}
          slow
        />,
      );
      expect(slow).toContain("Erneut verbinden");
      expect(slow).not.toContain("Instanzen verwalten");
      expect(slow).not.toContain("data-workjet-onboarding-status");
    },
  );

  it("lists instances as rows with a status dot", () => {
    const html = renderToStaticMarkup(
      <InstanceOnboardingView
        state="select"
        instances={[alpha, { ...alpha, id: "beta", displayName: "Beta", status: "offline" }]}
        onSelect={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html.match(/data-slot="row"/g)).toHaveLength(2);
    expect(html.match(/data-slot="row-status"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="verbunden"');
    expect(html).toContain('aria-label="getrennt"');
    expect(html).toContain("lucide-server");
  });
});
