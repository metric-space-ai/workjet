import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function BusinessOsPlatformHeader(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View className="px-5" style={{ paddingTop: Math.max(insets.top, 12) }}>
      {props.children}
    </View>
  );
}

export function BusinessOsPlatformDock(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="mx-auto min-h-20 flex-row items-center justify-center gap-3 rounded-[28px] bg-card-translucent px-4 py-2"
      style={{ marginBottom: Math.max(insets.bottom, 8) }}
    >
      {props.children}
    </View>
  );
}
