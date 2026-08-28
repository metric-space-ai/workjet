import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { useThemeColor } from "../../../lib/useThemeColor";
import type { BusinessOsMobileAppDescriptor } from "./business-os-app-catalog";
import type { BusinessOsRecentApp } from "./native-business-os-home-store";

function recentTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function BusinessOsRecents(props: {
  readonly apps: readonly BusinessOsMobileAppDescriptor[];
  readonly recents: readonly BusinessOsRecentApp[];
  readonly onBack: () => void;
  readonly onOpenApp: (app: BusinessOsMobileAppDescriptor) => void;
}) {
  const insets = useSafeAreaInsets();
  const foreground = useThemeColor("--color-foreground");
  const appsById = new Map(props.apps.map((app) => [app.id, app]));
  const visible = props.recents.flatMap((recent) => {
    const app = appsById.get(recent.appId);
    return app ? [{ app, recent }] : [];
  });

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: Math.max(insets.top, 12) }}>
      <View className="flex-row items-center gap-3 px-5 pb-3">
        <Pressable
          accessibilityLabel="Zurück zum Home Desk"
          accessibilityRole="button"
          className="size-12 items-center justify-center rounded-full bg-subtle-strong active:opacity-70"
          onPress={props.onBack}
        >
          <SymbolView name="chevron.left" size={21} tintColor={foreground} type="monochrome" />
        </Pressable>
        <View>
          <Text className="text-2xl font-t3-bold">Recents</Text>
          <Text className="text-sm text-foreground-muted">
            Nur sichere App-Metadaten, keine Vorschauen
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerClassName="w-full max-w-[900px] self-center gap-3 px-5 pb-12 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {visible.map(({ app, recent }) => (
          <Pressable
            key={app.id}
            accessibilityLabel={`${app.title}, zuletzt um ${recentTime(recent.lastOpenedAtMs)}`}
            accessibilityRole="button"
            className="min-h-20 flex-row items-center gap-4 rounded-[22px] bg-subtle px-4 py-3 active:opacity-75"
            onPress={() => props.onOpenApp(app)}
          >
            <View
              className="size-12 items-center justify-center rounded-[15px]"
              style={{ backgroundColor: app.accent }}
            >
              <SymbolView name={app.icon} size={24} tintColor="#ffffff" type="monochrome" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-base font-t3-bold" numberOfLines={1}>
                {app.title}
              </Text>
              <Text className="mt-1 text-sm text-foreground-muted">
                {recentTime(recent.lastOpenedAtMs)}
              </Text>
            </View>
            <SymbolView name="chevron.right" size={18} tintColor={foreground} type="monochrome" />
          </Pressable>
        ))}
        {visible.length === 0 ? (
          <View className="items-center py-20">
            <Text className="text-base text-foreground-muted">Noch keine Apps geöffnet.</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
