import { useEffect, useState } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { ErrorBanner } from "../../../components/ErrorBanner";
import type { BusinessOsInstance } from "../registry/business-os-registry";
import { loadBusinessOsLaunchSecrets } from "../registry/business-os-registry";
import { nativeBusinessOsSecretStore } from "../registry/native-business-os-registry";
import { setBusinessOsContentProtected } from "../security/content-protection";
import { deliverDecisionHubNotification } from "../notifications/decision-hub-notifications";
import { buildBusinessOsLaunchContext } from "./launch-context";
import {
  isNativeBusinessOsSurfaceSupported,
  resolveNativeBusinessOsSurface,
} from "./native-business-os-surface";

interface LaunchState {
  readonly sessionJson: string;
  readonly configJson: string;
}

export function BusinessOsShellHost(props: {
  readonly instance: BusinessOsInstance;
  readonly shellRootUri: string;
  readonly packId: string;
  readonly commandJson?: string;
  readonly onShellMessage?: (raw: string) => void;
}) {
  const [launch, setLaunch] = useState<LaunchState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setBusinessOsContentProtected(true);
    void loadBusinessOsLaunchSecrets(props.instance, nativeBusinessOsSecretStore)
      .then((secrets) =>
        buildBusinessOsLaunchContext(
          props.instance,
          secrets,
          Platform.OS === "ios" ? "ios" : "android",
        ),
      )
      .then((value) => {
        if (current) setLaunch(value);
      })
      .catch(() => {
        if (current) setError("Instanz startet nicht. Erneut verbinden.");
      });
    return () => {
      current = false;
      setBusinessOsContentProtected(false);
    };
  }, [props.instance]);

  if (error) return <ErrorBanner message={error} />;
  const Surface = resolveNativeBusinessOsSurface();
  if (!Surface || !isNativeBusinessOsSurfaceSupported()) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-sm text-foreground-muted">
          System-WebView zu alt. WebView aktualisieren.
        </Text>
      </View>
    );
  }
  if (!launch) {
    return <Text className="py-10 text-center text-foreground-muted">Öffnet Instanz…</Text>;
  }
  return (
    <Surface
      style={{ flex: 1 }}
      storageIdentity={props.instance.storageIdentity}
      shellRootUri={props.shellRootUri}
      sessionJson={launch.sessionJson}
      configJson={launch.configJson}
      commandJson={props.commandJson}
      launchKey={`${props.packId}:${props.instance.updatedAtMs}`}
      onError={() => setError("Das Business-OS-Paket konnte nicht geladen werden.")}
      onShellMessage={(event) => props.onShellMessage?.(event.nativeEvent.message)}
      onNotification={(event) => {
        void deliverDecisionHubNotification({
          storageIdentity: props.instance.storageIdentity,
          payload: event.nativeEvent,
        }).catch(() => {
          // Permission and delivery errors are reflected by the device-level
          // notification setting; the isolated Business OS surface stays usable.
        });
      }}
    />
  );
}
