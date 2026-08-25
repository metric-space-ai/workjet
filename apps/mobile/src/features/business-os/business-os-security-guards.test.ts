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
    expect(android).toContain("WebViewCompat.setProfile");
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
