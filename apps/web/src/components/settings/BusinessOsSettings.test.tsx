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
import { businessOsDeviceControlErrorMessage } from "./businessOsDeviceControl";

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
  it("explains safe device-control failures without showing guest exception text", () => {
    const fallback = "Geräteanfrage fehlgeschlagen.";
    expect(businessOsDeviceControlErrorMessage(new Error("unsupported"), fallback)).toContain(
      "Backend",
    );
    expect(businessOsDeviceControlErrorMessage(new Error("sync_unavailable"), fallback)).toContain(
      "CTOX Sync",
    );
    expect(businessOsDeviceControlErrorMessage(new Error("forbidden"), fallback)).toContain(
      "darf Geräte",
    );
    expect(businessOsDeviceControlErrorMessage(new Error("private credential"), fallback)).toBe(
      fallback,
    );
  });

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
    ).toContain("could not be added");
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
    expect(markup).toContain("No CTOX instance connected");
    expect(markup).toContain("Add instance");
    expect(markup).toContain("Add device");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("environment-alpha");
  });

  it("keeps the connected-host settings hub available without native discovery", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[]}
        activeInstanceId={null}
        requiresInstanceSelection={false}
      />,
    );
    expect(markup).toContain("Models");
    expect(markup).toContain("Harnesses");
    expect(markup).toContain("Computers");
    expect(markup).toContain("Worker");
    expect(markup).not.toContain("Wähle zuerst eine Instanz aus.");
  });

  it("makes instance management primary and links to the selected instance settings", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("paired:backend-alpha", "WELSCH")]}
        activeInstanceId="paired:backend-alpha"
      />,
    );
    expect(markup).toContain('aria-label="CTOX instances"');
    expect(markup).toContain('aria-label="Active instance"');
    expect(markup).toContain("WELSCH");
    expect(markup).toContain("Devices for WELSCH");
    expect(markup).toContain("Models");
    expect(markup).toContain("Harnesses");
    expect(markup).toContain("Computers");
    expect(markup).toContain("Lumas");
    expect(markup).not.toContain("globalen Computer-Inventar");
    expect(markup).not.toContain("Rechner für Code");
    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).not.toContain("Technische Details");
    expect(markup).not.toContain("Darstellungs-ID");
    expect(markup).not.toContain("ctox_dev");
    expect(markup.indexOf("CTOX instances")).toBeLessThan(markup.indexOf(">Models<"));
    expect(markup.indexOf(">Models<")).toBeLessThan(markup.indexOf("Connected devices"));
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
        deviceManagementBlockedReason="WELSCH konnte noch nicht bestätigt werden."
      />,
    );
    expect(markup).toContain("Add device");
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
    expect(markup).toContain("Workjet device · abcdefgh");
    expect(markup).toContain("Revoke");
    expect(markup).not.toContain("welsch-authority");
    expect(markup).not.toContain("pairing-1");
  });

  it("keeps the manual browser credential masked until the user explicitly reveals it", () => {
    expect(manualConnectionCredentialText("browser-token", false)).toBe("••••••••••••");
    expect(manualConnectionCredentialText("browser-token", true)).toBe("browser-token");
  });
});
