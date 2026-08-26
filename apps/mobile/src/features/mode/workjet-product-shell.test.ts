import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

function read(relativePath: string): string {
  return NodeFS.readFileSync(NodeURL.fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("shared Workjet product shell", () => {
  it("keeps Code and Business OS mounted behind one persistent product chrome", () => {
    const app = read("../../App.tsx");
    const chrome = read("./WorkjetProductChrome.tsx");

    expect(app).toContain("<WorkjetProductChrome />");
    expect(app).toContain("<Navigation linking={appLinking}");
    expect(app).toContain("<BusinessOsSetupScreen active=");
    expect(app).not.toContain('if (mode === "business_os") return');
    expect(chrome).toContain('<ModeButton label="Code"');
    expect(chrome).toContain('label="Business OS"');
    expect(chrome).toContain('name="sidebar.left"');
  });

  it("does not let the hidden Business OS root consume Android back or app lifecycle", () => {
    const root = read("../business-os/launcher/BusinessOsMobileRoot.tsx");

    expect(root).toContain("if (!props.active) return;");
    expect(root).toContain('type: props.active ? "app.resume" : "app.suspend"');
  });

  it("offers QR pairing without manual signaling or password fields", () => {
    const onboarding = read("../pairing/WorkjetPairingOnboarding.tsx");
    const app = read("../../App.tsx");
    const pairing = read("../pairing/WorkjetDevicePairingProvider.tsx");

    expect(onboarding).toContain("Ein Pairing für Code und Business OS");
    expect(onboarding).toContain("Footer der linken Seitenleiste");
    expect(onboarding).toMatch(/Mobilgerät\s+verbinden/u);
    expect(onboarding).toContain("<CameraView");
    expect(onboarding).not.toContain("<TextInput");
    expect(onboarding).not.toMatch(/placeholder=.*(?:server|host|passwort|password)/iu);
    expect(app).toContain("<WorkjetDevicePairingProvider>");
    expect(pairing).toContain("parseWorkjetDevicePairLink(payload)");
    expect(pairing).toContain("connectCodePairingUrl(prepared.environment.pairingUrl)");
    expect(pairing).toContain("importBusinessOsInvite(prepared.businessOs");
    expect(pairing).toContain("removeCodeEnvironment(environmentId)");
    expect(pairing).toContain("pendingIncomingDevicePairingIds");
    expect(pairing).toContain("completedIncomingDevicePairingIds");
    expect(pairing).not.toContain("handledIncomingPairingUrls");
    expect(app).not.toContain("noch keinen gemeinsamen Code-/Business-OS-QR-Code");
  });
});
