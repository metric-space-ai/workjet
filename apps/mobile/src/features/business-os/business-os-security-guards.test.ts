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
    expect(settings).toContain(">Business OS</Text>");
    expect(settings).toContain("separat verbunden");
    expect(settings).toContain("gemeinsam für Code und Business OS");
    expect(settings).toContain("aktuell ausgewählten\n                Business OS");
    expect(settings).toContain("Weitere Instanzen werden unabhängig");
    expect(settings).toContain("Erneuern");
    expect(settings).toContain("Widerrufen");
    expect(settings).toContain("workjetDeviceInviteEnvironment");
    expect(settings).toContain("importPairingPayload");
    expect(settings).not.toContain("businessOsMobileInviteEnvironment");
  });

  it("persists only CTOX-instance to Code-machine memberships", () => {
    const registry = read("src/features/business-os/registry/native-business-os-registry.ts");
    const binding = read("src/features/business-os/registry/business-os-environment-binding.ts");
    expect(registry).toContain("business_os_instance_environment_memberships");
    expect(registry).toContain("business_os_instance_id");
    expect(registry).toContain("environment_id");
    expect(registry).toContain("business_os_environment_owner");
    expect(registry).toContain("ON CONFLICT (environment_id)");
    expect(binding).toContain("businessOsInstanceId");
    expect(binding).toContain("environmentId");
    expect(binding).toContain("each\n * environment belongs to exactly one instance");
    expect(binding).not.toMatch(/password|capabilityToken|roomSecret|businessRecords/iu);
  });

  it("makes Business OS the single visible connection scope in regular settings", () => {
    const settings = read("src/features/settings/SettingsRouteScreen.tsx");
    const home = read("src/features/home/HomeRouteScreen.tsx");
    expect(settings.indexOf('label="Business OS"')).toBeLessThan(
      settings.indexOf('label="Code | Business OS"'),
    );
    expect(settings).not.toContain('label="Environments"');
    expect(settings).not.toContain('label="Business OS verbinden"');
    expect(home).not.toContain('params: { screen: "SettingsEnvironments" }');
    expect(home).not.toContain('params: { screen: "SettingsEnvironmentNew" }');
  });

  it("opens the one regular Workjet settings surface and renders only one gear", () => {
    const root = read("src/features/business-os/launcher/BusinessOsMobileRoot.tsx");
    const home = read("src/features/business-os/launcher/BusinessOsHomeDesk.tsx");
    const nativeTypes = read("src/features/business-os/launcher/native-business-os-launcher.tsx");
    const ios = read("modules/t3-native-controls/ios/T3BusinessOsLauncherModule.swift");
    const android = read(
      "modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3BusinessOsLauncherModule.kt",
    );
    expect(
      NodeFS.existsSync(
        NodePath.resolve(
          MOBILE_ROOT,
          "src/features/business-os/launcher/BusinessOsNativeSettings.tsx",
        ),
      ),
    ).toBe(false);
    expect(root).not.toContain('"settings" | "app"');
    expect(root).not.toContain('setRoute("settings")');
    expect(root).toContain('navigation.navigate("SettingsSheet"');
    expect(root).toContain('params: { screen: "SettingsBusinessOs" }');
    expect(root).toContain("showsSettingsAction={!sidebarAvailable || !sidebarVisible}");
    expect(home).toContain("props.showsSettingsAction ?");
    expect(nativeTypes).toContain("readonly showsSettingsAction: boolean");
    expect(ios).toContain("if model.showsSettingsAction");
    expect(android).toContain("if (state.showsSettingsAction)");
    expect(`${home}\n${ios}\n${android}`).not.toContain("Business OS Einstellungen");
  });

  it("uses the active CTOX instance as the Code scope across entry points", () => {
    const pairing = read("src/features/pairing/WorkjetDevicePairingProvider.tsx");
    const layout = read("src/features/layout/AdaptiveWorkspaceLayout.tsx");
    const home = read("src/features/home/HomeRouteScreen.tsx");
    const newTask = read("src/features/threads/new-task-flow-provider.tsx");
    const project = read("src/features/projects/AddProjectScreen.tsx");
    const archiveRoute = read("src/features/archive/ArchivedThreadsRouteScreen.tsx");
    expect(pairing).toContain("bindEnvironment(businessOsInstance.id, environmentId)");
    expect(layout).not.toContain("selectedEnvironmentId={hasEnvironmentBindings");
    expect(home).toContain("binding.businessOsInstanceId === selectedBusinessOsInstance?.id");
    expect(newTask).toContain("activeBusinessOsEnvironmentIds");
    expect(project).toContain("selectedInstanceEnvironmentIds.has(connection.environmentId)");
    expect(archiveRoute).toContain(
      "binding.businessOsInstanceId === selectedBusinessOsInstance?.id",
    );
    expect(archiveRoute).toContain("All machines in");
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

  it("uses native SwiftUI and Compose launchers before the React Native fallback", () => {
    const home = read("src/features/business-os/launcher/BusinessOsHomeDesk.tsx");
    const ios = read("modules/t3-native-controls/ios/T3BusinessOsLauncherModule.swift");
    const android = read(
      "modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3BusinessOsLauncherModule.kt",
    );
    expect(home.indexOf("if (NativeBusinessOsLauncher)")).toBeLessThan(
      home.indexOf("BusinessOsHomeDeskFallback"),
    );
    expect(ios).toContain("UIHostingController<WorkjetNativeLauncher>");
    expect(ios).toContain("TabView");
    expect(ios).toContain(".onDrag");
    expect(ios).toContain(".onDrop");
    expect(ios).toContain(".glassEffect");
    expect(android).toContain("ComposeView");
    expect(android).toContain("HorizontalPager");
    expect(android).toContain("LazyVerticalGrid");
    expect(android).toContain("dynamicDarkColorScheme");
    expect(`${ios}\n${android}`).not.toContain('id = "desktop"');
  });
});
