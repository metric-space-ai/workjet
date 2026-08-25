import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { BrandMark } from "../../../components/BrandMark";
import { SymbolView } from "../../../components/AppSymbol";
import { useThemeColor } from "../../../lib/useThemeColor";
import { useWorkjetMode } from "../../mode/WorkjetModeProvider";
import { useBusinessOs } from "../BusinessOsProvider";
import { BusinessOsSettingsPanel } from "../components/BusinessOsSettingsPanel";
import { BusinessOsShellHost } from "../shell/BusinessOsShellHost";
import {
  BUILT_IN_BUSINESS_OS_MOBILE_CATALOG,
  mergeBusinessOsMobileCatalog,
  type BusinessOsMobileAppCatalog,
  type BusinessOsMobileAppDescriptor,
} from "./business-os-app-catalog";
import {
  businessOsWindowClass,
  createDefaultBusinessOsHomeLayout,
  reconcileBusinessOsHomeLayout,
  type BusinessOsHomeLayout,
} from "./business-os-home-layout";
import {
  BUSINESS_OS_SHELL_PROTOCOL,
  decodeBusinessOsShellMessage,
  encodeBusinessOsHostCommand,
  type BusinessOsShellMessage,
} from "./business-os-shell-protocol";
import { BusinessOsAppLibrary } from "./BusinessOsAppLibrary";
import { BusinessOsHomeDesk } from "./BusinessOsHomeDesk";
import { BusinessOsNativeSettings } from "./BusinessOsNativeSettings";
import { BusinessOsRecents } from "./BusinessOsRecents";
import {
  addBusinessOsRecent,
  nativeBusinessOsHomeStore,
  type BusinessOsRecentApp,
} from "./native-business-os-home-store";

type BusinessOsRoute = "home" | "search" | "recents" | "settings" | "app";

export interface BusinessOsActivatedShellPack {
  readonly packId: string;
  readonly rootUri: string;
}

function SetupRoute() {
  const insets = useSafeAreaInsets();
  const { setMode } = useWorkjetMode();
  return (
    <View
      className="flex-1 bg-screen px-5"
      style={{ paddingBottom: Math.max(insets.bottom, 20), paddingTop: Math.max(insets.top, 20) }}
    >
      <View className="w-full max-w-[920px] flex-1 self-center">
        <View className="flex-row items-center justify-between">
          <BrandMark compact />
          <Pressable
            accessibilityLabel="In Code wechseln"
            accessibilityRole="button"
            className="min-h-12 justify-center rounded-full bg-subtle-strong px-4 active:opacity-70"
            onPress={() => setMode("code")}
          >
            <Text className="font-t3-bold">Code</Text>
          </Pressable>
        </View>
        <View className="pb-6 pt-10">
          <Text className="text-4xl font-t3-bold">Workjet einrichten</Text>
          <Text className="mt-3 max-w-[620px] text-base leading-normal text-foreground-muted">
            Scanne einen kurzlebigen Workjet QR-Code. Signaling-Server und Zugangsdaten werden
            sicher übernommen; eine manuelle Eingabe ist nicht erforderlich.
          </Text>
        </View>
        <ScrollView contentContainerClassName="pb-10" showsVerticalScrollIndicator={false}>
          <BusinessOsSettingsPanel />
        </ScrollView>
      </View>
    </View>
  );
}

function AppCanvasHeader(props: {
  readonly app: BusinessOsMobileAppDescriptor | null;
  readonly canGoBack: boolean;
  readonly onBack: () => void;
  readonly onHome: () => void;
}) {
  const insets = useSafeAreaInsets();
  const foreground = useThemeColor("--color-foreground");
  return (
    <View
      className="z-10 min-h-16 flex-row items-center gap-3 border-b border-border bg-screen/95 px-3 pb-2"
      style={{ paddingTop: Math.max(insets.top, 8) }}
    >
      <Pressable
        accessibilityLabel={props.canGoBack ? "Zurück" : "Zum Home Desk"}
        accessibilityRole="button"
        className="size-12 items-center justify-center rounded-full bg-subtle-strong active:opacity-70"
        onPress={props.onBack}
      >
        <SymbolView name="chevron.left" size={21} tintColor={foreground} type="monochrome" />
      </Pressable>
      {props.app ? (
        <View
          className="size-9 items-center justify-center rounded-[11px]"
          style={{ backgroundColor: props.app.accent }}
        >
          <SymbolView name={props.app.icon} size={19} tintColor="#ffffff" type="monochrome" />
        </View>
      ) : null}
      <Text className="min-w-0 flex-1 text-lg font-t3-bold" numberOfLines={1}>
        {props.app?.title ?? "Business OS"}
      </Text>
      <Pressable
        accessibilityLabel="Home Desk"
        accessibilityRole="button"
        className="size-12 items-center justify-center rounded-full bg-subtle-strong active:opacity-70"
        onPress={props.onHome}
      >
        <SymbolView name="folder.fill" size={21} tintColor={foreground} type="monochrome" />
      </Pressable>
    </View>
  );
}

function UnavailableShell(props: { readonly app: BusinessOsMobileAppDescriptor | null }) {
  const foreground = useThemeColor("--color-foreground");
  return (
    <View className="flex-1 items-center justify-center bg-screen px-8">
      <View className="size-20 items-center justify-center rounded-[24px] bg-subtle-strong">
        <SymbolView name="arrow.down.circle" size={36} tintColor={foreground} type="monochrome" />
      </View>
      <Text className="mt-6 text-center text-2xl font-t3-bold">
        {props.app?.title ?? "Business OS"} ist noch nicht bereit
      </Text>
      <Text className="mt-3 max-w-[520px] text-center text-base leading-normal text-foreground-muted">
        Das signierte Business-OS-Paket ist auf diesem Gerät noch nicht aktiviert. Workjet bleibt
        gesperrt, bis Paket, Revision und Ed25519-Vertrauenskette vollständig geprüft sind.
      </Text>
    </View>
  );
}

export function BusinessOsMobileRoot(props: {
  /** Set only by the native verified-pack lifecycle. Production currently stays fail-closed. */
  readonly activatedShellPack?: BusinessOsActivatedShellPack | null;
}) {
  const { width } = useWindowDimensions();
  const colorScheme = useColorScheme();
  const reducedMotion = useReducedMotion();
  const { setMode } = useWorkjetMode();
  const { isReady, selected } = useBusinessOs();
  const [route, setRoute] = useState<BusinessOsRoute>("home");
  const [layout, setLayout] = useState<BusinessOsHomeLayout | null>(null);
  const [recents, setRecents] = useState<readonly BusinessOsRecentApp[]>([]);
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<BusinessOsMobileAppCatalog>(
    BUILT_IN_BUSINESS_OS_MOBILE_CATALOG,
  );
  const [badges, setBadges] = useState<ReadonlyMap<string, number>>(new Map());
  const [shellState, setShellState] = useState<Extract<
    BusinessOsShellMessage,
    { readonly type: "app.state" }
  > | null>(null);
  const [commandJson, setCommandJson] = useState(() =>
    encodeBusinessOsHostCommand({
      protocol: BUSINESS_OS_SHELL_PROTOCOL,
      type: "host.configure",
      platform: Platform.OS === "ios" ? "ios" : "android",
      windowClass: businessOsWindowClass(width),
      colorScheme: colorScheme === "dark" ? "dark" : "light",
      reducedMotion,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    }),
  );
  const apps = useMemo(() => mergeBusinessOsMobileCatalog(catalog).apps, [catalog]);
  const activeApp = apps.find((app) => app.id === activeAppId) ?? null;

  useEffect(() => {
    setRoute("home");
    setActiveAppId(null);
    setCatalog(BUILT_IN_BUSINESS_OS_MOBILE_CATALOG);
    setBadges(new Map());
    if (!selected) {
      setLayout(null);
      setRecents([]);
      return;
    }
    let current = true;
    void nativeBusinessOsHomeStore.load(selected.id).then((stored) => {
      if (!current) return;
      setLayout(
        reconcileBusinessOsHomeLayout(
          stored.layout ?? createDefaultBusinessOsHomeLayout(apps),
          apps,
        ),
      );
      setRecents(stored.recents);
    });
    return () => {
      current = false;
    };
  }, [selected?.id]);

  useEffect(() => {
    if (!selected || !layout) return;
    void nativeBusinessOsHomeStore.save({ instanceId: selected.id, layout, recents });
  }, [layout, recents, selected]);

  useEffect(() => {
    if (!layout) return;
    setLayout((current) => (current ? reconcileBusinessOsHomeLayout(current, apps) : current));
  }, [catalog.revision]);

  const send = useCallback((command: Parameters<typeof encodeBusinessOsHostCommand>[0]) => {
    setCommandJson(encodeBusinessOsHostCommand(command));
  }, []);

  const openApp = useCallback(
    (app: BusinessOsMobileAppDescriptor) => {
      setShellState(null);
      setActiveAppId(app.id);
      setRoute("app");
      setRecents((current) => addBusinessOsRecent(current, app.id));
      send({ protocol: BUSINESS_OS_SHELL_PROTOCOL, type: "app.open", appId: app.id });
    },
    [send],
  );

  const goHome = useCallback(() => {
    if (activeAppId) {
      send({ protocol: BUSINESS_OS_SHELL_PROTOCOL, type: "app.suspend", appId: activeAppId });
    }
    setRoute("home");
  }, [activeAppId, send]);

  const goBack = useCallback(() => {
    if (route === "app" && shellState?.canGoBack) {
      send({ protocol: BUSINESS_OS_SHELL_PROTOCOL, type: "navigation.back" });
      return;
    }
    if (route !== "home") setRoute("home");
    else setMode("code");
  }, [route, send, setMode, shellState?.canGoBack]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      goBack();
      return true;
    });
    return () => subscription.remove();
  }, [goBack]);

  const onShellMessage = useCallback((raw: string) => {
    let message: BusinessOsShellMessage;
    try {
      message = decodeBusinessOsShellMessage(raw);
    } catch {
      return;
    }
    if (message.type === "catalog.replace") setCatalog(message.catalog);
    if (message.type === "app.state") setShellState(message);
    if (message.type === "badge.update") {
      setBadges((current) => {
        const next = new Map(current);
        if (message.count === 0) next.delete(message.appId);
        else next.set(message.appId, message.count);
        return next;
      });
    }
  }, []);

  if (!isReady) {
    return (
      <View className="flex-1 items-center justify-center bg-screen">
        <Text className="text-base text-foreground-muted">Workjet wird geöffnet…</Text>
      </View>
    );
  }
  if (!selected) return <SetupRoute />;
  if (!layout) {
    return (
      <View className="flex-1 items-center justify-center bg-screen">
        <Text className="text-base text-foreground-muted">Home Desk wird vorbereitet…</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      <View
        className="absolute inset-0 bg-screen"
        pointerEvents={route === "app" ? "auto" : "none"}
        style={{ opacity: route === "app" ? 1 : 0 }}
      >
        <AppCanvasHeader
          app={activeApp}
          canGoBack={shellState?.canGoBack === true}
          onBack={goBack}
          onHome={goHome}
        />
        <View className="flex-1">
          {props.activatedShellPack ? (
            <BusinessOsShellHost
              commandJson={commandJson}
              instance={selected}
              onShellMessage={onShellMessage}
              packId={props.activatedShellPack.packId}
              shellRootUri={props.activatedShellPack.rootUri}
            />
          ) : (
            <UnavailableShell app={activeApp} />
          )}
        </View>
      </View>

      {route === "home" ? (
        <BusinessOsHomeDesk
          apps={apps}
          badges={badges}
          instance={selected}
          layout={layout}
          onLayoutChange={setLayout}
          onOpenApp={openApp}
          onOpenRecents={() => setRoute("recents")}
          onOpenSearch={() => setRoute("search")}
          onOpenSettings={() => setRoute("settings")}
          onReturnToCode={() => setMode("code")}
        />
      ) : null}
      {route === "search" ? (
        <BusinessOsAppLibrary apps={apps} onBack={goHome} onOpenApp={openApp} />
      ) : null}
      {route === "recents" ? (
        <BusinessOsRecents apps={apps} onBack={goHome} onOpenApp={openApp} recents={recents} />
      ) : null}
      {route === "settings" ? <BusinessOsNativeSettings onBack={goHome} /> : null}
    </View>
  );
}
