import * as Linking from "expo-linking";
import { AsyncResult } from "effect/unstable/reactivity";
import { createContext, use, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Alert } from "react-native";
import { useAtomSet } from "@effect/atom-react";

import { useBusinessOs } from "../business-os/BusinessOsProvider";
import { useConnectionController } from "../connection/useConnectionController";
import { useWorkjetMode } from "../mode/WorkjetModeProvider";
import { isWorkjetDevicePairLink } from "../../lib/workjetLinks";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { parseWorkjetDevicePairLink } from "./workjet-device-invite";

interface WorkjetDevicePairingContextValue {
  readonly importPairingPayload: (payload: string) => Promise<boolean>;
}

const WorkjetDevicePairingContext = createContext<WorkjetDevicePairingContextValue | null>(null);

function confirmDevicePairing(input: ReturnType<typeof parseWorkjetDevicePairLink>) {
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      "Workjet verbinden?",
      `${input.confirmation.displayName}\nSignaling: ${input.confirmation.signalingHosts.join(
        ", ",
      )}\nGültig bis: ${new Date(input.confirmation.expiresAt).toLocaleString()}`,
      [
        { text: "Abbrechen", style: "cancel", onPress: () => resolve(false) },
        { text: "Code und Business OS verbinden", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function WorkjetDevicePairingProvider(props: { readonly children: ReactNode }) {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const { setMode } = useWorkjetMode();
  const { importInvite: importBusinessOsInvite } = useBusinessOs();
  const { connectPairingUrl: connectCodePairingUrl, removeEnvironment: removeCodeEnvironment } =
    useConnectionController();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const pairingInFlight = useRef(false);
  const pendingIncomingDevicePairingIds = useRef(new Set<string>());
  const completedIncomingDevicePairingIds = useRef(new Set<string>());
  const handledInvalidIncomingPairing = useRef(false);

  const importPairingPayload = useCallback(
    async (payload: string): Promise<boolean> => {
      if (pairingInFlight.current) return false;
      pairingInFlight.current = true;
      try {
        const prepared = parseWorkjetDevicePairLink(payload);
        if (!(await confirmDevicePairing(prepared))) return false;

        const codePairing = await connectCodePairingUrl(prepared.environment.pairingUrl);
        if (!AsyncResult.isSuccess(codePairing)) {
          throw new Error(
            "Workjet konnte die Code-Verbindung nicht einrichten. Erneuere den QR-Code in Workjet Desktop und versuche es erneut.",
          );
        }
        const environmentId = codePairing.value;
        const wasAlreadyPaired = Object.hasOwn(savedConnectionsById, environmentId);
        try {
          const businessOsInstance = await importBusinessOsInvite(prepared.businessOs, {
            confirm: false,
          });
          if (!businessOsInstance) throw new Error("Business OS pairing was cancelled.");
        } catch {
          if (!wasAlreadyPaired) {
            await removeCodeEnvironment(environmentId).catch(() => undefined);
          }
          throw new Error(
            "Workjet konnte Business OS nicht sicher einrichten. Es wurden keine QR-Zugangsdaten gespeichert. Erneuere den QR-Code und versuche es erneut.",
          );
        }

        savePreferences({ workjetPairingOnboardingDismissed: true });
        setMode("business_os");
        return true;
      } finally {
        pairingInFlight.current = false;
      }
    },
    [
      connectCodePairingUrl,
      importBusinessOsInvite,
      removeCodeEnvironment,
      savePreferences,
      savedConnectionsById,
      setMode,
    ],
  );

  useEffect(() => {
    const handleUrl = (url: string | null) => {
      if (!url || !isWorkjetDevicePairLink(url)) return;
      let devicePairingId: string;
      try {
        devicePairingId = parseWorkjetDevicePairLink(url).devicePairingId;
      } catch {
        if (handledInvalidIncomingPairing.current) return;
        handledInvalidIncomingPairing.current = true;
        Alert.alert("Pairing fehlgeschlagen", "Der Workjet-QR-Code ist ungültig oder abgelaufen.");
        return;
      }
      if (
        pendingIncomingDevicePairingIds.current.has(devicePairingId) ||
        completedIncomingDevicePairingIds.current.has(devicePairingId)
      ) {
        return;
      }
      pendingIncomingDevicePairingIds.current.add(devicePairingId);
      void importPairingPayload(url)
        .then((completed) => {
          if (completed) completedIncomingDevicePairingIds.current.add(devicePairingId);
        })
        .catch((cause) => {
          Alert.alert(
            "Pairing fehlgeschlagen",
            cause instanceof Error
              ? cause.message
              : "Der Workjet-QR-Code ist ungültig oder abgelaufen.",
          );
        })
        .finally(() => pendingIncomingDevicePairingIds.current.delete(devicePairingId));
    };
    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener("url", ({ url }) => handleUrl(url));
    return () => subscription.remove();
  }, [importPairingPayload]);

  const value = useMemo(() => ({ importPairingPayload }), [importPairingPayload]);
  return (
    <WorkjetDevicePairingContext.Provider value={value}>
      {props.children}
    </WorkjetDevicePairingContext.Provider>
  );
}

export function useWorkjetDevicePairing(): WorkjetDevicePairingContextValue {
  const context = use(WorkjetDevicePairingContext);
  if (!context) {
    throw new Error("useWorkjetDevicePairing must be used within WorkjetDevicePairingProvider");
  }
  return context;
}
