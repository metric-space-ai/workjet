import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import computersSettingsSource from "../settings/WorkjetComputersSettings.tsx?raw";
import dialogSource from "./BusinessOsSettingsDialog.tsx?raw";
import { BusinessOsSettingsDialog } from "./BusinessOsSettingsDialog";

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

  it("offers the fleet columns and explicit blocked-state operator guidance", () => {
    for (const column of ["Instanz", "Health", "CTOX", "Shell", "Kanal", "Status", "Aktionen"]) {
      expect(dialogSource).toContain(column);
    }
    expect(dialogSource).toContain("requiredOperatorStep");
    expect(dialogSource).toContain("Blockierte Instanzen zählen nicht als");
  });
});
