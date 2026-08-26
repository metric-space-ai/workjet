import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import computersSettingsSource from "../settings/WorkjetComputersSettings.tsx?raw";
import dialogSource from "./BusinessOsSettingsDialog.tsx?raw";
import {
  businessOsInstanceDataPlaneReady,
  BusinessOsSettingsDialog,
} from "./BusinessOsSettingsDialog";

describe("BusinessOsSettingsDialog", () => {
  it("owns a complete Business OS settings tree without rendering Coding settings", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsDialog
        bridge={undefined}
        discovery={{ _tag: "ready", instances: [] }}
        selectedId={null}
        onClose={() => undefined}
      />,
    );

    for (const category of [
      "Allgemein",
      "Backends &amp; Sync",
      "Apps",
      "Updates",
      "Darstellung",
      "Benachrichtigungen",
      "Diagnostik",
      "Über",
    ]) {
      expect(markup).toContain(category);
    }
    expect(markup).not.toContain("Project grouping");
    expect(markup).not.toContain("Harnesses");
    expect(markup).not.toContain("Keybindings");
    expect(dialogSource).toContain('"workjet.business-os.settings.last-page"');
  });

  it("keeps QR pairing exclusively in Business OS settings", () => {
    expect(dialogSource).toContain("BusinessOsMobilePairingSection");
    expect(computersSettingsSource).not.toContain("BusinessOsMobilePairingSection");
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
      "Instanz",
      "Erreichbarkeit",
      "Health",
      "Plattform",
      "Admin",
      "CTOX",
      "Shell",
      "Kanal",
      "Status",
      "Letzte Prüfung",
      "Aktionen",
    ]) {
      expect(dialogSource).toContain(column);
    }
    expect(dialogSource).toContain("requiredOperatorStep");
    expect(dialogSource).toContain("Blockierte Instanzen zählen nicht als");
    expect(dialogSource).toContain('data_plane_degraded: "Sync beeinträchtigt"');
    expect(dialogSource).toContain("row.blocker === null ? PHASE_LABELS[row.shell.phase]");
    expect(dialogSource).toContain('row.blocker !== "paused"');
    expect(dialogSource).toContain("Release wieder freigeben");
    expect(dialogSource).toContain("Pausegrund für");
    expect(dialogSource).toContain("Details");
    expect(dialogSource).toContain("Erneut versuchen");
    expect(dialogSource).toContain("row.shell.errorCode ?? row.blocker");
  });
});
