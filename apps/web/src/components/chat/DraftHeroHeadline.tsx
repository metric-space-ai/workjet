import type { ScopedProjectRef } from "@workjet/contracts";
import { scopedProjectKey, scopeProjectRef } from "@workjet/client-runtime/environment";
import { ChevronDownIcon, FolderPlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useBusinessOsScopedEnvironments } from "~/state/environments";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

interface DraftHeroHeadlineProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useBusinessOsScopedEnvironments();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const handleNewThread = useNewThreadHandler();
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId: null,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [environmentLabelById, projectGroupingSettings, projectSortOrder, projects, threads],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="pointer-events-auto mx-1 max-w-64 align-middle text-base sm:text-lg"
            aria-label={hasResolvedProject ? "Projekt wechseln" : "Projekt wählen"}
            title={activeProjectDisplayName ?? undefined}
          />
        }
      >
        <span className="min-w-0 truncate">{activeProjectDisplayName ?? "Projekt wählen"}</span>
        <ChevronDownIcon aria-hidden="true" className="size-4 opacity-70" />
      </MenuTrigger>
      <MenuPopup align="center" className="max-h-80 min-w-40! w-max max-w-64 overflow-y-auto">
        <MenuRadioGroup
          value={activeProjectKey}
          onValueChange={(value) => {
            const entry = projectEntryByKey.get(value as string);
            if (!entry || value === activeProjectKey) {
              return;
            }
            const project = entry.targetProject;
            // Changing the repo of a draft moves the typed content along:
            // the user started writing in the wrong project, not a new task.
            void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
              replace: true,
              carryComposerContent: true,
            });
          }}
        >
          {projectPickerEntries.map(({ group }) => {
            return (
              <MenuRadioItem key={group.projectKey} value={group.projectKey} closeOnClick>
                <span className="block min-w-0 truncate" title={group.displayName}>
                  {group.displayName}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          Neues Projekt
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <Button
      type="button"
      variant="outline"
      onClick={openAddProject}
      className="pointer-events-auto mx-1 align-middle text-base sm:text-lg"
    >
      <FolderPlusIcon aria-hidden="true" />
      {activeProjectTitle ?? "Projekt hinzufügen"}
    </Button>
  );

  return (
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {hasResolvedProject ? <>Was bauen wir in {projectSelector}?</> : projectSelector}
    </h1>
  );
}
