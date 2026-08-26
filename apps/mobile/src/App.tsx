import { BlurTargetView } from "expo-blur";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect } from "react";
import { StatusBar, StyleSheet, useColorScheme, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation, DarkTheme, DefaultTheme } from "@react-navigation/native";

import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { LoadingScreen } from "./components/LoadingScreen";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { BusinessOsProvider } from "./features/business-os/BusinessOsProvider";
import { useBusinessOs } from "./features/business-os/BusinessOsProvider";
import { BusinessOsSetupScreen } from "./features/mode/BusinessOsSetupScreen";
import { WorkjetProductChrome } from "./features/mode/WorkjetProductChrome";
import { WorkjetProductChromeProvider } from "./features/mode/WorkjetProductChromeProvider";
import { useWorkjetMode, WorkjetModeProvider } from "./features/mode/WorkjetModeProvider";
import { WorkjetPairingOnboarding } from "./features/pairing/WorkjetPairingOnboarding";
import {
  useWorkjetDevicePairing,
  WorkjetDevicePairingProvider,
} from "./features/pairing/WorkjetDevicePairingProvider";
import { shouldShowWorkjetPairingOnboarding } from "./features/pairing/workjet-pairing-onboarding-state";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./state/preferences";
import { useSavedRemoteConnections } from "./state/use-remote-environment-registry";
import { OverlayPortalHost } from "./components/OverlayPortal";
import { appBlurTargetRef } from "./lib/appBlurTarget";
import { useThemeColor } from "./lib/useThemeColor";
import {
  isBusinessOsPairLink,
  isWorkjetDevicePairLink,
  normalizeIncomingWorkjetUrl,
} from "./lib/workjetLinks";
import { configureNotificationPresentation } from "./features/business-os/notifications/decision-hub-notifications";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

configureNotificationPresentation();

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native module can be unavailable in non-native test environments.
});

const appLinking = {
  prefixes: [
    Linking.createURL("/", { scheme: "workjet" }),
    "workjet://",
    "workjet-dev://",
    "workjet-preview://",
    // Migration aliases remain inbound-only. All generated links use Workjet.
    "ctox-mobile://",
    "ctox-mobile-dev://",
    "ctox-mobile-preview://",
    "ctox-business-os-mobile://",
    "t3code://",
    "t3code-dev://",
    "t3code-preview://",
  ],
  getInitialURL: async () => {
    const url = await Linking.getInitialURL();
    return url ? normalizeIncomingWorkjetUrl(url) : null;
  },
  subscribe: (listener: (url: string) => void) => {
    const subscription = Linking.addEventListener("url", ({ url }) => {
      listener(normalizeIncomingWorkjetUrl(url));
    });
    return () => subscription.remove();
  },
  // The Expo dev client launches the app via
  // <scheme>://expo-development-client/?url=<packager> — that URL addresses
  // the launcher, not app navigation. Without this filter it falls through
  // to the NotFound wildcard route on every dev launch.
  // expo-sharing uses a private lifecycle URL only to wake the app. The
  // persisted share inbox below owns navigation once the payload is durable.
  filter: (url: string) =>
    !url.includes("expo-development-client") &&
    !url.includes("://expo-sharing") &&
    !isBusinessOsPairLink(url) &&
    !isWorkjetDevicePairLink(url),
};

const Navigation = createStaticNavigation(RootStack);

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();
  const { isReady: isModeReady } = useWorkjetMode();

  useEffect(() => {
    if (isReady && isModeReady) void SplashScreen.hide();
  }, [isModeReady, isReady]);

  return null;
}

function WorkjetModeRoot(props: { readonly dark: boolean }) {
  const { isReady, mode, setMode } = useWorkjetMode();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const { instances, isReady: businessOsRegistryReady } = useBusinessOs();
  const { importPairingPayload } = useWorkjetDevicePairing();
  const { isLoadingSavedConnection, savedConnectionsById } = useSavedRemoteConnections();
  const preferencesReady = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const pairingStateReady =
    preferencesReady && !isLoadingSavedConnection && businessOsRegistryReady;
  const showPairingOnboarding = shouldShowWorkjetPairingOnboarding({
    preferencesReady,
    environmentRegistryReady: !isLoadingSavedConnection,
    businessOsRegistryReady,
    onboardingDismissed:
      AsyncResult.isSuccess(preferences) &&
      preferences.value.workjetPairingOnboardingDismissed === true,
    pairedEnvironmentCount: Object.keys(savedConnectionsById).length,
    pairedBusinessOsInstanceCount: instances.length,
  });
  const continueWithoutPairing = useCallback(() => {
    setMode("code");
    savePreferences({ workjetPairingOnboardingDismissed: true });
  }, [savePreferences, setMode]);
  if (!isReady || !pairingStateReady) return <LoadingScreen message="Opening Workjet…" />;
  return (
    <WorkjetProductChromeProvider>
      <WorkjetProductChrome />
      <SafeAreaProvider style={styles.workjetContent}>
        <View className="flex-1 bg-screen">
          {showPairingOnboarding ? (
            <WorkjetPairingOnboarding
              onContinueWithoutPairing={continueWithoutPairing}
              onPairingPayload={importPairingPayload}
            />
          ) : null}
          <View
            accessibilityElementsHidden={showPairingOnboarding || mode !== "code"}
            importantForAccessibility={
              !showPairingOnboarding && mode === "code" ? "auto" : "no-hide-descendants"
            }
            pointerEvents={!showPairingOnboarding && mode === "code" ? "auto" : "none"}
            style={[
              StyleSheet.absoluteFill,
              { opacity: !showPairingOnboarding && mode === "code" ? 1 : 0 },
            ]}
          >
            <Navigation linking={appLinking} theme={props.dark ? DarkTheme : DefaultTheme} />
          </View>
          <View
            accessibilityElementsHidden={showPairingOnboarding || mode !== "business_os"}
            importantForAccessibility={
              !showPairingOnboarding && mode === "business_os" ? "auto" : "no-hide-descendants"
            }
            pointerEvents={!showPairingOnboarding && mode === "business_os" ? "auto" : "none"}
            style={[
              StyleSheet.absoluteFill,
              { opacity: !showPairingOnboarding && mode === "business_os" ? 1 : 0 },
            ]}
          >
            <BusinessOsSetupScreen active={!showPairingOnboarding && mode === "business_os"} />
          </View>
        </View>
      </SafeAreaProvider>
    </WorkjetProductChromeProvider>
  );
}

const styles = StyleSheet.create({
  workjetContent: { flex: 1 },
});

export default function App() {
  const colorScheme = useColorScheme();
  const statusBarBg = useThemeColor("--color-status-bar");

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <WorkjetModeProvider>
            <BusinessOsProvider>
              <WorkjetDevicePairingProvider>
                <SplashScreenCoordinator />
                <GestureHandlerRootView className="flex-1">
                  <KeyboardProvider statusBarTranslucent>
                    <SafeAreaProvider>
                      <StatusBar
                        barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
                        backgroundColor={statusBarBg}
                        translucent
                      />
                      {/* The navigation theme drives the NATIVE header appearance: native-stack
                      forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                      this, React Navigation defaults to its light theme and every native
                      header (glass buttons, title, materials) is forced light even when
                      the system is in dark mode. */}
                      {/* Blur target for Android dropdown backdrops — see appBlurTarget.ts. */}
                      <BlurTargetView ref={appBlurTargetRef} style={{ flex: 1 }}>
                        <IncomingShareProvider>
                          <WorkjetModeRoot dark={colorScheme === "dark"} />
                        </IncomingShareProvider>
                        <ConfirmDialogHost />
                      </BlurTargetView>
                      {/* Anchored-menu overlays render here — in-window, so the
                      keyboard stays up while a dropdown is open. */}
                      <OverlayPortalHost />
                    </SafeAreaProvider>
                  </KeyboardProvider>
                </GestureHandlerRootView>
              </WorkjetDevicePairingProvider>
            </BusinessOsProvider>
          </WorkjetModeProvider>
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}
