import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassSurface } from "../../../components/GlassSurface";

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
    <GlassSurface
      accessibilityLabel="Business OS Dock"
      fallbackStyle={{ backgroundColor: "rgba(28, 28, 30, 0.78)" }}
      style={{
        alignSelf: "center",
        marginBottom: Math.max(insets.bottom, 8),
        minHeight: 80,
        paddingHorizontal: 16,
        paddingVertical: 8,
      }}
    >
      <View className="flex-row items-center justify-center gap-3">{props.children}</View>
    </GlassSurface>
  );
}
