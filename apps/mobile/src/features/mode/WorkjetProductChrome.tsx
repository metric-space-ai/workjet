import { Pressable, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useWorkjetMode } from "./WorkjetModeProvider";
import { useWorkjetProductChrome } from "./WorkjetProductChromeProvider";
import type { WorkjetMode } from "./workjet-mode";

function ModeButton(props: {
  readonly label: string;
  readonly mode: WorkjetMode;
  readonly selected: boolean;
  readonly onSelect: (mode: WorkjetMode) => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`${props.label} öffnen`}
      accessibilityRole="tab"
      accessibilityState={{ selected: props.selected }}
      className={
        props.selected
          ? "min-h-9 justify-center rounded-[10px] bg-screen px-3 shadow-sm"
          : "min-h-9 justify-center rounded-[10px] px-3 active:bg-screen/60"
      }
      onPress={() => props.onSelect(props.mode)}
    >
      <Text
        className={
          props.selected
            ? "text-sm font-t3-bold text-foreground"
            : "text-sm font-t3-medium text-foreground-muted"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function WorkjetProductChrome() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const foreground = useThemeColor("--color-foreground");
  const muted = useThemeColor("--color-foreground-muted");
  const { mode, setMode } = useWorkjetMode();
  const { sidebar } = useWorkjetProductChrome();
  const showWordmark = width >= 720;
  const sidebarAvailable = sidebar?.available === true;

  return (
    <View
      accessibilityLabel="Workjet Produktnavigation"
      className="z-50 flex-row items-end gap-2 border-b border-border bg-sidebar px-3 pb-2"
      style={{ paddingTop: Math.max(insets.top, 8) }}
    >
      <Pressable
        accessibilityLabel={
          sidebar?.visible ? "Linke Navigation ausblenden" : "Linke Navigation einblenden"
        }
        accessibilityRole="button"
        accessibilityState={{ disabled: !sidebarAvailable }}
        className="size-10 items-center justify-center rounded-[11px] active:bg-subtle-strong"
        disabled={!sidebarAvailable}
        onPress={sidebar?.toggle}
      >
        <SymbolView
          name="sidebar.left"
          size={20}
          tintColor={sidebarAvailable ? foreground : muted}
          type="monochrome"
        />
      </Pressable>

      <View accessibilityRole="tablist" className="flex-row rounded-[13px] bg-subtle-strong p-1">
        <ModeButton label="Code" mode="code" selected={mode === "code"} onSelect={setMode} />
        <ModeButton
          label="Business OS"
          mode="business_os"
          selected={mode === "business_os"}
          onSelect={setMode}
        />
      </View>

      <View className="flex-1" />
      {showWordmark ? <Text className="pb-2 text-sm font-t3-bold">Workjet</Text> : null}
    </View>
  );
}
