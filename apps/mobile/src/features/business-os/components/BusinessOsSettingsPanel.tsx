import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, AppState, Pressable, useWindowDimensions, View } from "react-native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { AppText as Text } from "../../../components/AppText";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { cn } from "../../../lib/cn";
import { ConnectionSheetButton } from "../../connection/ConnectionSheetButton";
import { businessOsMobileInviteEnvironment } from "../../../state/business-os-mobile-invite";
import { useSavedRemoteConnections } from "../../../state/use-remote-environment-registry";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useBusinessOs } from "../BusinessOsProvider";
import {
  unavailableBusinessOsMobileInviteControl,
  type BusinessOsMobileInviteControlPort,
  type CreatedBusinessOsMobileInvite,
} from "../invites/mobile-invite-control";
import {
  makeBusinessOsMobileInviteControl,
  resolveBusinessOsControlConnection,
} from "../invites/production-mobile-invite-control-core";
import { setBusinessOsContentProtected } from "../security/content-protection";
import { CredentialQrCode } from "./CredentialQrCode";

function safeMessage(error: unknown): string {
  return error instanceof Error && error.name === "BusinessOsInviteControlUnavailableError"
    ? "Diese Workjet-Version kann auf diesem Backend noch keinen QR-Code erzeugen."
    : "Die Aktion konnte nicht abgeschlossen werden. Bitte erneut versuchen.";
}

export function BusinessOsSettingsPanel(props: {
  readonly inviteControl?: BusinessOsMobileInviteControlPort;
}) {
  const { forget, importLink, instances, isReady, select, selected } = useBusinessOs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const createInviteCommand = useAtomCommand(businessOsMobileInviteEnvironment.create, {
    reportFailure: false,
  });
  const revokeInviteCommand = useAtomCommand(businessOsMobileInviteEnvironment.revoke, {
    reportFailure: false,
  });
  const productionControl = useMemo(() => {
    const connection = resolveBusinessOsControlConnection(
      selected,
      Object.values(savedConnectionsById),
    );
    if (!connection) return unavailableBusinessOsMobileInviteControl;
    return makeBusinessOsMobileInviteControl({
      async create(input) {
        const result = await createInviteCommand({
          environmentId: connection.environmentId,
          input,
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      },
      async revoke(input) {
        const result = await revokeInviteCommand({
          environmentId: connection.environmentId,
          input,
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      },
    });
  }, [createInviteCommand, revokeInviteCommand, savedConnectionsById, selected]);
  const inviteControl = props.inviteControl ?? productionControl;
  const { width } = useWindowDimensions();
  const tabletLayout = width >= 720;
  const [generatedInvite, setGeneratedInvite] = useState<CreatedBusinessOsMobileInvite | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [scannerLocked, setScannerLocked] = useState(false);
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
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      setGeneratedInvite(await inviteControl.create({ backend: selected, ttlSeconds: 300 }));
    } catch (cause) {
      setError(safeMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [inviteControl, selected]);

  const revokeInvite = useCallback(async () => {
    if (!selected || !generatedInvite) return;
    setBusy(true);
    setError(null);
    try {
      await inviteControl.revoke({ backend: selected, inviteId: generatedInvite.inviteId });
      setGeneratedInvite(null);
    } catch (cause) {
      setError(safeMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [generatedInvite, inviteControl, selected]);

  const renewInvite = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (generatedInvite) {
        await inviteControl.revoke({ backend: selected, inviteId: generatedInvite.inviteId });
      }
      setGeneratedInvite(await inviteControl.create({ backend: selected, ttlSeconds: 300 }));
    } catch (cause) {
      setGeneratedInvite(null);
      setError(safeMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [generatedInvite, inviteControl, selected]);

  const openScanner = useCallback(async () => {
    if (cameraPermission?.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }
    const permission = await requestCameraPermission();
    if (permission.granted) setShowScanner(true);
    else
      Alert.alert(
        "Kamerazugriff benötigt",
        "Erlaube den Kamerazugriff, um den QR-Code zu scannen.",
      );
  }, [cameraPermission?.granted, requestCameraPermission]);

  const importRawLink = useCallback(
    async (raw: string) => {
      setError(null);
      try {
        const result = await importLink(raw);
        if (result) setShowScanner(false);
        return result !== null;
      } catch {
        setError("Der QR-Code oder Link ist ungültig oder abgelaufen.");
        return false;
      }
    },
    [importLink],
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
    Alert.alert(
      "Instanz vergessen?",
      `${selected.displayName} und die gerätegebundenen Zugangsdaten werden von diesem Gerät entfernt.`,
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Vergessen",
          style: "destructive",
          onPress: () =>
            void forget(selected).catch(() =>
              setError("Die Instanz konnte nicht entfernt werden."),
            ),
        },
      ],
    );
  }, [forget, selected]);

  if (!isReady) {
    return (
      <Text className="py-10 text-center text-foreground-muted">Backends werden geladen…</Text>
    );
  }

  return (
    <View className="w-full max-w-[920px] self-center gap-5">
      {error ? <ErrorBanner message={error} /> : null}

      {showScanner ? (
        <View className="gap-3 rounded-[24px] bg-card p-4">
          <View className="overflow-hidden rounded-[18px]">
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={scan}
              style={{ alignSelf: "center", aspectRatio: 1, maxWidth: 520, width: "100%" }}
            />
          </View>
          <ConnectionSheetButton
            icon="xmark"
            label="Scanner schließen"
            onPress={() => setShowScanner(false)}
          />
        </View>
      ) : (
        <View className={cn("gap-5", tabletLayout && "flex-row items-start")}>
          <View className="min-w-0 flex-1 gap-4 rounded-[24px] bg-card p-5">
            <View className="gap-1">
              <Text className="text-lg font-t3-bold text-foreground">CTOX Backends</Text>
              <Text className="text-sm leading-normal text-foreground-muted">
                Business OS verbindet sich direkt per RxDB und WebRTC. Code bleibt ohne Backend
                nutzbar.
              </Text>
            </View>

            {instances.length === 0 ? (
              <View className="rounded-[18px] bg-subtle p-4">
                <Text className="text-sm leading-normal text-foreground-muted">
                  Noch kein Backend verbunden. Scanne einen kurzlebigen Workjet QR-Code oder füge
                  ihn explizit ein.
                </Text>
              </View>
            ) : (
              <View className="gap-2">
                {instances.map((instance) => {
                  const active = instance.id === selected?.id;
                  return (
                    <Pressable
                      key={instance.id}
                      accessibilityLabel={`${instance.displayName}${active ? ", ausgewählt" : ""}`}
                      accessibilityRole="button"
                      onPress={() => void select(instance.id)}
                      className={cn(
                        "min-h-14 justify-center rounded-[16px] border px-4 py-3",
                        active ? "border-primary bg-subtle" : "border-border bg-secondary",
                      )}
                    >
                      <Text className="font-t3-bold text-foreground">{instance.displayName}</Text>
                      <Text className="mt-0.5 text-xs text-foreground-muted" numberOfLines={1}>
                        {new URL(instance.signalingUrls[0]!).host}
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
            <View className="gap-1">
              <Text className="text-lg font-t3-bold text-foreground">Pairing weitergeben</Text>
              <Text className="text-sm leading-normal text-foreground-muted">
                Der QR-Code ist ein kurzlebiger Zugangsnachweis. Zeige ihn nur der Zielperson.
              </Text>
            </View>

            {generatedInvite ? (
              <>
                <CredentialQrCode value={generatedInvite.link} size={tabletLayout ? 240 : 264} />
                <View className="items-center gap-1">
                  <Text className="font-t3-bold text-foreground">{selected?.displayName}</Text>
                  <Text className="text-sm text-foreground-muted">
                    Gültig bis {new Date(generatedInvite.expiresAt).toLocaleTimeString()}
                  </Text>
                </View>
                <View className="gap-3">
                  <ConnectionSheetButton
                    icon="arrow.clockwise"
                    label="Erneuern"
                    disabled={busy}
                    onPress={() => void renewInvite()}
                  />
                  <ConnectionSheetButton
                    icon="xmark"
                    label="Widerrufen"
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
                disabled={busy || !selected}
                onPress={() => void createInvite()}
              />
            )}

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
