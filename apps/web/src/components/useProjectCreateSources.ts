/**
 * Zustand und Seiteneffekte der Quellen „Aus Ordner“ und „Repository klonen“
 * für das Inline-Panel „Projekt anlegen“. Ordnerwahl über die pickFolder-
 * Brücke des Desktops (Systemdialog, kein App-Popup) oder über Vorschläge aus
 * dem Dateisystem des gewählten Rechners; Klonen über cloneRepository.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { canCreateProjectInEnvironment } from "@workjet/client-runtime/operations/projects";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@workjet/client-runtime/state/filesystem";
import { squashAtomCommandFailure } from "@workjet/client-runtime/state/runtime";
import type {
  CommandId,
  EnvironmentId,
  FilesystemBrowseEntry,
  ProjectId,
} from "@workjet/contracts";
import { useCallback, useContext, useMemo, useRef, useState } from "react";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import {
  ensureBrowseDirectoryPath,
  findProjectByPath,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../lib/projectPaths";
import { newCommandId, newProjectId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { useBusinessOsScopedEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { filesystemEnvironment } from "../state/filesystem";
import { environmentProjects, projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { parseWslUncPath, resolveProjectPickerTarget } from "../wslPaths";
import {
  buildProjectComputerOptions,
  cloneProjectRepository,
  defaultCloneBaseDirectory,
  deriveRepositoryFolderName,
  findDuplicateProjectForName,
  pickProjectFolder,
  readyCloneProviders,
  resolveProjectComputer,
  type ProjectCloneProvider,
  type ProjectCreateSource,
} from "./ProjectCreateSources.logic";

const MAX_FOLDER_SUGGESTIONS = 8;
const EMPTY_ENTRIES: readonly FilesystemBrowseEntry[] = [];

function browsePlatform(os: string | null | undefined): string {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

export function useProjectCreateSources(input: {
  readonly active: boolean;
  readonly source: ProjectCreateSource;
}) {
  const { environments } = useBusinessOsScopedEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const desktopLocalBootstraps = useDesktopLocalBootstraps();
  const projectStore = useContext(RegistryContext);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });

  const computerOptions = useMemo(
    () =>
      buildProjectComputerOptions(
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          isPrimary: environment.entry.target._tag === "PrimaryConnectionTarget",
          connected: canCreateProjectInEnvironment(environment.connection.phase),
        })),
      ),
    [environments],
  );
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId = resolveProjectComputer(computerOptions, chosenEnvironmentId);
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;
  const platform = browsePlatform(environment?.serverConfig?.environment.platform.os);
  const baseDirectorySetting = defaultCloneBaseDirectory(
    environment?.serverConfig?.settings?.addProjectBaseDirectory,
  );

  // „Aus Ordner“: path field prefilled with the computer's project folder.
  const [folderPathInput, setFolderPath] = useState<string | null>(null);
  const folderPath = folderPathInput ?? ensureBrowseDirectoryPath(baseDirectorySetting);
  const [picking, setPicking] = useState(false);
  const browsePath = getFilesystemBrowsePath(folderPath, platform);
  const browseQuery = useEnvironmentQuery(
    input.active &&
      input.source === "folder" &&
      environmentId !== null &&
      browsePath.isBrowsing &&
      browsePath.directoryPath.length > 0 &&
      !isExplicitRelativeProjectPath(folderPath.trim())
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: browsePath.directoryPath },
        })
      : null,
  );
  const folderSuggestions = useMemo(
    () =>
      filterFilesystemBrowseEntries(
        browseQuery.data?.entries ?? EMPTY_ENTRIES,
        browsePath.filterQuery,
      ).visibleEntries.slice(0, MAX_FOLDER_SUGGESTIONS),
    [browsePath.filterQuery, browseQuery.data?.entries],
  );

  // The desktop routes pickFolder by its pool instance id for a desktop-local
  // (WSL) computer; without that mapping the picker would open the wrong
  // filesystem, so it is only offered for this computer or a mapped one.
  const desktopInstanceId = useMemo(() => {
    if (environment === null || !isDesktopLocalConnectionTarget(environment.entry.target))
      return null;
    return (
      desktopLocalBootstraps.find((bootstrap) => bootstrap.httpBaseUrl === environment.displayUrl)
        ?.id ?? null
    );
  }, [desktopLocalBootstraps, environment]);
  const canPickFolder =
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    environmentId !== null &&
    (environmentId === primaryEnvironmentId || desktopInstanceId !== null);

  const pickFolder = useCallback(async (): Promise<string | null> => {
    const api = readLocalApi();
    if (api === undefined || environmentId === null) return null;
    setPicking(true);
    try {
      const wslConfiguration =
        environmentId === primaryEnvironmentId && platform === "Linux"
          ? ((await window.desktopBridge?.getWslState().catch(() => null)) ?? null)
          : null;
      const picked = await pickProjectFolder((options) => api.dialogs.pickFolder(options), {
        initialPath:
          folderPath.trim().length > 0 ? resolveProjectPathForDispatch(folderPath) : null,
        targetEnvironmentId: resolveProjectPickerTarget({
          browseEnvironmentId: environmentId,
          primaryEnvironmentId,
          desktopInstanceId,
          wslConfiguration,
        }),
      });
      if (picked === null) return null;
      if (parseWslUncPath(picked.path)) throw new Error("WSL-Ordner: Rechner WSL wählen.");
      setFolderPath(picked.path);
      return picked.title;
    } finally {
      setPicking(false);
    }
  }, [desktopInstanceId, environmentId, folderPath, platform, primaryEnvironmentId]);

  // „Repository klonen“.
  const sourceControlDiscovery = useEnvironmentQuery(
    input.active && input.source === "clone" && environmentId !== null
      ? sourceControlEnvironment.discovery({ environmentId, input: {} })
      : null,
  );
  const cloneProviders = useMemo(
    () => readyCloneProviders(sourceControlDiscovery.data),
    [sourceControlDiscovery.data],
  );
  const [chosenProvider, setCloneProvider] = useState<ProjectCloneProvider>("url");
  const cloneProvider = cloneProviders.includes(chosenProvider) ? chosenProvider : "url";
  const [repository, setRepository] = useState("");
  const [baseDirectoryInput, setBaseDirectory] = useState<string | null>(null);
  const baseDirectory = baseDirectoryInput ?? baseDirectorySetting;

  const sourceName =
    input.source === "clone"
      ? deriveRepositoryFolderName(repository)
      : input.source === "folder" && folderPathInput !== null
        ? inferProjectTitleFromPath(resolveProjectPathForDispatch(folderPath))
        : "";
  const environmentProjectList = useAtomValue(environmentProjects.projectsAtom).filter(
    (project) => project.environmentId === environmentId,
  );
  /** Project this source would duplicate; opened instead of creating a second card. */
  const duplicate =
    input.source === "clone"
      ? findDuplicateProjectForName(environmentProjectList, sourceName)
      : input.source === "folder" && folderPathInput !== null
        ? (findProjectByPath(environmentProjectList, resolveProjectPathForDispatch(folderPath)) ??
          undefined)
        : undefined;
  // Keep the existing project's casing („Metric“), not the folder's („metric“).
  const derivedTitle = duplicate?.title ?? sourceName;
  const ready =
    environmentId !== null &&
    (input.source === "clone"
      ? deriveRepositoryFolderName(repository).length > 0
      : input.source === "folder"
        ? folderPathInput !== null && resolveProjectPathForDispatch(folderPath).length > 0
        : true);

  /** Working copy path of the chosen source; clones first when needed. */
  const resolveWorkspaceRoot = useCallback(async (): Promise<string> => {
    if (environmentId === null) throw new Error("Kein Rechner verbunden.");
    if (input.source === "clone")
      return cloneProjectRepository(cloneRepository, {
        environmentId,
        provider: cloneProvider,
        repository,
        baseDirectory,
      });
    const raw = folderPath.trim();
    if (isExplicitRelativeProjectPath(raw)) throw new Error("Pfad ab ~ oder / angeben.");
    if (isUnsupportedWindowsProjectPath(raw, platform))
      throw new Error("Windows-Pfad nur auf Windows.");
    return resolveProjectPathForDispatch(raw);
  }, [
    baseDirectory,
    cloneProvider,
    cloneRepository,
    environmentId,
    folderPath,
    input.source,
    platform,
    repository,
  ]);

  const attemptRef = useRef<{ key: string; projectId: ProjectId; commandId: CommandId } | null>(
    null,
  );
  /**
   * Saves the project for a working copy. On this computer it carries a
   * pending CTOX registration (the native registration loop confirms it);
   * an existing project for the same folder is reused, not duplicated.
   */
  const createWorkspaceProject = useCallback(
    async (request: {
      readonly title: string;
      readonly workspaceRoot: string;
      readonly instanceId: string;
    }): Promise<{
      environmentId: EnvironmentId;
      projectId: ProjectId;
      /** Set when an existing project for this folder was opened instead. */
      reusedTitle?: string;
    }> => {
      if (environmentId === null) throw new Error("Kein Rechner verbunden.");
      const existing = findProjectByPath(
        projectStore
          .get(environmentProjects.projectsAtom)
          .filter((project) => project.environmentId === environmentId),
        request.workspaceRoot,
      );
      if (existing?.ctoxRegistration && existing.ctoxRegistration.instanceId !== request.instanceId)
        throw new Error("Ordner gehört zu einer anderen Instanz.");
      if (existing !== undefined)
        return { environmentId, projectId: existing.id, reusedTitle: existing.title };
      const key = JSON.stringify([
        request.instanceId,
        environmentId,
        request.title,
        request.workspaceRoot,
      ]);
      if (attemptRef.current?.key !== key)
        attemptRef.current = { key, projectId: newProjectId(), commandId: newCommandId() };
      const attempt = attemptRef.current;
      const registers = environmentId === primaryEnvironmentId;
      const result = await createProject({
        environmentId,
        input: {
          projectId: attempt.projectId,
          commandId: attempt.commandId,
          title: request.title,
          workspaceRoot: request.workspaceRoot,
          createWorkspaceRootIfMissing: true,
          ...(registers
            ? {
                ctoxRegistration: {
                  instanceId: request.instanceId,
                  commandId: attempt.commandId,
                  status: "pending" as const,
                },
              }
            : {}),
          defaultModelSelection: resolveDefaultProviderModelSelection(
            environment?.serverConfig?.providers ?? [],
            null,
          ),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      attemptRef.current = null;
      return { environmentId, projectId: attempt.projectId };
    },
    [createProject, environment, environmentId, primaryEnvironmentId, projectStore],
  );

  const reset = useCallback(() => {
    setFolderPath(null);
    setRepository("");
    setBaseDirectory(null);
  }, []);

  return {
    computerOptions,
    environmentId,
    duplicate: duplicate === undefined ? null : { id: duplicate.id, title: duplicate.title },
    setEnvironmentId: setChosenEnvironmentId,
    hasConnectedComputer: computerOptions.some((option) => option.connected),
    folderPath,
    setFolderPath,
    folderSuggestions,
    selectFolderSuggestion: (entry: FilesystemBrowseEntry) =>
      setFolderPath(ensureBrowseDirectoryPath(entry.fullPath)),
    canPickFolder,
    picking,
    pickFolder,
    cloneProviders,
    cloneProvider,
    setCloneProvider,
    repository,
    setRepository,
    baseDirectory,
    setBaseDirectory,
    derivedTitle,
    ready,
    resolveWorkspaceRoot,
    createWorkspaceProject,
    reset,
  };
}
