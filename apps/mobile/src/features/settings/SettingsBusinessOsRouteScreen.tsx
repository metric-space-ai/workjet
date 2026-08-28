import { useNavigation } from "@react-navigation/native";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { BusinessOsSettingsPanel } from "../business-os/components/BusinessOsSettingsPanel";
import { NativeStackScreenOptions } from "../../native/StackHeader";

export function SettingsBusinessOsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Business OS" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <BusinessOsSettingsPanel />
      </ScrollView>
    </View>
  );
}
