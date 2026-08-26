import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";

import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useArchivedThreadListActions } from "../home/useThreadListActions";
import {
  ArchivedThreadsScreen,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsScreen";
import { buildArchivedThreadGroups, type ArchivedThreadSortOrder } from "./archivedThreadList";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "./useArchivedThreadSnapshots";
import { useBusinessOs } from "../business-os/BusinessOsProvider";

export function ArchivedThreadsRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const {
    environmentBindings,
    hasEnvironmentBindings,
    selectedEnvironmentId: activeBusinessOsEnvironmentId,
    selectEnvironment,
  } = useBusinessOs();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEnvironmentIdOverride, setSelectedEnvironmentIdOverride] =
    useState<EnvironmentId | null>(null);
  const selectedEnvironmentId = hasEnvironmentBindings
    ? activeBusinessOsEnvironmentId
    : selectedEnvironmentIdOverride;
  const [sortOrder, setSortOrder] = useState<ArchivedThreadSortOrder>("newest");
  const environments = useMemo<ReadonlyArray<ArchivedThreadsHeaderEnvironment>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById)
          .filter(
            (connection) =>
              !hasEnvironmentBindings ||
              environmentBindings.some(
                (binding) => binding.environmentId === connection.environmentId,
              ),
          )
          .map((connection) => ({
            environmentId: connection.environmentId,
            label: connection.environmentLabel,
          })),
        Order.mapInput(Order.String, (environment: ArchivedThreadsHeaderEnvironment) =>
          environment.label.toLocaleLowerCase(),
        ),
      ),
    [environmentBindings, hasEnvironmentBindings, savedConnectionsById],
  );
  const environmentIds = useMemo(
    () =>
      hasEnvironmentBindings && selectedEnvironmentId !== null
        ? [selectedEnvironmentId]
        : environments.map((environment) => environment.environmentId),
    [environments, hasEnvironmentBindings, selectedEnvironmentId],
  );
  const environmentLabels = useMemo(
    () =>
      Object.fromEntries(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [environments],
  );
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);
  const groups = useMemo(
    () =>
      buildArchivedThreadGroups({
        snapshots,
        environmentLabels,
        environmentId: selectedEnvironmentId,
        searchQuery,
        sortOrder,
      }),
    [environmentLabels, searchQuery, selectedEnvironmentId, snapshots, sortOrder],
  );
  const refreshChangedEnvironment = useCallback(
    (thread: { readonly environmentId: EnvironmentId }) => {
      refreshArchivedThreadsForEnvironment(thread.environmentId);
    },
    [],
  );
  const { unarchiveThread, confirmDeleteThread } =
    useArchivedThreadListActions(refreshChangedEnvironment);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  return (
    <ArchivedThreadsScreen
      allowAllEnvironments={!hasEnvironmentBindings}
      environments={environments}
      error={error}
      groups={groups}
      isLoading={isLoading}
      onDeleteThread={confirmDeleteThread}
      onEnvironmentChange={(environmentId) => {
        if (hasEnvironmentBindings) {
          if (environmentId) void selectEnvironment(environmentId);
          return;
        }
        setSelectedEnvironmentIdOverride(environmentId);
      }}
      onRefresh={refresh}
      onSearchQueryChange={setSearchQuery}
      onSortOrderChange={setSortOrder}
      onUnarchiveThread={unarchiveThread}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      sortOrder={sortOrder}
    />
  );
}
