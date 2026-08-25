import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { useThemeColor } from "../../../lib/useThemeColor";
import { BusinessOsSettingsPanel } from "../components/BusinessOsSettingsPanel";

export function BusinessOsNativeSettings(props: { readonly onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const foreground = useThemeColor("--color-foreground");
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
          <Text className="text-2xl font-t3-bold">Business OS Einstellungen</Text>
          <Text className="text-sm text-foreground-muted">Backends, Pairing und Datenschutz</Text>
        </View>
      </View>
      <ScrollView
        contentContainerClassName="px-5 pb-12 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 20) + 20 }}
        showsVerticalScrollIndicator={false}
      >
        <BusinessOsSettingsPanel />
      </ScrollView>
    </View>
  );
}
