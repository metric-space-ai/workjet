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
    expect(settings).toContain("hasVerifiedBackendControl");
    expect(settings).not.toContain("workjetDeviceInviteEnvironment");
    expect(settings).not.toContain("resolveWorkjetDevicePairingConnection");
    expect(settings).not.toContain("selectedEnvironmentIds");
    expect(settings).toContain("importPairingPayload");
    expect(settings).not.toContain("businessOsMobileInviteEnvironment");
  });

  it("never routes device control through a Code environment or connection URL", () => {
    const commonControl = read("src/features/pairing/workjet-device-invite-control.ts");
    const managedControl = read("src/features/pairing/workjet-managed-device-invite-control.ts");
    expect(`${commonControl}\n${managedControl}`).not.toMatch(
      /SavedRemoteConnection|EnvironmentId|connectionUrl|primaryEnvironment/iu,
    );
    expect(managedControl).toContain("backendControlConnectionId");
    expect(managedControl).toContain("WorkjetInstallationId");
    expect(managedControl).toContain("businessOsInstanceId");
    expect(managedControl).toContain("MAX_ACTIVE_INVITES");
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

  it("reconciles scoped Code memberships as runtime platform connections", () => {
    const platform = read("src/connection/platform.ts");
    const projection = read("src/connection/business-os-platform-connections.ts");
    const controller = read("src/features/connection/useConnectionController.ts");
    const pairing = read("src/features/pairing/WorkjetDevicePairingProvider.tsx");
    expect(platform).toContain("mobileBusinessOsPlatformRegistrations");
    expect(platform).not.toContain("registrations: Stream.empty");
    expect(projection).toContain("businessOsInstanceId: BusinessOsInstanceId.make");
    expect(projection).toContain("deviceSessionAuthorityIds");
    expect(projection).toContain("server-authoritative Code memberships");
    expect(controller).not.toContain("registerBusinessOsEnvironment");
    expect(pairing).not.toContain("registerBusinessOsEnvironment");
  });

  it("keeps Workjet device-session credentials behind opaque secure-store references", () => {
    const registry = read("src/features/business-os/registry/native-business-os-registry.ts");
    const sessionStore = read("src/features/pairing/workjet-device-session-store.ts");
    const pairing = read("src/features/pairing/WorkjetDevicePairingProvider.tsx");
    expect(registry).toContain("business_os_device_sessions");
    expect(registry).toContain("secret_reference TEXT NOT NULL");
    expect(registry).not.toMatch(
      /access_token TEXT|refresh_grant TEXT|bootstrap_credential TEXT/iu,
    );
    expect(registry).toContain("commitNativeManagedWorkjetPairing");
    expect(registry).toContain("withTransactionAsync");
    expect(sessionStore).toContain("previous session remains usable until the swap succeeds");
    expect(pairing).toContain("redeemManagedWorkjetDeviceInviteReference");
    expect(pairing).toContain("readManagedBusinessOsDeviceSessionMembership");
    expect(pairing).toContain("importManagedBusinessOsInvite");
  });

  it("makes Business OS the single visible connection scope in regular settings", () => {
    const settings = read("src/features/settings/SettingsRouteScreen.tsx");
    const home = read("src/features/home/HomeRouteScreen.tsx");
    expect(settings).toContain('<SettingsSection title="Business OS">');
    expect(settings).toContain('label="Business OS"');
    expect(settings).not.toContain('label="Code | Business OS"');
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
    const provider = read("src/features/business-os/BusinessOsProvider.tsx");
    const settingsPanel = read("src/features/business-os/components/BusinessOsSettingsPanel.tsx");
    const productChrome = read("src/features/mode/WorkjetProductChrome.tsx");
    const businessOsRoot = read("src/features/business-os/launcher/BusinessOsMobileRoot.tsx");
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
    expect(provider).not.toContain("Verbinde diese Business OS erneut");
    expect(provider).not.toContain("const selectableInstances =");
    expect(settingsPanel).toContain("Noch keine Rechner zugewiesen");
    expect(settingsPanel).not.toContain("Erneut verbinden: Rechner-Zuordnung fehlt");
    expect(productChrome).not.toContain("environmentBindings.length === 0");
    expect(businessOsRoot).toContain("const selectableInstances = instances;");
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

  it("binds HTTP DPoP and WebRTC sync to one non-exportable native P-256 key", () => {
    const surface = read("src/features/business-os/shell/native-business-os-surface.tsx");
    const dpop = read("src/features/cloud/dpop.ts");
    const nativeSigner = read("src/features/cloud/nativeWorkjetDpopSigner.ts");
    const relay = read("src/features/cloud/managedRelayLayer.ts");
    const session = read("src/features/pairing/workjet-managed-device-session-layer.ts");
    const pairing = read("src/features/pairing/WorkjetDevicePairingProvider.tsx");
    const ios = read("modules/t3-native-controls/ios/T3BusinessOsModule.swift");
    const android = read(
      "modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3BusinessOsModule.kt",
    );

    expect(surface).toContain("nativeWorkjetDeviceProof");
    expect(surface).toContain('readonly crv: "P-256"');
    expect(surface).not.toMatch(/privateJwk|privateKey|\bd:\s*string/iu);
    expect(dpop).toContain("createDpopProofWithSigner");
    expect(nativeSigner).toContain("loadNativeWorkjetDpopSigner");
    expect(nativeSigner).toContain("nativeWorkjetDeviceProof.sign(message)");
    expect(session).toContain("loadNativeWorkjetDpopSigner");
    expect(relay).toContain("loadNativeWorkjetDpopSigner");
    expect(relay).not.toContain("loadOrCreateDpopProofKeyPair");
    expect(pairing).toContain("nativeWorkjetDeviceProof.key()");

    expect(ios).toContain("kSecAttrAccessibleWhenUnlockedThisDeviceOnly");
    expect(ios).toContain("SecKeyCreateSignature");
    expect(ios).toContain("\\(crv)");
    expect(ios).toContain("\\(x)");
    expect(ios).not.toContain('"(crv)"');
    expect(ios).toContain("ctoxWorkjetDeviceProofProvider");
    expect(ios).toContain("writable:false,configurable:false,enumerable:false");
    expect(android).toContain(
      'KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")',
    );
    expect(android).toContain('Signature.getInstance("SHA256withECDSA")');
    expect(android).toContain("ctoxWorkjetDeviceProofProvider");
    expect(android).toContain("writable:false,configurable:false,enumerable:false");
    expect(`${ios}\n${android}`).not.toMatch(/privateKey.*(?:return|put)|"d"\s*(?:to|:)/iu);
  });

  it("keeps managed device control instance-bound, cookie-free and fail-closed", () => {
    const control = read("src/features/pairing/workjet-managed-backend-control-layer.ts");
    const hook = read("src/features/pairing/useManagedWorkjetDeviceInviteControl.ts");
    expect(control).toContain("WORKJET_MANAGED_DEVICE_CONTROL_RESOLVE_PATH");
    expect(control).toContain("WORKJET_MANAGED_DEVICE_CONTROL_CSRF_PATH");
    expect(control).toContain('credentials: "omit"');
    expect(control).toContain('redirect: "error"');
    expect(control).toContain('"x-workjet-csrf"');
    expect(control).toContain("loadNativeWorkjetDpopSigner");
    expect(control).not.toMatch(/primaryEnvironment|environmentId/iu);
    expect(hook).toContain("readManagedWorkjetDeviceSessionAuthorization");
    expect(hook).toContain("authorization.deviceId !== workjetInstallationId");
    expect(hook).not.toMatch(/usePrimaryEnvironment|connectionUrl/iu);
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
