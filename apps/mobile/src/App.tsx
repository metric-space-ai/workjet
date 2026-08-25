import { BlurTargetView } from "expo-blur";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation, DarkTheme, DefaultTheme } from "@react-navigation/native";

import { RegistryContext } from "@effect/atom-react";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { LoadingScreen } from "./components/LoadingScreen";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { BusinessOsProvider } from "./features/business-os/BusinessOsProvider";
import { BusinessOsSetupScreen } from "./features/mode/BusinessOsSetupScreen";
import { useWorkjetMode, WorkjetModeProvider } from "./features/mode/WorkjetModeProvider";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { OverlayPortalHost } from "./components/OverlayPortal";
import { appBlurTargetRef } from "./lib/appBlurTarget";
import { useThemeColor } from "./lib/useThemeColor";
import { isBusinessOsPairLink, normalizeIncomingWorkjetUrl } from "./lib/workjetLinks";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native module can be unavailable in non-native test environments.
});

const appLinking = {
  prefixes: [
    Linking.createURL("/"),
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
    !isBusinessOsPairLink(url),
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
  const { isReady, mode } = useWorkjetMode();
  if (!isReady) return <LoadingScreen message="Opening Workjet…" />;
  if (mode === "business_os") return <BusinessOsSetupScreen />;
  return <Navigation linking={appLinking} theme={props.dark ? DarkTheme : DefaultTheme} />;
}

export default function App() {
  const colorScheme = useColorScheme();
  const statusBarBg = useThemeColor("--color-status-bar");

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <WorkjetModeProvider>
            <BusinessOsProvider>
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
            </BusinessOsProvider>
          </WorkjetModeProvider>
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}
