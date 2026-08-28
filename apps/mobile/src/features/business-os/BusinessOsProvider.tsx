import * as Linking from "expo-linking";
import { BusinessOsInstanceId, type EnvironmentId } from "@t3tools/contracts";
import type { WorkjetManagedDeviceSessionAuthorization } from "@t3tools/client-runtime/state/business-os-managed-backend-control";
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
  buildMobileBusinessOsPlatformRegistrations,
  publishMobileBusinessOsPlatformRegistrations,
} from "../../connection/business-os-platform-connections";
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
  nativeBusinessOsEnvironmentBindings,
  commitNativeManagedWorkjetPairing,
  nativeBusinessOsRegistry,
  nativeBusinessOsSecretStore,
  nativeBusinessOsSelection,
  nativeWorkjetDeviceSessionStore,
} from "./registry/native-business-os-registry";
import type { BusinessOsEnvironmentBinding } from "./registry/business-os-environment-binding";
import { nativeBusinessOsProfileStore } from "./shell/native-business-os-surface";
import { nativeBusinessOsHomeStore } from "./launcher/native-business-os-home-store";
import {
  loadWorkjetDeviceSession,
  removeWorkjetDeviceSession,
} from "../pairing/workjet-device-session-store";

interface BusinessOsContextValue {
  readonly instances: readonly BusinessOsInstance[];
  readonly selected: BusinessOsInstance | null;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedEnvironmentIds: readonly EnvironmentId[];
  readonly environmentBindings: readonly BusinessOsEnvironmentBinding[];
  readonly hasEnvironmentBindings: boolean;
  readonly isReady: boolean;
  readonly select: (id: string) => Promise<void>;
  readonly selectEnvironment: (environmentId: EnvironmentId) => Promise<void>;
  readonly bindEnvironment: (
    businessOsInstanceId: string,
    environmentId: EnvironmentId,
  ) => Promise<void>;
  readonly replaceEnvironmentMemberships: (
    businessOsInstanceId: string,
    environmentIds: readonly EnvironmentId[],
  ) => Promise<void>;
  readonly importLink: (raw: string) => Promise<BusinessOsInstance | null>;
  readonly importInvite: (
    invite: ValidatedBusinessOsInvite,
    options?: { readonly confirm?: boolean },
  ) => Promise<BusinessOsInstance | null>;
  readonly importManagedInvite: (
    invite: ValidatedBusinessOsInvite,
    authorization: WorkjetManagedDeviceSessionAuthorization,
    environmentIds: readonly EnvironmentId[],
  ) => Promise<BusinessOsInstance>;
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
      "Business OS verbinden?",
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
  const [environmentBindings, setEnvironmentBindings] = useState<
    readonly BusinessOsEnvironmentBinding[]
  >([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  const refresh = useCallback(async () => {
    const [nextInstances, nextBindings, persistedSelection] = await Promise.all([
      nativeBusinessOsRegistry.list(),
      nativeBusinessOsEnvironmentBindings.list(),
      nativeBusinessOsSelection.load(),
    ]);
    const validBindings = nextBindings.filter((binding) =>
      nextInstances.some((instance) => instance.id === binding.businessOsInstanceId),
    );
    const deviceSessionAuthorityIds = new Set(
      (
        await Promise.all(
          nextInstances.map(async (instance) => {
            const authorization = await loadWorkjetDeviceSession(
              BusinessOsInstanceId.make(instance.instanceId),
              nativeWorkjetDeviceSessionStore,
            ).catch(() => null);
            return authorization?.businessOsInstanceId ?? null;
          }),
        )
      ).filter((instanceId): instanceId is BusinessOsInstanceId => instanceId !== null),
    );
    publishMobileBusinessOsPlatformRegistrations(
      buildMobileBusinessOsPlatformRegistrations({
        instances: nextInstances.map((instance) => ({
          localId: instance.id,
          authorityId: instance.instanceId,
          label: instance.displayName,
        })),
        bindings: validBindings,
        deviceSessionAuthorityIds,
      }),
    );
    setInstances(nextInstances);
    setEnvironmentBindings(validBindings);
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

  const select = useCallback(
    async (id: string) => {
      if (!instances.some((instance) => instance.id === id)) {
        throw new Error("Die ausgewählte Business OS ist auf diesem Gerät nicht eingerichtet.");
      }
      setSelectedId(id);
      await nativeBusinessOsSelection.save(id);
    },
    [instances],
  );

  const selectEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      const candidate = environmentBindings.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!candidate) {
        throw new Error("Dieser Computer ist keiner Business OS zugeordnet.");
      }
      if (candidate.businessOsInstanceId === selectedId) return;
      await select(candidate.businessOsInstanceId);
    },
    [environmentBindings, select, selectedId],
  );

  const bindEnvironment = useCallback(
    async (businessOsInstanceId: string, environmentId: EnvironmentId) => {
      await nativeBusinessOsEnvironmentBindings.save({
        businessOsInstanceId,
        environmentId,
      });
      await nativeBusinessOsSelection.save(businessOsInstanceId);
      await refresh();
    },
    [refresh],
  );

  const replaceEnvironmentMemberships = useCallback(
    async (businessOsInstanceId: string, environmentIds: readonly EnvironmentId[]) => {
      await nativeBusinessOsEnvironmentBindings.replaceForBusinessOsInstance(
        businessOsInstanceId,
        environmentIds,
      );
      await nativeBusinessOsSelection.save(businessOsInstanceId);
      await refresh();
    },
    [refresh],
  );

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

  const importManagedInvite = useCallback(
    async (
      invite: ValidatedBusinessOsInvite,
      authorization: WorkjetManagedDeviceSessionAuthorization,
      environmentIds: readonly EnvironmentId[],
    ) => {
      const instance = await commitNativeManagedWorkjetPairing({
        invite,
        authorization,
        environmentIds,
      });
      await refresh();
      return instance;
    },
    [refresh],
  );

  const forget = useCallback(
    async (instance: BusinessOsInstance) => {
      await forgetBusinessOsInstance(instance, dependencies);
      await removeWorkjetDeviceSession(
        BusinessOsInstanceId.make(instance.instanceId),
        nativeWorkjetDeviceSessionStore,
      );
      await nativeBusinessOsEnvironmentBindings.removeByBusinessOsInstanceId(instance.id);
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
  const selectedEnvironmentIds = environmentBindings
    .filter((binding) => binding.businessOsInstanceId === selected?.id)
    .map((binding) => binding.environmentId);
  const selectedEnvironmentId = selectedEnvironmentIds[0] ?? null;
  const value = useMemo(
    () => ({
      bindEnvironment,
      environmentBindings,
      forget,
      hasEnvironmentBindings: environmentBindings.length > 0,
      importInvite,
      importManagedInvite,
      importLink,
      instances,
      isReady,
      refresh,
      replaceEnvironmentMemberships,
      select,
      selectEnvironment,
      selected,
      selectedEnvironmentId,
      selectedEnvironmentIds,
    }),
    [
      bindEnvironment,
      environmentBindings,
      forget,
      importInvite,
      importManagedInvite,
      importLink,
      instances,
      isReady,
      refresh,
      replaceEnvironmentMemberships,
      select,
      selectEnvironment,
      selected,
      selectedEnvironmentId,
      selectedEnvironmentIds,
    ],
  );
  return <BusinessOsContext.Provider value={value}>{props.children}</BusinessOsContext.Provider>;
}

export function useBusinessOs(): BusinessOsContextValue {
  const context = use(BusinessOsContext);
  if (!context) throw new Error("useBusinessOs must be used within BusinessOsProvider");
  return context;
}
