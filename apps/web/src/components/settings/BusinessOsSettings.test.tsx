import type { CtoxManagedInstance } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...original,
    useNavigate: () => () => Promise.resolve(),
    useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) =>
      select({ hash: "" }),
  };
});

import {
  BusinessOsSettingsView,
  importBusinessOsSettingsInvite,
  manualConnectionCredentialText,
  resolveActiveBusinessOsInstanceId,
  visibleBusinessOsInstances,
} from "./BusinessOsSettings";

function instance(
  id: string,
  displayName: string,
  source: CtoxManagedInstance["source"] = "pairing_invite",
): CtoxManagedInstance {
  return {
    id,
    displayName,
    source,
    status: source === "pairing_invite" ? "paired" : "available",
    healthSummary: {
      dataPlane: "rxdb-webrtc",
      dataPlaneReady: true,
      httpDataProxy: false,
      nativePeerObserved: true,
    },
  };
}

describe("Business OS settings scope", () => {
  it("activates an imported backend through the shared selector before refreshing discovery", async () => {
    const backend = instance("paired:backend-alpha", "Lab");
    const events: string[] = [];
    const select = vi.fn((selected: CtoxManagedInstance) => events.push(`selected:${selected.id}`));
    const refresh = () => events.push("refresh");
    const bridge = {
      importInvite: vi.fn(async () => ({ _tag: "completed" as const, instance: backend })),
    };
    expect(
      await importBusinessOsSettingsInvite(bridge, "fixture-invite", select, refresh),
    ).toBeNull();
    expect(select).toHaveBeenCalledWith(backend);
    expect(events).toEqual(["selected:paired:backend-alpha", "refresh"]);
  });

  it("preserves the selected backend when an invitation cannot be imported", async () => {
    const select = vi.fn();
    const refresh = vi.fn();
    const bridge = {
      importInvite: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    expect(
      await importBusinessOsSettingsInvite(bridge, "fixture-invite", select, refresh),
    ).toContain("nicht hinzugefügt");
    expect(select).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("uses only an explicitly selected Business OS instance", () => {
    expect(
      resolveActiveBusinessOsInstanceId({
        mode: "business-os",
        ctoxInstanceId: "local:backend-alpha",
      }),
    ).toBe("local:backend-alpha");
    expect(
      resolveActiveBusinessOsInstanceId({ mode: "code", environmentId: "environment-alpha" }),
    ).toBeNull();
    expect(resolveActiveBusinessOsInstanceId(null)).toBeNull();
  });

  it("lists actual backend instances including a backend hosted on an SSH computer", () => {
    const welsch = instance("business-os-welsch", "WELSCH");
    const gpu3 = instance("ssh:gpu3", "gpu3-a4500", "ssh_managed");
    expect(
      visibleBusinessOsInstances({ _tag: "ready", instances: [gpu3, welsch] }).map(
        (candidate) => candidate.displayName,
      ),
    ).toEqual(["gpu3-a4500", "WELSCH"]);
  });

  it("fails closed when no active instance exists and keeps the device action visible", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView instances={[]} activeInstanceId={null} />,
    );
    expect(markup).toContain("Keine CTOX-Instanz verbunden");
    expect(markup).toContain("Instanz hinzufügen");
    expect(markup).toContain("Gerät hinzufügen");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("environment-alpha");
  });

  it("renders the real instance selector, scoped device area and computer inventory", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("paired:backend-alpha", "WELSCH")]}
        activeInstanceId="paired:backend-alpha"
        computerCount={3}
      />,
    );
    expect(markup).toContain('aria-label="CTOX-Instanz auswählen"');
    expect(markup).toContain("WELSCH");
    expect(markup).toContain("Geräte für WELSCH");
    expect(markup).toContain("Zuweisungen zu WELSCH");
    expect(markup).toContain("3 Rechner sind eingerichtet");
    expect(markup).not.toContain("Technische Details");
    expect(markup).not.toContain("Darstellungs-ID");
    expect(markup).not.toContain("ctox_dev");
    expect(markup.indexOf("Workjet-Geräte")).toBeLessThan(markup.indexOf("Rechner für Code"));
    expect(markup).not.toContain("Diagnose");
  });

  it("keeps opaque authority identifiers out of regular instance labels", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("paired:backend-alpha", "biz_2a75d5c5-da16-4a17-90d2-a941ad53f095")]}
        activeInstanceId="paired:backend-alpha"
      />,
    );
    expect(markup).toContain("CTOX Backend · 2a75d5c5");
    expect(markup).not.toContain("biz_2a75d5c5-da16-4a17-90d2-a941ad53f095");
  });

  it("shows the exact managed-control blocker instead of choosing a Code computer", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("managed:welsch", "WELSCH", "ctox_dev")]}
        activeInstanceId="managed:welsch"
        computerCount={3}
        deviceManagementBlockedReason="WELSCH konnte noch nicht bestätigt werden."
      />,
    );
    expect(markup).toContain("Gerät hinzufügen");
    expect(markup).toContain("WELSCH konnte noch nicht bestätigt werden");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("serverautoritativ");
    expect(markup).not.toContain("Erneuern");
    expect(markup).not.toContain("primaryEnvironment");
  });

  it("renders only sanitized device-edge summaries when a control path is available", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("local:welsch", "WELSCH", "local_daemon")]}
        activeInstanceId="local:welsch"
        devices={[
          {
            devicePairingId: "pairing-1",
            deviceId: "workjet-device-abcdefgh",
            businessOsInstanceId: "welsch-authority",
            pairedAtMillis: 1_788_000_000_000,
          },
        ]}
        onAddDevice={() => undefined}
        onRevokeDevice={() => undefined}
      />,
    );
    expect(markup).toContain("Workjet-Gerät · abcdefgh");
    expect(markup).toContain("Widerrufen");
    expect(markup).not.toContain("welsch-authority");
    expect(markup).not.toContain("pairing-1");
  });

  it("keeps the manual browser credential masked until the user explicitly reveals it", () => {
    expect(manualConnectionCredentialText("browser-token", false)).toBe("••••••••••••");
    expect(manualConnectionCredentialText("browser-token", true)).toBe("browser-token");
  });
});
