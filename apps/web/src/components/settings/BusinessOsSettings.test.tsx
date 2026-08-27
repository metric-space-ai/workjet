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
    expect(markup).toContain("3 Rechner im globalen Inventar");
    expect(markup).toContain("Technische Details");
    expect(markup.indexOf("Workjet-Geräte")).toBeLessThan(markup.indexOf("Rechner für Code"));
    expect(markup.indexOf("Rechner für Code")).toBeLessThan(markup.indexOf("Diagnose"));
  });

  it("shows the exact managed-control blocker instead of choosing a Code computer", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView
        instances={[instance("managed:welsch", "WELSCH", "ctox_dev")]}
        activeInstanceId="managed:welsch"
        computerCount={3}
        deviceManagementBlockedReason="Für WELSCH ist noch keine serverseitig attestierte Backend-Steuerverbindung verfügbar. Geräteaktionen bleiben bis dahin gesperrt."
      />,
    );
    expect(markup).toContain("Gerät hinzufügen");
    expect(markup).toContain("serverseitig attestierte Backend-Steuerverbindung");
    expect(markup).toContain("disabled");
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
});
