import * as Haptics from "expo-haptics";
import { memo, useMemo } from "react";
import { Platform, Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import type { BusinessOsMobileAppDescriptor } from "./business-os-app-catalog";

function rawAppIcon(props: {
  readonly app: BusinessOsMobileAppDescriptor;
  readonly badge?: number;
  readonly compact?: boolean;
  readonly editing?: boolean;
  readonly index?: number;
  readonly columns?: number;
  readonly onOpen: () => void;
  readonly onEdit: () => void;
  readonly onDrop?: (sourceIndex: number, targetIndex: number) => void;
}) {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const cellSize = props.compact ? 78 : 92;
  const iconSize = props.compact ? 58 : 66;
  const columns = Math.max(1, props.columns ?? 4);
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(props.editing === true && props.index !== undefined && props.onDrop !== undefined)
        .activateAfterLongPress(120)
        .onBegin(() => {
          scale.value = withSpring(1.08, {
            damping: 18,
            stiffness: 220,
            reduceMotion: ReduceMotion.System,
          });
        })
        .onUpdate((event) => {
          translateX.value = event.translationX;
          translateY.value = event.translationY;
        })
        .onEnd((event) => {
          if (props.index === undefined || !props.onDrop) return;
          const columnDelta = Math.round(event.translationX / cellSize);
          const rowDelta = Math.round(event.translationY / (cellSize + 18));
          const targetIndex = Math.max(0, props.index + rowDelta * columns + columnDelta);
          runOnJS(props.onDrop)(props.index, targetIndex);
        })
        .onFinalize(() => {
          translateX.value = withSpring(0, {
            damping: 20,
            stiffness: 240,
            reduceMotion: ReduceMotion.System,
          });
          translateY.value = withSpring(0, {
            damping: 20,
            stiffness: 240,
            reduceMotion: ReduceMotion.System,
          });
          scale.value = withSpring(1, {
            damping: 20,
            stiffness: 240,
            reduceMotion: ReduceMotion.System,
          });
        }),
    [cellSize, columns, props.editing, props.index, props.onDrop, scale, translateX, translateY],
  );
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
    zIndex: Math.abs(translateX.value) + Math.abs(translateY.value) > 0 ? 20 : 0,
  }));

  const longPress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    props.onEdit();
  };

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[{ alignItems: "center", width: cellSize }, animatedStyle]}>
        <Pressable
          accessibilityHint={props.app.desktopOnly ? "Nur auf Desktop verfügbar" : undefined}
          accessibilityLabel={props.app.title}
          accessibilityRole="button"
          disabled={props.editing}
          onLongPress={longPress}
          onPress={props.onOpen}
          className="items-center active:opacity-75"
        >
          <View
            className="items-center justify-center overflow-hidden shadow-lg"
            style={{
              width: iconSize,
              height: iconSize,
              borderRadius: Platform.OS === "android" ? iconSize * 0.3 : iconSize * 0.225,
              backgroundColor: props.app.accent,
              opacity: props.app.desktopOnly ? 0.55 : 1,
            }}
          >
            <SymbolView
              name={props.app.icon}
              size={iconSize * 0.48}
              tintColor="#ffffff"
              type="monochrome"
            />
            {props.editing ? (
              <View className="absolute left-1 top-1 size-5 items-center justify-center rounded-full bg-black/55">
                <Text className="text-xs font-t3-bold text-white">−</Text>
              </View>
            ) : null}
          </View>
          {props.badge && props.badge > 0 ? (
            <View className="absolute -right-0.5 -top-1 min-w-6 items-center rounded-full bg-red-500 px-1.5 py-0.5">
              <Text className="text-xs font-t3-bold text-white">{Math.min(props.badge, 99)}</Text>
            </View>
          ) : null}
          {!props.compact ? (
            <Text
              className="mt-1.5 max-w-24 text-center text-xs font-t3-medium text-foreground"
              numberOfLines={2}
            >
              {props.app.title}
            </Text>
          ) : null}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

export const BusinessOsAppIcon = memo(rawAppIcon);
