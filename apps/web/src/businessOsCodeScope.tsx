import { useAtomValue } from "@effect/atom-react";
import type {
  BusinessOsInstanceId,
  DesktopCtoxBridge,
  EnvironmentId,
  WorkjetComputer,
} from "@workjet/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { environmentCatalog } from "./connection/catalog";
import { useActiveWorkjetScope } from "./activeWorkjetScope";
import { usePrimarySettings } from "./hooks/useSettings";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";
import {
  workjetComputerMembership,
  type ComputerMembershipSnapshot,
} from "./workjetComputerMembership";

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
  confirmedComputerIds = new Set<string>(),
}: {
  readonly businessOsInstanceId: BusinessOsInstanceId;
  readonly entries: BusinessOsCodeScopeCatalogEntries;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly computers: ReadonlyArray<
    Pick<WorkjetComputer, "environmentId" | "presentationKind"> & { readonly id?: string }
  >;
  readonly confirmedComputerIds?: ReadonlySet<string>;
}): ReadonlySet<EnvironmentId> {
  const environmentIds = new Set(projectBusinessOsEnvironmentIds(businessOsInstanceId, entries));
  for (const computer of computers) {
    if (
      computer.id !== undefined &&
      confirmedComputerIds.has(computer.id) &&
      entries.has(computer.environmentId)
    ) {
      environmentIds.add(computer.environmentId);
    }
  }
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

/**
 * Resolves the renderer presentation id through Desktop Main, then includes
 * Relay targets carrying the exact server-authoritative instance id. Primary is
 * included only when primary settings register a local computer for that exact
 * environment id. Remote computers additionally require a confirmed assignment
 * from this exact instance; a connection or editable presentation is insufficient.
 */
export function BusinessOsCodeScopeSynchronizer({
  bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.ctox,
}: {
  readonly bridge?: DesktopCtoxBridge;
}) {
  const { selectedInstanceId: presentationInstanceId } = useActiveWorkjetScope();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const computers = usePrimarySettings((settings) => settings.workjet.computers);
  const membership: ComputerMembershipSnapshot = useSyncExternalStore(
    workjetComputerMembership.subscribe,
    workjetComputerMembership.getSnapshot,
    workjetComputerMembership.getSnapshot,
  );
  useEffect(() => {
    workjetComputerMembership.select(presentationInstanceId);
    if (presentationInstanceId === null) return;
    const refresh = () => {
      if (workjetComputerMembership.getSnapshot().pendingComputerId === null) {
        void workjetComputerMembership.refresh(presentationInstanceId, bridge);
      }
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
    };
  }, [bridge, presentationInstanceId]);
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
        confirmedComputerIds: new Set(
          membership.instanceId === presentationInstanceId && membership.phase !== "failed"
            ? membership.computers
                .filter((computer) => computer.status === "assigned")
                .map((computer) => computer.id)
            : [],
        ),
      }),
      blocker: null,
    };
  }, [authority, catalog, computers, membership, presentationInstanceId, primaryEnvironmentId]);

  useEffect(() => {
    publishBusinessOsCodeScope(snapshot);
  }, [snapshot]);

  return null;
}
