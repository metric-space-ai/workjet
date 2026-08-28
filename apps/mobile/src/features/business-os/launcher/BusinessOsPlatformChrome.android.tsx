import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function BusinessOsPlatformHeader(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View className="px-6 pb-2" style={{ paddingTop: Math.max(insets.top, 20) }}>
      <View className="min-h-24 justify-end">{props.children}</View>
    </View>
  );
}

export function BusinessOsPlatformDock(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityLabel="Business OS Dock"
      className="mx-auto min-h-20 flex-row items-center justify-center gap-3 rounded-[30px] bg-card px-4 py-2 shadow-lg"
      style={{ marginBottom: Math.max(insets.bottom, 8) }}
    >
      {props.children}
    </View>
  );
}
