import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const MOBILE_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const read = (path: string) => NodeFS.readFileSync(NodePath.resolve(MOBILE_ROOT, path), "utf8");

describe("Business OS native security guards", () => {
  it("has no manual signaling, room or password field in its settings surface", () => {
    const settings = read("src/features/business-os/components/BusinessOsSettingsPanel.tsx");
    expect(settings).not.toMatch(/TextInput/u);
    expect(settings).not.toMatch(/Signaling-URL eingeben|Raum eingeben|Passwort eingeben/iu);
    expect(settings).toContain("QR-Code anzeigen");
    expect(settings).toContain("QR-Code scannen");
    expect(settings).toContain("Erneuern");
    expect(settings).toContain("Widerrufen");
  });

  it("requires isolated native profiles and canonical app origins", () => {
    const android = read(
      "modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3BusinessOsModule.kt",
    );
    expect(android).toContain("WebViewFeature.MULTI_PROFILE");
    expect(android).toContain("WebViewFeature.WEB_MESSAGE_LISTENER");
    expect(android).toContain("WebViewCompat.setProfile");
    expect(android).toContain("WebViewCompat.addWebMessageListener");
    expect(android).not.toContain("addJavascriptInterface");
    expect(android).toContain("https://appassets.androidplatform.net/business-os/index.html");
    expect(android).toContain("MIXED_CONTENT_NEVER_ALLOW");
    expect(android).toContain("request.deny()");

    const ios = read("modules/t3-native-controls/ios/T3BusinessOsModule.swift");
    expect(ios).toContain("WKWebsiteDataStore(forIdentifier:");
    expect(ios).toContain("workjet-business-os://");
    expect(ios).toContain("decisionHandler(.deny)");
  });

  it("does not introduce an HTTP data bridge or secret-bearing query", () => {
    const launch = read("src/features/business-os/shell/launch-context.ts");
    const ios = read("modules/t3-native-controls/ios/T3BusinessOsModule.swift");
    const android = read(
      "modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3BusinessOsModule.kt",
    );
    expect(launch).toContain("http_bridge_available: false");
    expect(`${launch}\n${ios}\n${android}`).not.toMatch(/ctox_config|\/api\/business-os\/data/iu);
  });

  it("bounds the native Decision Hub notification bridge on both platforms", () => {
    const ios = read("modules/t3-native-controls/ios/T3BusinessOsModule.swift");
    const android = read(
      "modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3BusinessOsModule.kt",
    );
    expect(ios).toContain("workjetBusinessOsNotification");
    expect(ios).toContain('payload["kind"] as? String == "decision_hub"');
    expect(ios).toContain("maxLength: 240");
    expect(android).toContain('payload.optString("kind") != "decision_hub"');
    expect(android).toContain("if (raw.toByteArray().size > 1_024) return null");
  });

  it("keeps the lifecycle bridge origin-bound and metadata-only", () => {
    const protocol = read("src/features/business-os/launcher/business-os-shell-protocol.ts");
    const android = read(
      "modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3BusinessOsModule.kt",
    );
    const ios = read("modules/t3-native-controls/ios/T3BusinessOsModule.swift");
    expect(protocol).toContain('"workjet.business-os-shell.v1"');
    expect(protocol).not.toContain("roomPassword");
    expect(protocol).not.toContain("capabilityToken");
    expect(android).toContain("setOf(BUSINESS_OS_ORIGIN)");
    expect(ios).toContain("businessOsShellMessageMaxBytes = 65_536");
    expect(`${android}\n${ios}`).not.toContain("businessRecords");
  });

  it("resolves shell packs through the shared DPoP command and preflights trust", () => {
    const state = read("src/state/business-os-mobile-shell-pack.ts");
    const resolver = read("src/features/business-os/shell/production-shell-pack-resolver.ts");
    expect(state).toContain("createBusinessOsMobileShellPackEnvironmentAtoms");
    expect(resolver).toContain("businessOsMobileShellPackEnvironment.resolve");
    const core = read("src/features/business-os/shell/shell-pack-resolver-core.ts");
    expect(core.indexOf("validateBusinessOsShellPackTrustMap")).toBeLessThan(
      core.indexOf("input.command.execute"),
    );
  });

  it("redacts protected content on Android screenshots and iOS background capture", () => {
    const android = read(
      "modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3NativeControlsModule.kt",
    );
    const ios = read("modules/t3-native-controls/ios/T3NativeControlsModule.swift");
    expect(android).toContain("FLAG_SECURE");
    expect(ios).toContain("willResignActiveNotification");
    expect(ios).toContain("capturedDidChangeNotification");
  });
});
