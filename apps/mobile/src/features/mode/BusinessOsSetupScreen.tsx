import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { BrandMark } from "../../components/BrandMark";
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

      <View className="flex-1 justify-center gap-5 self-center w-full max-w-[680px]">
        <View className="gap-2">
          <Text className="text-3xl font-t3-bold text-foreground">Connect a CTOX Backend</Text>
          <Text className="max-w-[560px] text-base leading-normal text-foreground-muted">
            Business OS needs a paired CTOX Backend. Code remains available on this device without a
            backend.
          </Text>
        </View>

        <View className="gap-3">
          <View className="rounded-[24px] border-continuous bg-card p-5">
            <Text className="text-base font-t3-bold text-foreground">Pairing arrives next</Text>
            <Text className="mt-1 text-sm leading-normal text-foreground-muted">
              The next Mobile slice adds secure QR scanning, backend selection and the Business OS
              shell. Signaling credentials will not require manual entry.
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => setMode("code")}
            className="min-h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-70"
          >
            <Text className="text-base font-t3-bold text-primary-foreground">Return to Code</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
