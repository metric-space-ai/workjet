import type { CtoxManagedInstance } from "@t3tools/contracts";
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
  manualConnectionPasswordText,
  resolveActiveBusinessOsInstanceId,
  visibleBusinessOsInstances,
} from "./BusinessOsSettings";
import { encodeWorkjetBusinessOsPairingLink } from "./businessOsPairing";
import { QRCodeSvg } from "../ui/qr-code";

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

  it("lists actual backends but never SSH computers as Business-OS instances", () => {
    const welsch = instance("business-os-welsch", "WELSCH");
    const gpu3 = instance("ssh:gpu3", "gpu3-a4500", "ssh_managed");
    expect(
      visibleBusinessOsInstances({ _tag: "ready", instances: [gpu3, welsch] }).map(
        (candidate) => candidate.displayName,
      ),
    ).toEqual(["WELSCH"]);
  });

  it("fails closed when no active instance exists and keeps the device action visible", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView instances={[]} activeInstanceId={null} />,
    );
    expect(markup).toContain("Keine Business-OS-Instanz verbunden");
    expect(markup).toContain("Business OS hinzufügen");
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
    expect(markup).toContain('aria-label="Aktive Business-OS-Instanz"');
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

  it("shows a direct guest-control blocker instead of choosing a Code computer", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("managed:welsch", "WELSCH", "ctox_dev")]}
        activeInstanceId="managed:welsch"
        computerCount={3}
        deviceManagementBlockedReason="Die Shell von WELSCH unterstützt die Geräteverbindung noch nicht."
      />,
    );
    expect(markup).toContain("Gerät hinzufügen");
    expect(markup).toContain("Die Shell von WELSCH unterstützt die Geräteverbindung noch nicht");
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
            id: "pairing-1",
            deviceId: "workjet-device-abcdefgh",
            displayName: "Galaxy Fold",
            createdAtMs: 1_787_999_000_000,
            pairedAtMs: 1_788_000_000_000,
          },
        ]}
        onAddDevice={() => undefined}
        onRevokeDevice={() => undefined}
      />,
    );
    expect(markup).toContain("Galaxy Fold");
    expect(markup).toContain("Widerrufen");
    expect(markup).not.toContain("pairing-1");
  });

  it("keeps the manual room password masked until the user explicitly reveals it", () => {
    expect(manualConnectionPasswordText("room-secret", false)).toBe("••••••••••••");
    expect(manualConnectionPasswordText("room-secret", true)).toBe("room-secret");
  });

  it("renders the transient WebRTC invite as a large QR without exposing its password as text", () => {
    const password = "never-render-this-password";
    const link = encodeWorkjetBusinessOsPairingLink({
      type: "ctox-business-os-invite",
      version: 1,
      display_name: "WELSCH",
      instance_id: "welsch",
      sync_room: "ctox-business-os:welsch",
      native_peer_id: "native-welsch",
      signaling_urls: ["wss://signaling.ctox.dev/v2"],
      signaling_room_password: password,
      transport: "webrtc",
      expires_at: "2026-08-27T15:00:00Z",
      data_plane: "rxdb-webrtc",
      http_bridge_available: false,
      session: {
        authenticated: true,
        source: "mobile_invite",
        capability_token: "transient-capability",
        capability_expires_at_ms: 1_788_000_000_000,
        user: {
          id: "pairing-device",
          display_name: "Workjet-Gerät",
          role: "user",
          is_admin: false,
        },
      },
    });
    const markup = renderToStaticMarkup(
      <QRCodeSvg
        value={link}
        size={320}
        level="M"
        marginSize={4}
        title="QR-Code für WELSCH"
        className="h-auto w-full max-w-80"
      />,
    );
    expect(markup).toContain('aria-label="QR-Code für WELSCH"');
    expect(markup).toContain('width="320"');
    expect(markup).not.toContain(password);
    expect(manualConnectionPasswordText(password, false)).toBe("••••••••••••");
  });
});
