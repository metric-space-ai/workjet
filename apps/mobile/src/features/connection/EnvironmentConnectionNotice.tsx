import {
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@workjet/client-runtime/connection";
import { SymbolView } from "../../components/AppSymbol";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";

function noticeTitle(phase: EnvironmentConnectionPhase, environmentLabel: string): string {
  switch (phase) {
    case "offline":
      return "Du bist offline";
    case "connecting":
      return `Verbindet mit ${environmentLabel} …`;
    case "reconnecting":
      return `Verbindet erneut mit ${environmentLabel} …`;
    case "error":
      return `${environmentLabel} nicht erreichbar`;
    case "available":
      return `${environmentLabel} nicht verbunden`;
    case "connected":
      return "";
  }
}

/** Kurz und deutsch, ohne Rohfehler (UI-Vertrag §2); der Rohtext bleibt in `connection.error`. */
function noticeDetail(phase: EnvironmentConnectionPhase, error: string | null): string {
  if (error) return "Neuer Versuch läuft automatisch.";
  switch (phase) {
    case "offline":
    case "connecting":
    case "reconnecting":
      return "";
    case "available":
    case "error":
      return "Rechner neu verbinden.";
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resourceName: string;
  readonly onRetry: () => void;
}) {
  const iconColor = String(useThemeColor("--color-icon-muted"));
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";
  const detail = noticeDetail(props.connection.phase, props.connection.error);

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <ActivityIndicator size="small" color={iconColor} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColor={iconColor}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-workjet-bold text-foreground">
          {noticeTitle(props.connection.phase, props.environmentLabel)}
        </Text>
        {detail ? (
          <Text className="text-center text-sm leading-normal text-foreground-muted">{detail}</Text>
        ) : null}

        {props.connection.phase !== "offline" ? (
          <Pressable
            accessibilityRole="button"
            className="mt-1 rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
            onPress={props.onRetry}
          >
            <Text className="text-sm font-workjet-bold text-foreground">Erneut versuchen</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
