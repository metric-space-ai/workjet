import { describe, expect, it } from "vite-plus/test";

import pairingSource from "../settings/WorkjetDevicePairingDialog.tsx?raw";
import dialogSource from "./BusinessOsSettingsDialog.tsx?raw";
import {
  businessOsInstanceDataPlaneReady,
  connectionDisplayTitle,
  fleetInstanceDisplayTitle,
} from "./BusinessOsSettingsDialog";

describe("BusinessOsSettingsDialog", () => {
  it("owns a complete Business OS settings tree without rendering Coding settings", () => {
    for (const category of [
      "Allgemein",
      "Verbindungen",
      "Apps",
      "Updates",
      "Darstellung",
      "Benachrichtigungen",
      "Diagnostik",
      "Über",
    ]) {
      expect(dialogSource).toContain(category);
    }
    expect(dialogSource).not.toContain("Project grouping");
    expect(dialogSource).not.toContain("Harnesses");
    expect(dialogSource).not.toContain("Keybindings");
    expect(dialogSource).toContain('"workjet.business-os.settings.last-page"');
  });

  it("keeps normal settings copy free of implementation terms", () => {
    expect(dialogSource).toContain('aria-label="Business OS-Einstellungen"');
    expect(dialogSource).toContain("Verbindungen");
    expect(dialogSource).not.toContain("Synchronisierung · nicht bestätigt");
    expect(dialogSource).not.toContain("CTOX Local Instance");
    expect(dialogSource).toContain("Erneut verbinden");
    expect(dialogSource).not.toContain("Business OS guest");
    expect(dialogSource).not.toContain("WebContentsView");
    expect(dialogSource).not.toContain("RxDB/WebRTC ·");
  });

  it("opens the same unified device pairing flow from Business OS backend settings", () => {
    expect(dialogSource).not.toContain("BusinessOsMobilePairingSection");
    expect(dialogSource).toContain("openWorkjetDevicePairing");
    expect(dialogSource).toContain("Workjet auf einem weiteren Gerät verbinden");
    expect(dialogSource).toContain("Ein Scan verbindet Code und");
    expect(dialogSource).toContain("Business OS gemeinsam");
    expect(dialogSource).toContain("Gerät verbinden");
    expect(pairingSource).toContain("Mobilgerät verbinden");
    expect(pairingSource).toContain("QR-Code anzeigen");
    expect(pairingSource).toContain("Code und Business OS");
    expect(pairingSource).toContain("workjetDeviceInviteEnvironment");
  });

  it("keeps empty fleet updates responsive and actionable", () => {
    expect(dialogSource).toContain("Keine CTOX Backends registriert");
    expect(dialogSource).toContain("Verbindung auswählen");
    expect(dialogSource).toContain("Gerät verbinden");
    expect(dialogSource).toContain("rolloutStatus.instanceIds.length > 0");
  });

  it("uses the shared modal primitive and a scrollable responsive settings navigation", () => {
    expect(dialogSource).toContain("<Dialog open");
    expect(dialogSource).toContain("<DialogPopup");
    expect(dialogSource).toContain('aria-modal="true"');
    expect(dialogSource).toContain('"[data-business-os-settings-trigger]"');
    expect(dialogSource).toContain('button[aria-label="Toggle main sidebar"]');
    expect(dialogSource).not.toContain('window.addEventListener("keydown"');
    expect(dialogSource).toContain("max-h-[45dvh]");
    expect(dialogSource).toContain("overflow-y-auto");
    expect(dialogSource).toContain("w-full");
    expect(dialogSource).toContain("md:w-64");
    expect(dialogSource).toContain("overflow-x-auto");
    expect(dialogSource).toContain("navigation.scrollTo");
    expect(dialogSource).toContain('behavior: "auto"');
    expect(dialogSource).toContain("event.currentTarget");
    expect(dialogSource).toContain("p-4 sm:p-6 md:p-8 lg:p-12");
  });

  it("uses the authenticated selected guest as confirmed WebRTC evidence", () => {
    const instance = {
      id: "local:AAAAAAAAAAAAAAAAAAAAAA",
      healthSummary: { dataPlaneReady: false },
    };
    expect(businessOsInstanceDataPlaneReady(instance, null)).toBe(false);
    expect(businessOsInstanceDataPlaneReady(instance, instance.id)).toBe(true);
  });

  it("offers the fleet columns and explicit blocked-state operator guidance", () => {
    for (const column of [
      "Backend",
      "Erreichbarkeit",
      "Zustand",
      "Plattform",
      "Zugriff",
      "CTOX Backend",
      "Business OS",
      "Kanal",
      "Status",
      "Letzte Prüfung",
      "Aktionen",
    ]) {
      expect(dialogSource).toContain(column);
    }
    expect(dialogSource).toContain("requiredOperatorStep");
    expect(dialogSource).toContain("Blockierte Backends zählen nicht als");
    expect(dialogSource).toContain('data_plane_degraded: "Synchronisierung beeinträchtigt"');
    expect(dialogSource).toContain("row.blocker === null ? PHASE_LABELS[row.shell.phase]");
    expect(dialogSource).toContain('row.blocker !== "paused"');
    expect(dialogSource).toContain("Release wieder freigeben");
    expect(dialogSource).toContain("Pausegrund für");
    expect(dialogSource).toContain("Details");
    expect(dialogSource).toContain("Erneut versuchen");
    expect(dialogSource).toContain("row.shell.errorCode ?? row.blocker");
  });

  it("keeps opaque pairing ids out of the fleet table", () => {
    expect(fleetInstanceDisplayTitle("biz_2a75d5c5-da16-4a17-90d2-a941ad53f095")).toBe(
      "CTOX Backend · 2a75d5c5",
    );
    expect(fleetInstanceDisplayTitle("GPU3 A4500")).toBe("GPU3 A4500");
  });

  it("uses friendly device names instead of backend ids in normal settings", () => {
    expect(
      connectionDisplayTitle({
        displayName: "CTOX Local Instance",
        source: "local_daemon",
      }),
    ).toBe("Dieser Mac");
    expect(
      connectionDisplayTitle({
        displayName: "biz_2a75d5c5-da16-4a17-90d2-a941ad53f095",
        source: "pairing_invite",
      }),
    ).toBe("Weiteres Workjet-Gerät");
    expect(
      connectionDisplayTitle({
        displayName: "Studio Mac",
        source: "pairing_invite",
      }),
    ).toBe("Studio Mac");
  });
});
