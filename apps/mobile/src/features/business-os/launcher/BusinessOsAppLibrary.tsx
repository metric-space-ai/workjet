import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { useThemeColor } from "../../../lib/useThemeColor";
import type { BusinessOsMobileAppDescriptor } from "./business-os-app-catalog";
import { BusinessOsAppIcon } from "./BusinessOsAppIcon";

export function BusinessOsAppLibrary(props: {
  readonly apps: readonly BusinessOsMobileAppDescriptor[];
  readonly onBack: () => void;
  readonly onOpenApp: (app: BusinessOsMobileAppDescriptor) => void;
}) {
  const insets = useSafeAreaInsets();
  const foreground = useThemeColor("--color-foreground");
  const [query, setQuery] = useState("");
  const categories = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const visible = props.apps.filter(
      (app) =>
        !normalized ||
        app.title.toLocaleLowerCase().includes(normalized) ||
        app.category.toLocaleLowerCase().includes(normalized),
    );
    return [...new Set(visible.map((app) => app.category))].map((category) => ({
      category,
      apps: visible.filter((app) => app.category === category),
    }));
  }, [props.apps, query]);

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
        <View className="min-h-12 flex-1 flex-row items-center gap-3 rounded-full bg-subtle-strong px-4">
          <SymbolView name="magnifyingglass" size={18} tintColor={foreground} type="monochrome" />
          <TextInput
            accessibilityLabel="Apps durchsuchen"
            autoFocus
            className="min-w-0 flex-1 text-base text-foreground"
            onChangeText={setQuery}
            placeholder="Apps durchsuchen"
            placeholderTextColor={foreground}
            returnKeyType="search"
            value={query}
          />
        </View>
      </View>

      <ScrollView
        contentContainerClassName="w-full max-w-[960px] self-center gap-7 px-5 pb-12 pt-4"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        {categories.map(({ category, apps }) => (
          <View key={category} className="gap-4">
            <Text className="px-1 text-sm font-t3-bold uppercase tracking-wider text-foreground-muted">
              {category}
            </Text>
            <View className="flex-row flex-wrap gap-y-5">
              {apps.map((app) => (
                <View key={app.id} className="w-1/4 min-w-[86px] items-center">
                  <BusinessOsAppIcon
                    app={app}
                    onEdit={() => undefined}
                    onOpen={() => props.onOpenApp(app)}
                  />
                </View>
              ))}
            </View>
          </View>
        ))}
        {categories.length === 0 ? (
          <View className="items-center py-16">
            <Text className="text-base text-foreground-muted">Keine passende App gefunden.</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
