import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { pairingScannerSize } from "./pairing-scanner-layout";

type Entry = "none" | "scanner" | "code";

const PAIRING_FAILED = "Pairing fehlgeschlagen. Neuen QR-Code erstellen.";

export function WorkjetPairingOnboarding(props: {
  readonly onContinueWithoutPairing: () => void;
  readonly onPairingPayload: (payload: string) => Promise<boolean>;
}) {
  const foreground = useThemeColor("--color-foreground");
  const { height, width } = useWindowDimensions();
  const scannerSize = pairingScannerSize({ height, width });
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [entry, setEntry] = useState<Entry>("none");
  const [scannerLocked, setScannerLocked] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    (payload: string) => {
      if (pairing) return;
      setPairing(true);
      setError(null);
      void props
        .onPairingPayload(payload)
        .catch((cause: unknown) =>
          setError(
            cause instanceof Error && /[äöüß]|QR|Instanz|Pairing/u.test(cause.message)
              ? cause.message
              : PAIRING_FAILED,
          ),
        )
        .finally(() => {
          setPairing(false);
          setTimeout(() => setScannerLocked(false), 600);
        });
    },
    [pairing, props.onPairingPayload],
  );

  const openScanner = useCallback(async () => {
    setError(null);
    if (cameraPermission?.granted) {
      setEntry("scanner");
      return;
    }
    const permission = await requestCameraPermission();
    if (permission.granted) {
      setEntry("scanner");
    } else {
      setError("Kamerazugriff fehlt. In den Systemeinstellungen erlauben.");
    }
  }, [cameraPermission?.granted, requestCameraPermission]);

  const scan = useCallback(
    ({ data }: { readonly data: string }) => {
      if (scannerLocked || pairing) return;
      setScannerLocked(true);
      submit(data);
    },
    [pairing, scannerLocked, submit],
  );

  const trimmedCode = code.trim();

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16, paddingVertical: 20 }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View className="w-full max-w-[560px] flex-1 self-center">
        <View className="flex-row items-center gap-3">
          <View className="size-10 items-center justify-center rounded-[12px] bg-subtle-strong">
            <SymbolView
              name="qrcode.viewfinder"
              size={20}
              tintColor={foreground}
              type="monochrome"
            />
          </View>
          <Text className="min-w-0 flex-1 text-2xl font-workjet-bold">Workjet verbinden</Text>
          <Pressable
            accessibilityLabel="Später"
            accessibilityRole="button"
            className="min-h-10 justify-center rounded-[11px] px-3 active:bg-subtle-strong"
            disabled={pairing}
            onPress={props.onContinueWithoutPairing}
          >
            <Text className="text-sm font-workjet-medium text-foreground-muted">Später</Text>
          </Pressable>
        </View>
        <Text className="mt-2 text-sm text-foreground-muted" numberOfLines={1}>
          QR-Code: Einstellungen › Instanz › Gerät hinzufügen
        </Text>

        {entry === "scanner" && cameraPermission?.granted ? (
          <View className="mt-5 items-center">
            <View
              className="overflow-hidden rounded-[22px] border border-border bg-black"
              style={{ height: scannerSize, width: scannerSize }}
            >
              <CameraView
                autofocus="on"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                facing="back"
                onBarcodeScanned={scannerLocked ? undefined : scan}
                onMountError={() => setError("Kamera startet nicht. Code eingeben.")}
                style={{ height: scannerSize, width: scannerSize }}
              />
              <View
                pointerEvents="none"
                className="absolute inset-[15%] rounded-[20px] border-2 border-white/90"
              />
            </View>
          </View>
        ) : null}

        {entry === "code" ? (
          <TextInput
            accessibilityLabel="Pairing-Code"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            className="mt-5"
            editable={!pairing}
            onChangeText={setCode}
            onSubmitEditing={() => {
              if (trimmedCode) submit(trimmedCode);
            }}
            placeholder="Pairing-Link oder Code"
            returnKeyType="go"
            value={code}
          />
        ) : null}

        {error ? <Text className="mt-3 text-sm text-red-500">{error}</Text> : null}

        <View className="flex-1" />

        <View className="mt-5 gap-2.5 pb-2">
          {entry === "code" ? (
            <PrimaryButton
              disabled={pairing || trimmedCode.length === 0}
              label={pairing ? "Verbindet…" : "Verbinden"}
              onPress={() => submit(trimmedCode)}
            />
          ) : (
            <PrimaryButton
              disabled={pairing}
              label={pairing ? "Verbindet…" : "QR-Code scannen"}
              onPress={() => void openScanner()}
            />
          )}
          {entry === "code" ? (
            <SecondaryButton
              disabled={pairing}
              label="QR-Code scannen"
              onPress={() => void openScanner()}
            />
          ) : (
            <SecondaryButton
              disabled={pairing}
              label="Code eingeben"
              onPress={() => {
                setError(null);
                setEntry("code");
              }}
            />
          )}
        </View>
      </View>
    </ScrollView>
  );
}

function PrimaryButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className={
        props.disabled
          ? "min-h-12 items-center justify-center rounded-[14px] bg-primary px-5 opacity-50"
          : "min-h-12 items-center justify-center rounded-[14px] bg-primary px-5 active:opacity-80"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text className="text-base font-workjet-bold text-primary-foreground">{props.label}</Text>
    </Pressable>
  );
}

function SecondaryButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="min-h-12 items-center justify-center rounded-[14px] border border-secondary-border bg-secondary px-5 active:opacity-80"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text className="text-base font-workjet-bold text-secondary-foreground">{props.label}</Text>
    </Pressable>
  );
}
