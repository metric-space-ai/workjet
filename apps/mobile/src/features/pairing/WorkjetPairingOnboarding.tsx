import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";

export function WorkjetPairingOnboarding(props: {
  readonly onContinueWithoutPairing: () => void;
  readonly onPairingPayload: (payload: string) => Promise<boolean>;
}) {
  const foreground = useThemeColor("--color-foreground");
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scannerLocked, setScannerLocked] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openScanner = useCallback(async () => {
    setError(null);
    if (cameraPermission?.granted) {
      setScannerVisible(true);
      return;
    }
    const permission = await requestCameraPermission();
    if (permission.granted) setScannerVisible(true);
    else setError("Kamerazugriff ist erforderlich, um den Workjet-QR-Code zu scannen.");
  }, [cameraPermission?.granted, requestCameraPermission]);

  const scan = useCallback(
    ({ data }: { readonly data: string }) => {
      if (scannerLocked || pairing) return;
      setScannerLocked(true);
      setPairing(true);
      setError(null);
      void props
        .onPairingPayload(data)
        .catch((cause) => {
          setError(
            cause instanceof Error
              ? cause.message
              : "Der QR-Code konnte nicht als Workjet-Pairing gelesen werden.",
          );
        })
        .finally(() => {
          setPairing(false);
          setTimeout(() => setScannerLocked(false), 600);
        });
    },
    [pairing, props.onPairingPayload, scannerLocked],
  );

  return (
    <View className="flex-1 bg-screen px-5 py-6">
      <View className="w-full max-w-[760px] flex-1 self-center">
        <View className="flex-row items-center gap-3">
          <View className="size-12 items-center justify-center rounded-[15px] bg-subtle-strong">
            <SymbolView
              name="qrcode.viewfinder"
              size={25}
              tintColor={foreground}
              type="monochrome"
            />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-2xl font-t3-bold">Workjet verbinden</Text>
            <Text className="mt-1 text-sm text-foreground-muted">
              Ein Pairing für Code und Business OS
            </Text>
          </View>
        </View>

        <View className="mt-8 rounded-[24px] bg-card p-5">
          <Text className="text-lg font-t3-bold">QR-Code in Workjet Desktop öffnen</Text>
          <Text className="mt-3 text-base leading-normal text-foreground-muted">
            Öffne Workjet Desktop und wähle im Footer der linken Seitenleiste „Mobilgerät
            verbinden“. Zeige dort den kurzlebigen QR-Code an und scanne ihn hier. Workjet übernimmt
            CTOX-Signaling, Geräteidentität und Synchronisierung automatisch – ohne Server- oder
            Passworteingabe.
          </Text>
        </View>

        {scannerVisible ? (
          <View className="mt-5 overflow-hidden rounded-[26px] border border-border bg-black">
            {cameraPermission?.granted ? (
              <CameraView
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={scan}
                style={{ aspectRatio: 1, width: "100%" }}
              />
            ) : null}
          </View>
        ) : (
          <View className="flex-1" />
        )}

        {error ? (
          <View className="mt-4 rounded-[16px] bg-red-500/10 px-4 py-3">
            <Text className="text-sm leading-normal text-red-500">{error}</Text>
          </View>
        ) : null}

        <View className="mt-5 gap-3 pb-2">
          <Pressable
            accessibilityLabel={scannerVisible ? "QR-Code erneut scannen" : "QR-Code scannen"}
            accessibilityRole="button"
            className="min-h-[52px] items-center justify-center rounded-[16px] bg-primary px-5 active:opacity-80"
            disabled={pairing}
            onPress={() => void openScanner()}
          >
            <Text className="text-base font-t3-bold text-primary-foreground">
              {pairing ? "Workjet wird verbunden…" : "QR-Code scannen"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Pairing später durchführen und Code lokal verwenden"
            accessibilityRole="button"
            className="min-h-12 items-center justify-center rounded-[16px] px-5 active:bg-subtle-strong"
            disabled={pairing}
            onPress={props.onContinueWithoutPairing}
          >
            <Text className="text-sm font-t3-medium text-foreground-muted">
              Später – Code lokal verwenden
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
