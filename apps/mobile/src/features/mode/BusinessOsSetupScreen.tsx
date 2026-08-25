import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { BrandMark } from "../../components/BrandMark";
import { BusinessOsSettingsPanel } from "../business-os/components/BusinessOsSettingsPanel";
import { useWorkjetMode } from "./WorkjetModeProvider";

export function BusinessOsSetupScreen() {
  const insets = useSafeAreaInsets();
  const { setMode } = useWorkjetMode();

  return (
    <View
      className="flex-1 bg-screen px-5"
      style={{ paddingBottom: Math.max(insets.bottom, 20), paddingTop: Math.max(insets.top, 20) }}
    >
      <View className="flex-row items-center justify-between">
        <BrandMark compact />
        <View
          accessibilityLabel="Current mode: Business OS"
          accessibilityRole="text"
          className="rounded-full bg-subtle px-3 py-1.5"
        >
          <Text className="text-sm font-t3-bold text-foreground">Business OS</Text>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="w-full max-w-[960px] self-center gap-5 py-8"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 20) + 20 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-2">
          <Text className="text-3xl font-t3-bold text-foreground">Connect a CTOX Backend</Text>
          <Text className="max-w-[560px] text-base leading-normal text-foreground-muted">
            Business OS needs a paired CTOX Backend. Code remains available on this device without a
            backend.
          </Text>
        </View>

        <View className="gap-3">
          <BusinessOsSettingsPanel />
          <Pressable
            accessibilityRole="button"
            onPress={() => setMode("code")}
            className="min-h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-70"
          >
            <Text className="text-base font-t3-bold text-primary-foreground">Return to Code</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
