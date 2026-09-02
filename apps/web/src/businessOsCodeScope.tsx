import { useAtomValue } from "@effect/atom-react";
import type {
  BusinessOsInstanceId,
  DesktopCtoxBridge,
  EnvironmentId,
  WorkjetComputer,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { environmentCatalog } from "./connection/catalog";
import { crossModeSelectionMemory } from "./crossMode/crossModeSelectionMemory";
import { usePrimarySettings } from "./hooks/useSettings";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";

export type BusinessOsCodeScopeBlocker =
  | "no-active-instance"
  | "authority-unavailable"
  | "authority-rejected";

export type BusinessOsCodeScopeSnapshot =
  | {
      readonly phase: "resolving";
      readonly presentationInstanceId: string | null;
      readonly businessOsInstanceId: null;
      readonly environmentIds: ReadonlySet<EnvironmentId>;
      readonly blocker: null;
    }
  | {
      readonly phase: "blocked";
      readonly presentationInstanceId: string | null;
      readonly businessOsInstanceId: null;
      readonly environmentIds: ReadonlySet<EnvironmentId>;
      readonly blocker: BusinessOsCodeScopeBlocker;
    }
  | {
      readonly phase: "ready";
      readonly presentationInstanceId: string;
      readonly businessOsInstanceId: BusinessOsInstanceId;
      readonly environmentIds: ReadonlySet<EnvironmentId>;
      readonly blocker: null;
    };

const EMPTY_ENVIRONMENT_IDS: ReadonlySet<EnvironmentId> = new Set();

let currentSnapshot: BusinessOsCodeScopeSnapshot = {
  phase: "resolving",
  presentationInstanceId: null,
  businessOsInstanceId: null,
  environmentIds: EMPTY_ENVIRONMENT_IDS,
  blocker: null,
};
const listeners = new Set<() => void>();

function publishBusinessOsCodeScope(next: BusinessOsCodeScopeSnapshot): void {
  currentSnapshot = next;
  for (const listener of listeners) listener();
}

function subscribeBusinessOsCodeScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readBusinessOsCodeScope(): BusinessOsCodeScopeSnapshot {
  return currentSnapshot;
}

export function useBusinessOsCodeScope(): BusinessOsCodeScopeSnapshot {
  return useSyncExternalStore(
    subscribeBusinessOsCodeScope,
    readBusinessOsCodeScope,
    readBusinessOsCodeScope,
  );
}

export function businessOsCodeScopeContainsEnvironment(
  scope: BusinessOsCodeScopeSnapshot,
  environmentId: EnvironmentId,
): boolean {
  return scope.phase === "ready" && scope.environmentIds.has(environmentId);
}

type BusinessOsCodeScopeCatalogEntries = ReadonlyMap<
  EnvironmentId,
  {
    readonly target: {
      readonly _tag: string;
      readonly businessOsInstanceId?: BusinessOsInstanceId;
    };
  }
>;

export function projectBusinessOsEnvironmentIds(
  businessOsInstanceId: BusinessOsInstanceId,
  entries: BusinessOsCodeScopeCatalogEntries,
): ReadonlySet<EnvironmentId> {
  const environmentIds = new Set<EnvironmentId>();
  for (const [environmentId, entry] of entries) {
    if (
      entry.target._tag === "RelayConnectionTarget" &&
      entry.target.businessOsInstanceId === businessOsInstanceId
    ) {
      environmentIds.add(environmentId);
    }
  }
  return environmentIds;
}

export function resolveBusinessOsCodeScopeEnvironmentIds({
  businessOsInstanceId,
  entries,
  primaryEnvironmentId,
  computers,
}: {
  readonly businessOsInstanceId: BusinessOsInstanceId;
  readonly entries: BusinessOsCodeScopeCatalogEntries;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly computers: ReadonlyArray<Pick<WorkjetComputer, "environmentId" | "presentationKind">>;
}): ReadonlySet<EnvironmentId> {
  const environmentIds = new Set(projectBusinessOsEnvironmentIds(businessOsInstanceId, entries));
  if (
    primaryEnvironmentId !== null &&
    computers.some(
      (computer) =>
        computer.presentationKind === "local" && computer.environmentId === primaryEnvironmentId,
    )
  ) {
    environmentIds.add(primaryEnvironmentId);
  }
  return environmentIds;
}

function readActivePresentationInstanceId(): string | null {
  return crossModeSelectionMemory.readActiveCtoxInstanceId();
}

/**
 * Resolves the renderer presentation id through Desktop Main, then includes
 * Relay targets carrying the exact server-authoritative instance id. Primary is
 * included only when primary settings register a local computer for that exact
 * environment id, which proves membership in the active Business OS. Bearer,
 * SSH, non-local computer and unscoped Relay targets remain excluded.
 */
export function BusinessOsCodeScopeSynchronizer({
  bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.ctox,
}: {
  readonly bridge?: DesktopCtoxBridge;
}) {
  const presentationInstanceId = useSyncExternalStore(
    crossModeSelectionMemory.subscribeToActiveCtoxInstance,
    readActivePresentationInstanceId,
    readActivePresentationInstanceId,
  );
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const computers = usePrimarySettings((settings) => settings.workjet.computers);
  const [authority, setAuthority] = useState<
    | { readonly phase: "resolving"; readonly presentationInstanceId: string | null }
    | {
        readonly phase: "blocked";
        readonly presentationInstanceId: string;
        readonly blocker: Exclude<BusinessOsCodeScopeBlocker, "no-active-instance">;
      }
    | {
        readonly phase: "ready";
        readonly presentationInstanceId: string;
        readonly businessOsInstanceId: BusinessOsInstanceId;
      }
  >({ phase: "resolving", presentationInstanceId: null });

  useEffect(() => {
    let cancelled = false;
    if (presentationInstanceId === null) {
      setAuthority({ phase: "resolving", presentationInstanceId: null });
      return;
    }
    if (bridge?.resolveInstanceAuthority === undefined) {
      setAuthority({
        phase: "blocked",
        presentationInstanceId,
        blocker: "authority-unavailable",
      });
      return;
    }
    setAuthority({ phase: "resolving", presentationInstanceId });
    void bridge.resolveInstanceAuthority(presentationInstanceId).then(
      (result) => {
        if (cancelled) return;
        setAuthority(
          result._tag === "completed"
            ? {
                phase: "ready",
                presentationInstanceId,
                businessOsInstanceId: result.businessOsInstanceId,
              }
            : { phase: "blocked", presentationInstanceId, blocker: "authority-rejected" },
        );
      },
      () => {
        if (!cancelled) {
          setAuthority({
            phase: "blocked",
            presentationInstanceId,
            blocker: "authority-unavailable",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, presentationInstanceId]);

  const snapshot = useMemo<BusinessOsCodeScopeSnapshot>(() => {
    if (presentationInstanceId === null) {
      return {
        phase: "blocked",
        presentationInstanceId: null,
        businessOsInstanceId: null,
        environmentIds: EMPTY_ENVIRONMENT_IDS,
        blocker: "no-active-instance",
      };
    }
    if (
      authority.presentationInstanceId !== presentationInstanceId ||
      authority.phase === "resolving" ||
      !catalog.isReady
    ) {
      return {
        phase: "resolving",
        presentationInstanceId,
        businessOsInstanceId: null,
        environmentIds: EMPTY_ENVIRONMENT_IDS,
        blocker: null,
      };
    }
    if (authority.phase === "blocked") {
      return {
        phase: "blocked",
        presentationInstanceId,
        businessOsInstanceId: null,
        environmentIds: EMPTY_ENVIRONMENT_IDS,
        blocker: authority.blocker,
      };
    }
    return {
      phase: "ready",
      presentationInstanceId,
      businessOsInstanceId: authority.businessOsInstanceId,
      environmentIds: resolveBusinessOsCodeScopeEnvironmentIds({
        businessOsInstanceId: authority.businessOsInstanceId,
        entries: catalog.entries,
        primaryEnvironmentId,
        computers,
      }),
      blocker: null,
    };
  }, [authority, catalog, computers, presentationInstanceId, primaryEnvironmentId]);

  useEffect(() => {
    publishBusinessOsCodeScope(snapshot);
  }, [snapshot]);

  return null;
}
