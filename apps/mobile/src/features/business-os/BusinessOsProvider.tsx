import * as Linking from "expo-linking";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Alert } from "react-native";

import { isBusinessOsPairLink } from "../../lib/workjetLinks";
import { uuidv4 } from "../../lib/uuid";
import {
  commitBusinessOsPairing,
  prepareBusinessOsPairing,
  prepareValidatedBusinessOsPairing,
  type PreparedBusinessOsPairing,
} from "./pairing/import-flow";
import type { ValidatedBusinessOsInvite } from "./pairing/invite";
import {
  forgetBusinessOsInstance,
  type BusinessOsInstance,
  type BusinessOsRegistryDependencies,
} from "./registry/business-os-registry";
import {
  nativeBusinessOsRegistry,
  nativeBusinessOsSecretStore,
  nativeBusinessOsSelection,
} from "./registry/native-business-os-registry";
import { nativeBusinessOsProfileStore } from "./shell/native-business-os-surface";
import { nativeBusinessOsHomeStore } from "./launcher/native-business-os-home-store";

interface BusinessOsContextValue {
  readonly instances: readonly BusinessOsInstance[];
  readonly selected: BusinessOsInstance | null;
  readonly isReady: boolean;
  readonly select: (id: string) => Promise<void>;
  readonly importLink: (raw: string) => Promise<BusinessOsInstance | null>;
  readonly importInvite: (
    invite: ValidatedBusinessOsInvite,
    options?: { readonly confirm?: boolean },
  ) => Promise<BusinessOsInstance | null>;
  readonly forget: (instance: BusinessOsInstance) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

const BusinessOsContext = createContext<BusinessOsContextValue | null>(null);

const dependencies: BusinessOsRegistryDependencies = {
  registry: nativeBusinessOsRegistry,
  secrets: nativeBusinessOsSecretStore,
  profiles: nativeBusinessOsProfileStore,
  createOpaqueId: uuidv4,
};

function confirmPairing(input: ReturnType<typeof prepareBusinessOsPairing>): Promise<boolean> {
  const expiresAt = new Date(input.confirmation.expiresAt).toLocaleString();
  const host = input.confirmation.signalingHosts.join(", ");
  return new Promise((resolve) => {
    Alert.alert(
      "CTOX Backend verbinden?",
      `${input.confirmation.displayName}\nSignaling: ${host}\nGültig bis: ${expiresAt}`,
      [
        { text: "Abbrechen", style: "cancel", onPress: () => resolve(false) },
        { text: "Verbinden", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function BusinessOsProvider(props: { readonly children: ReactNode }) {
  const [instances, setInstances] = useState<readonly BusinessOsInstance[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  const refresh = useCallback(async () => {
    const [nextInstances, persistedSelection] = await Promise.all([
      nativeBusinessOsRegistry.list(),
      nativeBusinessOsSelection.load(),
    ]);
    setInstances(nextInstances);
    const validSelection = nextInstances.some((instance) => instance.id === persistedSelection)
      ? persistedSelection
      : (nextInstances[0]?.id ?? null);
    setSelectedId(validSelection);
    if (validSelection !== persistedSelection) await nativeBusinessOsSelection.save(validSelection);
    setIsReady(true);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setIsReady(true));
  }, [refresh]);

  const select = useCallback(async (id: string) => {
    setSelectedId(id);
    await nativeBusinessOsSelection.save(id);
  }, []);

  const commitPrepared = useCallback(
    async (prepared: PreparedBusinessOsPairing, shouldConfirm: boolean) => {
      if (shouldConfirm && !(await confirmPairing(prepared))) return null;
      const instance = await commitBusinessOsPairing(prepared, dependencies);
      await nativeBusinessOsSelection.save(instance.id);
      await refresh();
      return instance;
    },
    [refresh],
  );

  const importLink = useCallback(
    (raw: string) => commitPrepared(prepareBusinessOsPairing(raw), true),
    [commitPrepared],
  );

  const importInvite = useCallback(
    (invite: ValidatedBusinessOsInvite, options: { readonly confirm?: boolean } = {}) =>
      commitPrepared(prepareValidatedBusinessOsPairing(invite), options.confirm !== false),
    [commitPrepared],
  );

  const forget = useCallback(
    async (instance: BusinessOsInstance) => {
      await forgetBusinessOsInstance(instance, dependencies);
      await nativeBusinessOsHomeStore.remove(instance.id);
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url || !isBusinessOsPairLink(url)) return;
      void importLink(url).catch(() => {
        Alert.alert(
          "Pairing fehlgeschlagen",
          "Der QR-Code oder Link ist ungültig oder abgelaufen.",
        );
      });
    };
    void Linking.getInitialURL().then(handle);
    const subscription = Linking.addEventListener("url", ({ url }) => handle(url));
    return () => subscription.remove();
  }, [importLink]);

  const selected = instances.find((instance) => instance.id === selectedId) ?? null;
  const value = useMemo(
    () => ({ forget, importInvite, importLink, instances, isReady, refresh, select, selected }),
    [forget, importInvite, importLink, instances, isReady, refresh, select, selected],
  );
  return <BusinessOsContext.Provider value={value}>{props.children}</BusinessOsContext.Provider>;
}

export function useBusinessOs(): BusinessOsContextValue {
  const context = use(BusinessOsContext);
  if (!context) throw new Error("useBusinessOs must be used within BusinessOsProvider");
  return context;
}
