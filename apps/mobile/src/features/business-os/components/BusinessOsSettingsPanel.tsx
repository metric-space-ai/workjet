import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Pressable, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { cn } from "../../../lib/cn";
import { ConnectionSheetButton } from "../../connection/ConnectionSheetButton";
import { useWorkjetDevicePairing } from "../../pairing/WorkjetDevicePairingProvider";
import { pairingScannerSize } from "../../pairing/pairing-scanner-layout";
import { useManagedWorkjetDeviceInviteControl } from "../../pairing/useManagedWorkjetDeviceInviteControl";
import {
  unavailableWorkjetDeviceInviteControl,
  type CreatedWorkjetDeviceInvite,
  type WorkjetDeviceInviteControlPort,
} from "../../pairing/workjet-device-invite-control";
import { useBusinessOs } from "../BusinessOsProvider";
import { setBusinessOsContentProtected } from "../security/content-protection";
import { CredentialQrCode } from "./CredentialQrCode";
import { userFacingErrorText } from "../../../lib/userFacingError";

function safeMessage(error: unknown): string {
  return userFacingErrorText(error, "BusinessOsSettingsPanel");
}

export function BusinessOsSettingsPanel(props: {
  readonly inviteControl?: WorkjetDeviceInviteControlPort;
}) {
  const { forget, instances, isReady, select, selected } = useBusinessOs();
  const { importPairingPayload } = useWorkjetDevicePairing();
  const productionInviteControl = useManagedWorkjetDeviceInviteControl(
    selected?.instanceId ?? null,
  );
  const inviteControl =
    props.inviteControl ?? productionInviteControl ?? unavailableWorkjetDeviceInviteControl;
  const hasVerifiedBackendControl =
    props.inviteControl !== undefined || productionInviteControl !== undefined;
  const { height, width } = useWindowDimensions();
  const tabletLayout = width >= 720;
  const scannerSize = pairingScannerSize({ height, width });
  const [generatedInvite, setGeneratedInvite] = useState<CreatedWorkjetDeviceInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [scannerLocked, setScannerLocked] = useState(false);
  const [scannerReady, setScannerReady] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  useEffect(() => {
    const protectedContentVisible = generatedInvite !== null || showScanner;
    setBusinessOsContentProtected(protectedContentVisible);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") setGeneratedInvite(null);
    });
    return () => {
      subscription.remove();
      setBusinessOsContentProtected(false);
    };
  }, [generatedInvite, showScanner]);

  useEffect(() => {
    setGeneratedInvite(null);
  }, [selected?.id]);

  useEffect(() => {
    if (!generatedInvite) return;
    const remaining = Date.parse(generatedInvite.expiresAt) - Date.now();
    if (remaining <= 0) {
      setGeneratedInvite(null);
      return;
    }
    const timer = setTimeout(() => setGeneratedInvite(null), remaining);
    return () => clearTimeout(timer);
  }, [generatedInvite]);

  const createInvite = useCallback(async () => {
    if (!selected || !hasVerifiedBackendControl) return;
    setBusy(true);
    setError(null);
    try {
      setGeneratedInvite(
        await inviteControl.create({
          businessOsInstanceId: selected.instanceId,
          displayName: selected.displayName,
          ttlSeconds: 300,
        }),
      );
    } catch (cause) {
      setError(safeMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [hasVerifiedBackendControl, inviteControl, selected]);

  const revokeInvite = useCallback(async () => {
    if (!generatedInvite) return;
    setBusy(true);
    setError(null);
    try {
      await inviteControl.revoke({ inviteId: generatedInvite.inviteId });
      setGeneratedInvite(null);
    } catch (cause) {
      setError(safeMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [generatedInvite, inviteControl]);

  const renewInvite = useCallback(async () => {
    if (!selected || !hasVerifiedBackendControl) return;
    setBusy(true);
    setError(null);
    try {
      if (generatedInvite) {
        await inviteControl.revoke({ inviteId: generatedInvite.inviteId });
      }
      setGeneratedInvite(
        await inviteControl.create({
          businessOsInstanceId: selected.instanceId,
          displayName: selected.displayName,
          ttlSeconds: 300,
        }),
      );
    } catch (cause) {
      setGeneratedInvite(null);
      setError(safeMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [generatedInvite, hasVerifiedBackendControl, inviteControl, selected]);

  const openScanner = useCallback(async () => {
    if (cameraPermission?.granted) {
      setScannerLocked(false);
      setScannerReady(false);
      setShowScanner(true);
      return;
    }
    const permission = await requestCameraPermission();
    if (permission.granted) {
      setScannerReady(false);
      setShowScanner(true);
    } else Alert.alert("Kamerazugriff fehlt", "In den Systemeinstellungen erlauben.");
  }, [cameraPermission?.granted, requestCameraPermission]);

  const importRawLink = useCallback(
    async (raw: string) => {
      setError(null);
      try {
        const result = await importPairingPayload(raw);
        if (result) setShowScanner(false);
        return result;
      } catch {
        setError("QR-Code ungültig oder abgelaufen.");
        return false;
      }
    },
    [importPairingPayload],
  );

  const scan = useCallback(
    ({ data }: { readonly data: string }) => {
      if (scannerLocked) return;
      setScannerLocked(true);
      void importRawLink(data).finally(() => {
        setTimeout(() => setScannerLocked(false), 600);
      });
    },
    [importRawLink, scannerLocked],
  );

  const paste = useCallback(async () => {
    const raw = await Clipboard.getStringAsync();
    if (await importRawLink(raw)) await Clipboard.setStringAsync("");
  }, [importRawLink]);

  const confirmForget = useCallback(() => {
    if (!selected) return;
    Alert.alert("Instanz vergessen?", selected.displayName, [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Vergessen",
        style: "destructive",
        onPress: () => void forget(selected).catch(() => setError("Instanz nicht entfernt.")),
      },
    ]);
  }, [forget, selected]);

  if (!isReady) {
    return <Text className="py-10 text-center text-foreground-muted">Lädt Instanzen…</Text>;
  }

  return (
    <View className="w-full max-w-[920px] self-center gap-5">
      {error ? <ErrorBanner message={error} /> : null}

      {showScanner ? (
        <View className="items-center gap-3 rounded-[24px] bg-card p-4">
          <View
            className="overflow-hidden rounded-[18px] bg-black"
            style={{ height: scannerSize, width: scannerSize }}
          >
            <CameraView
              autofocus="on"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              facing="back"
              onBarcodeScanned={scannerLocked ? undefined : scan}
              onCameraReady={() => setScannerReady(true)}
              onMountError={() => setError("Kamera startet nicht.")}
              style={{ height: scannerSize, width: scannerSize }}
            />
            <View
              pointerEvents="none"
              className="absolute inset-[15%] rounded-[20px] border-2 border-white/90"
            />
          </View>
          <Text className="text-center text-sm text-foreground-muted">
            {scannerLocked
              ? "Prüft QR-Code…"
              : scannerReady
                ? "QR-Code in den Rahmen halten"
                : "Kamera startet…"}
          </Text>
          <ConnectionSheetButton
            icon="xmark"
            label="Scanner schließen"
            onPress={() => {
              setShowScanner(false);
              setScannerReady(false);
            }}
          />
        </View>
      ) : (
        <View className={cn("gap-5", tabletLayout && "flex-row items-start")}>
          <View className="min-w-0 flex-1 gap-4 rounded-[24px] bg-card p-5">
            <Text className="text-lg font-workjet-bold text-foreground">Instanzen</Text>

            {instances.length === 0 ? (
              <Text className="text-sm text-foreground-muted">Noch keine Instanz</Text>
            ) : (
              <View className="gap-2">
                {instances.map((instance) => {
                  const active = instance.id === selected?.id;
                  return (
                    <Pressable
                      key={instance.id}
                      accessibilityLabel={`${instance.displayName}${active ? ", ausgewählt" : ""}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => void select(instance.id)}
                      className={cn(
                        "min-h-14 justify-center rounded-[16px] border px-4 py-3",
                        active ? "border-primary bg-subtle" : "border-border bg-secondary",
                      )}
                    >
                      <Text className="font-workjet-bold text-foreground">
                        {instance.displayName}
                      </Text>
                      <Text className="mt-0.5 text-xs text-foreground-muted" numberOfLines={1}>
                        {active ? "Aktiv" : "Bereit"}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            <View className={cn("gap-3", tabletLayout && "flex-row")}>
              <View className="flex-1">
                <ConnectionSheetButton
                  icon="qrcode.viewfinder"
                  label="QR-Code scannen"
                  onPress={() => void openScanner()}
                />
              </View>
              <View className="flex-1">
                <ConnectionSheetButton
                  icon="doc.on.clipboard"
                  label="Link einfügen"
                  onPress={() => void paste()}
                />
              </View>
            </View>
          </View>

          <View className="min-w-0 flex-1 gap-4 rounded-[24px] bg-card p-5">
            <Text className="text-lg font-workjet-bold text-foreground">Gerät hinzufügen</Text>

            {generatedInvite ? (
              <>
                <CredentialQrCode value={generatedInvite.link} size={tabletLayout ? 240 : 264} />
                <View className="items-center gap-1">
                  <Text className="font-workjet-bold text-foreground">
                    {generatedInvite.displayName}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    Gültig bis {new Date(generatedInvite.expiresAt).toLocaleTimeString()}
                  </Text>
                </View>
                <View className="gap-3">
                  <ConnectionSheetButton
                    icon="arrow.clockwise"
                    label="Neuen QR-Code erstellen"
                    disabled={busy}
                    onPress={() => void renewInvite()}
                  />
                  <ConnectionSheetButton
                    icon="xmark"
                    label="QR-Code widerrufen"
                    tone="danger"
                    disabled={busy}
                    onPress={() => void revokeInvite()}
                  />
                </View>
              </>
            ) : (
              <ConnectionSheetButton
                icon="qrcode"
                label="QR-Code anzeigen"
                tone="primary"
                disabled={busy || !selected || !hasVerifiedBackendControl}
                onPress={() => void createInvite()}
              />
            )}

            {selected && !hasVerifiedBackendControl ? (
              <Text className="text-sm text-foreground-muted">Instanz noch nicht bereit</Text>
            ) : null}

            {selected ? (
              <ConnectionSheetButton
                icon="trash"
                label="Instanz vergessen"
                tone="danger"
                onPress={confirmForget}
              />
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
}
