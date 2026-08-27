import * as Linking from "expo-linking";
import { AsyncResult } from "effect/unstable/reactivity";
import { redeemWorkjetDeviceInviteReference as redeemWorkjetDeviceInviteReferenceEffect } from "@t3tools/client-runtime/state/business-os-mobile-invite";
import { createContext, use, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Alert } from "react-native";
import { useAtomSet } from "@effect/atom-react";

import { useBusinessOs } from "../business-os/BusinessOsProvider";
import { useConnectionController } from "../connection/useConnectionController";
import { useWorkjetMode } from "../mode/WorkjetModeProvider";
import { isWorkjetDevicePairLink } from "../../lib/workjetLinks";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { runtime } from "../../lib/runtime";
import { loadOrCreateDpopProofKeyPair } from "../cloud/dpop";
import {
  parseWorkjetDevicePairingLink,
  toWorkjetDeviceInviteReferenceContract,
  type ParsedWorkjetDevicePairingLink,
  validateRedeemedWorkjetDeviceInvite,
} from "./workjet-device-invite";

interface WorkjetDevicePairingContextValue {
  readonly importPairingPayload: (payload: string) => Promise<boolean>;
}

const WorkjetDevicePairingContext = createContext<WorkjetDevicePairingContextValue | null>(null);

function confirmDevicePairing(input: ParsedWorkjetDevicePairingLink) {
  const description =
    input.kind === "reference"
      ? `Server: ${new URL(input.reference.endpoint).host}\nGültig bis: ${new Date(
          input.reference.expiresAt,
        ).toLocaleString()}\n\nDer Einmal-Code gibt genau eine Business-OS-Instanz frei.`
      : `${input.invite.confirmation.displayName}\nSignaling: ${input.invite.confirmation.signalingHosts.join(
          ", ",
        )}\nGültig bis: ${new Date(input.invite.confirmation.expiresAt).toLocaleString()}`;
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      "Workjet verbinden?",
      description,
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
  const {
    bindEnvironment,
    forget: forgetBusinessOsInstance,
    importInvite: importBusinessOsInvite,
    instances: businessOsInstances,
  } = useBusinessOs();
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
        const candidate = parseWorkjetDevicePairingLink(payload);
        if (!(await confirmDevicePairing(candidate))) return false;
        const prepared =
          candidate.kind === "reference"
            ? await Promise.all([
                loadOrCreateAgentAwarenessDeviceId(),
                runtime.runPromise(loadOrCreateDpopProofKeyPair()),
              ]).then(async ([deviceId, proofKey]) =>
                validateRedeemedWorkjetDeviceInvite(
                  await runtime.runPromise(
                    redeemWorkjetDeviceInviteReferenceEffect({
                      reference: toWorkjetDeviceInviteReferenceContract(candidate.reference),
                      deviceId,
                      proofKeyThumbprint: proofKey.thumbprint,
                    }),
                  ),
                ),
              )
            : candidate.invite;

        const codePairing = await connectCodePairingUrl(prepared.environment.pairingUrl);
        if (!AsyncResult.isSuccess(codePairing)) {
          throw new Error(
            "Workjet konnte die Code-Verbindung nicht einrichten. Erneuere den QR-Code in Workjet Desktop und versuche es erneut.",
          );
        }
        const environmentId = codePairing.value;
        const wasAlreadyPaired = Object.hasOwn(savedConnectionsById, environmentId);
        const businessOsWasAlreadyPaired = businessOsInstances.some(
          (instance) => instance.instanceId === prepared.businessOs.instanceId,
        );
        try {
          const businessOsInstance = await importBusinessOsInvite(prepared.businessOs, {
            confirm: false,
          });
          if (!businessOsInstance) throw new Error("Business OS pairing was cancelled.");
          try {
            await bindEnvironment(businessOsInstance.id, environmentId);
          } catch {
            if (!businessOsWasAlreadyPaired) {
              await forgetBusinessOsInstance(businessOsInstance).catch(() => undefined);
            }
            throw new Error("Workjet instance binding could not be stored.");
          }
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
      bindEnvironment,
      businessOsInstances,
      connectCodePairingUrl,
      forgetBusinessOsInstance,
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
      let pairingAttemptId: string;
      try {
        pairingAttemptId = parseWorkjetDevicePairingLink(url).attemptId;
      } catch {
        if (handledInvalidIncomingPairing.current) return;
        handledInvalidIncomingPairing.current = true;
        Alert.alert("Pairing fehlgeschlagen", "Der Workjet-QR-Code ist ungültig oder abgelaufen.");
        return;
      }
      if (
        pendingIncomingDevicePairingIds.current.has(pairingAttemptId) ||
        completedIncomingDevicePairingIds.current.has(pairingAttemptId)
      ) {
        return;
      }
      pendingIncomingDevicePairingIds.current.add(pairingAttemptId);
      void importPairingPayload(url)
        .then((completed) => {
          if (completed) completedIncomingDevicePairingIds.current.add(pairingAttemptId);
        })
        .catch((cause) => {
          Alert.alert(
            "Pairing fehlgeschlagen",
            cause instanceof Error
              ? cause.message
              : "Der Workjet-QR-Code ist ungültig oder abgelaufen.",
          );
        })
        .finally(() => pendingIncomingDevicePairingIds.current.delete(pairingAttemptId));
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
