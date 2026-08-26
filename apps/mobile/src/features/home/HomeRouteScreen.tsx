import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { checkForAppUpdateOnLaunch } from "../updates/app-updates";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { buildHomeProjectScopes } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";
import { useBusinessOs } from "../business-os/BusinessOsProvider";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const {
    environmentBindings,
    hasEnvironmentBindings,
    selected: selectedBusinessOsInstance,
  } = useBusinessOs();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    void checkForAppUpdateOnLaunch();
  }, []);

  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    movePinnedThread,
    regenerateThreadTitle,
    unsettleThread,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(() => {
    const boundEnvironmentIds = new Set(
      environmentBindings
        .filter((binding) => binding.businessOsInstanceId === selectedBusinessOsInstance?.id)
        .map((binding) => binding.environmentId),
    );
    const connectionStateByEnvironmentId = new Map(
      workspaceEnvironments.map(
        (environment) => [environment.environmentId, environment.connectionState] as const,
      ),
    );
    return Arr.sort(
      Object.values(savedConnectionsById)
        .filter(
          (connection) =>
            !hasEnvironmentBindings || boundEnvironmentIds.has(connection.environmentId),
        )
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
          connectionState:
            connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
        })),
      Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
    );
  }, [
    environmentBindings,
    hasEnvironmentBindings,
    savedConnectionsById,
    selectedBusinessOsInstance?.id,
    workspaceEnvironments,
  ]);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const scopedProjects = useMemo(
    () =>
      hasEnvironmentBindings
        ? projects.filter((project) => availableEnvironmentIds.has(project.environmentId))
        : projects,
    [availableEnvironmentIds, hasEnvironmentBindings, projects],
  );
  const scopedThreads = useMemo(
    () =>
      hasEnvironmentBindings
        ? threads.filter((thread) => availableEnvironmentIds.has(thread.environmentId))
        : threads,
    [availableEnvironmentIds, hasEnvironmentBindings, threads],
  );
  const scopedPendingTasks = useMemo(
    () =>
      hasEnvironmentBindings
        ? pendingTasks.filter((task) => availableEnvironmentIds.has(task.message.environmentId))
        : pendingTasks,
    [availableEnvironmentIds, hasEnvironmentBindings, pendingTasks],
  );
  const {
    options: listOptions,
    setSelectedEnvironmentId,
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectFilterOptions = useMemo(
    () =>
      buildHomeProjectScopes({
        projects: scopedProjects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: listOptions.projectGroupingMode,
      }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [listOptions.projectGroupingMode, scopedProjects, selectedEnvironmentId],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions
          options={{ title: "", headerTitle: "", unstable_headerLeftItems: () => [] }}
        />
        <WorkspaceSidebarToolbar
          afterSidebarButton={
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            />
          }
        />
        <WorkspaceEmptyDetail
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
    >
      <>
        {/* Restore the compact title after the split branch blanks the detail
            header. The brand slot doubles as the connection status surface:
            while an environment reconnects, the lockup fades to a status label
            in place (no layout shift in the list below). */}
        <NativeStackScreenOptions
          options={getConnectionAwareBrandHeaderOptions({
            onOpenEnvironments: () =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsBusinessOs" },
              }),
          })}
        />
        <HomeHeader
          allowAllEnvironments
          allEnvironmentsLabel={
            hasEnvironmentBindings
              ? `All machines in ${selectedBusinessOsInstance?.displayName ?? "this CTOX instance"}`
              : "All machines"
          }
          environments={environments}
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          projectSortOrder={listOptions.projectSortOrder}
          threadSortOrder={listOptions.threadSortOrder}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsBusinessOs" },
            })
          }
          onOpenSettings={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
          onProjectSortOrderChange={setProjectSortOrder}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          onThreadSortOrderChange={setThreadSortOrder}
        />

        <HomeScreen
          catalogState={catalogState}
          environments={environments}
          onAddConnection={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsBusinessOs" },
            })
          }
          onArchiveThread={archiveThread}
          onDeleteThread={confirmDeleteThread}
          onSettleThread={settleThread}
          onSnoozeThread={snoozeThread}
          onUnsnoozeThread={unsnoozeThread}
          onUnsettleThread={unsettleThread}
          onPinThread={pinThread}
          onUnpinThread={unpinThread}
          onMovePinnedThread={movePinnedThread}
          onRegenerateThreadTitle={regenerateThreadTitle}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenSettings={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
          onProjectSortOrderChange={setProjectSortOrder}
          onSearchQueryChange={setSearchQuery}
          onSelectThread={(thread) => {
            // Settled threads are live shells: opening one is plain
            // navigation, and sending a message un-settles server-side.
            navigation.navigate("Thread", {
              environmentId: thread.environmentId,
              threadId: thread.id,
            });
          }}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          onNewThreadInProject={(project) => {
            navigation.navigate("NewTaskSheet", {
              screen: "NewTaskDraft",
              params: {
                environmentId: String(project.environmentId),
                projectId: String(project.id),
                title: project.title,
              },
            });
          }}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          onThreadSortOrderChange={setThreadSortOrder}
          pendingTasks={scopedPendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={scopedProjects}
          projectSortOrder={listOptions.projectSortOrder}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          threads={scopedThreads}
          threadSortOrder={listOptions.threadSortOrder}
        />
      </>
    </AndroidHomeFabLayout>
  );
}
