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
  formatInviteValidity,
  manualConnectionCredentialText,
  resolveActiveBusinessOsInstanceId,
  networkInstancesForSelection,
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
    expect(businessOsDeviceControlErrorMessage(new Error("unsupported"), fallback)).toBe(
      "Instanz unterstützt die Geräteverwaltung noch nicht.",
    );
    expect(businessOsDeviceControlErrorMessage(new Error("sync_unavailable"), fallback)).toBe(
      "Instanz nicht erreichbar.",
    );
    expect(businessOsDeviceControlErrorMessage(new Error("forbidden"), fallback)).toBe(
      "Keine Berechtigung für Geräte dieser Instanz.",
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

  it("shows an empty list with the inline add panel and no device section without a selection", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[]}
        activeInstanceId={null}
        addPanel={<span data-testid="add-panel">Instanz hinzufügen</span>}
      />,
    );
    expect(markup).toContain("Keine CTOX-Instanz verbunden");
    expect(markup).toContain('data-testid="add-panel"');
    expect(markup).not.toContain("Gerät hinzufügen");
    expect(markup).not.toContain("environment-alpha");
    expect(markup).not.toContain('role="dialog"');
  });

  it("distinguishes a discovery failure from an empty registry and offers a retry", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[]}
        activeInstanceId={null}
        discoveryFailed
        onRefresh={() => undefined}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Instanzen nicht erreichbar");
    expect(markup).toContain("Erneut versuchen");
    expect(markup).not.toContain("Keine CTOX-Instanz verbunden");
  });

  it("is one page: no settings grid that duplicates the sidebar, no English captions", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("paired:backend-alpha", "WELSCH")]}
        activeInstanceId="paired:backend-alpha"
      />,
    );
    for (const duplicate of [">Modelle<", ">Harnesses<", ">Lumas<", "instance-hub:"])
      expect(markup).not.toContain(duplicate);
    for (const english of [
      "Settings for",
      "Disabled instances retain",
      "Connected devices",
      "Add instance",
      "Refresh",
      "Select an instance",
    ])
      expect(markup).not.toContain(english);
  });

  it("makes instance management primary with one compact row per instance", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("paired:backend-alpha", "WELSCH")]}
        activeInstanceId="paired:backend-alpha"
        network={<span data-testid="network-canvas" />}
      />,
    );
    expect(markup).toContain('aria-label="Instanzen"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("WELSCH");
    expect(markup).toContain("Gekoppelte Workjet-Apps · WELSCH");
    expect(markup).toContain('data-slot="row"');
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("Technische Details");
    expect(markup).not.toContain("Darstellungs-ID");
    expect(markup).not.toContain("ctox_dev");
    // Netzwerk is a collapsed section; its canvas mounts only when opened.
    expect(markup).toContain(">Netzwerk<");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("network-canvas");
    expect(markup.indexOf('aria-label="Instanzen"')).toBeLessThan(
      markup.indexOf("Gekoppelte Workjet-Apps · WELSCH"),
    );
    expect(markup.indexOf("Gekoppelte Workjet-Apps · WELSCH")).toBeLessThan(
      markup.indexOf(">Netzwerk<"),
    );
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

  it("shows the exact managed-control blocker and keeps the device action disabled", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("managed:welsch", "WELSCH", "ctox_dev")]}
        activeInstanceId="managed:welsch"
        deviceManagementBlockedReason="WELSCH zuerst einmal in Ops öffnen."
      />,
    );
    expect(markup).toContain("Gerät hinzufügen");
    expect(markup).toContain("WELSCH zuerst einmal in Ops öffnen.");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Gerät hinzufügen/);
    expect(markup).not.toContain("serverautoritativ");
    expect(markup).not.toContain("primaryEnvironment");
  });

  it("renders only sanitized device rows with an inline revoke confirmation", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        devicesDefaultOpen
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
    expect(markup).toContain("Gerät vom ");
    expect(markup).toContain('aria-label="Trennen"');
    expect(markup).not.toContain("welsch-authority");
    expect(markup).not.toContain("pairing-1");
    expect(markup).not.toContain("workjet-device-abcdefgh");
  });

  it("shows device pairing inline, never as a dialog", () => {
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("local:welsch", "WELSCH", "local_daemon")]}
        activeInstanceId="local:welsch"
        onAddDevice={() => undefined}
        activeInvite={{
          inviteId: "invite-1",
          link: "workjet://pair?payload=abc",
          expiresAt,
          manualConnection: {
            signalingUrls: ["wss://signal.example.test"],
            room: "room-1",
            browserToken: "token",
            browserTokenHash: "hash",
            authVersion: "ctox-role-bound-v1",
            expiresAt,
          } as never,
        }}
        onCloseInvite={() => undefined}
        onRenewInvite={() => undefined}
      />,
    );
    expect(markup).toContain('data-slot="inline-panel"');
    expect(markup).toContain("Neuer QR-Code");
    expect(markup).toContain("QR-Code");
    expect(markup).toContain("Verbindungsdaten");
    expect(markup).toContain("Gültig bis");
    expect(markup).toContain("noch 30 Min.");
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("Connect a Workjet device");
  });

  it("states the invite validity with the remaining time", () => {
    const expiresAt = "2026-10-11T23:30:00Z";
    const now = Date.parse(expiresAt);
    expect(formatInviteValidity(expiresAt, now - 23 * 60_000)).toMatch(
      /^Gültig bis .+ · noch 23 Min\.$/u,
    );
    expect(formatInviteValidity(expiresAt, now - 3 * 3_600_000)).toMatch(/noch 3 Std\.$/u);
    expect(formatInviteValidity(expiresAt, now + 1)).toBe("Abgelaufen");
  });

  it("keeps the manual browser credential masked until the user explicitly reveals it", () => {
    expect(manualConnectionCredentialText("browser-token", false)).toBe("••••••••••••");
    expect(manualConnectionCredentialText("browser-token", true)).toBe("browser-token");
  });
});

describe("networkInstancesForSelection", () => {
  it("shows only the selected instance's network", () => {
    const instances = [{ id: "miltonticket" }, { id: "welsch" }];
    expect(networkInstancesForSelection(instances, "welsch")).toEqual([{ id: "welsch" }]);
    expect(networkInstancesForSelection(instances, null)).toEqual(instances);
    expect(networkInstancesForSelection(instances, "gone")).toEqual(instances);
  });
});
