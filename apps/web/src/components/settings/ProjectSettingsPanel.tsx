import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@workjet/client-runtime/state/runtime";
import { scopeProjectRef } from "@workjet/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  deriveProjectGroupingOverrideKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import type {
  ModelSelection,
  ProjectOverview,
  ProviderDriverKind,
  SidebarProjectGroupingMode,
  WorkjetProjectFileScript,
  ThreadEnvMode,
} from "@workjet/contracts";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { createModelSelection } from "@workjet/shared/model";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@workjet/shared/keybindings";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { ChevronDownIcon, CopyIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useAvailableProjectContext } from "../../availableProjects";
import { syncWorkjetProjectTitle } from "../../workjetProjectRename";
import { isElectron } from "../../env";
import {
  useClientSettings,
  useUpdateClientSettings,
  usePrimarySettings,
} from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useWorkjetProjectFileState } from "../../hooks/useWorkjetProjectFileScripts";
import { shortcutLabelForCommand } from "../../keybindings";
import { keybindingValueForCommand } from "../../lib/projectScriptKeybindings";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
} from "../../projectScripts";
import { decodeProjectScriptKeybindingRule } from "../../lib/projectScriptKeybindings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectOverviewEditor } from "../ProjectOverviewEditor";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditor,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { InlineExpand } from "../ui/inline-expand";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Empty, EmptyHeader, EmptyTitle } from "../ui/empty";
import { useUiText } from "../../hooks/useUiText";
import { Row } from "../ui/row";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsEmbeddedContext,
  SettingsSection,
  useSettingsEmbedded,
} from "./settingsLayout";
import { ProjectFaviconPicker } from "./ProjectFaviconPicker";
import { ProjectSupervisorLumaField } from "../ProjectSupervisorLumaField";
import type { ProjectConfigurationValues } from "../ProjectOverviewEditor";
import { buildProjectGallery } from "../../projectOverview";
import { configureWorkjetProject, workjetUiLanguage } from "../../workjetProjectControl";
import { useProjectKpiSettings } from "../../hooks/useProjectKpiSettings";
import {
  recordWorkjetProjectProjection,
  refreshWorkjetProjectRegistry,
  useWorkjetProjectRegistry,
} from "../../workjetProjectRegistry";
import { readActiveWorkjetScope, useActiveWorkjetScope } from "../../activeWorkjetScope";
import { cn, newCommandId } from "../../lib/utils";
import {
  INSTANCE_PROJECT_KEY_PREFIX,
  InstanceProjectDetail,
  InstanceProjectRow,
  instanceProjectSettingsKey,
  useInstanceOnlyProjects,
} from "./InstanceProjectSettings";

export const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Nach Repository",
  repository_path: "Nach Repository-Pfad",
  separate: "Getrennt",
};

/** Logical project groups for the settings page, sorted by display name. */
export function useSettingsProjectGroups(): SidebarProjectSnapshot[] {
  const projects = useProjects();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  return useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [environmentLabelById, primaryEnvironmentId, projectGroupingSettings, projects],
  );
}

function memberKey(member: { environmentId: string; id: string }): string {
  return `${member.environmentId}:${member.id}`;
}

/**
 * Einstellungen › Projekte: every project as one Row. A click on the name
 * opens Einstellungen › Projekte › <Projekt>.
 */
function compareByName(a: { readonly name: string }, b: { readonly name: string }) {
  return a.name.localeCompare(b.name);
}

export function ProjectsSettingsList() {
  const groups = useSettingsProjectGroups();
  const instanceProjects = useInstanceOnlyProjects().projects;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggle = (key: string) => setOpenKey((current) => (current === key ? null : key));
  const rows = [
    ...groups.map((group) => ({
      name: readableProjectName(group.displayName),
      key: group.projectKey,
      row: localProjectRow(group, openKey === group.projectKey, toggle),
    })),
    ...instanceProjects.map((project) => {
      const key = instanceProjectSettingsKey(project.id);
      return {
        name: project.title,
        key,
        row: (
          <InstanceProjectRow
            key={project.key}
            project={project}
            open={openKey === key}
            onToggle={() => toggle(key)}
          />
        ),
      };
    }),
  ].toSorted(compareByName);
  return (
    <SettingsPageContainer>
      <SettingsSection title={workjetUiLanguage() === "en" ? "Projects" : "Projekte"}>
        {rows.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyTitle className="text-[13.5px]">
                {workjetUiLanguage() === "en" ? "No projects yet" : "Noch keine Projekte"}
              </EmptyTitle>
            </EmptyHeader>
            <Button size="sm" variant="outline" render={<Link to="/" />}>
              <PlusIcon className="size-4" />
              {workjetUiLanguage() === "en" ? "Create project" : "Projekt anlegen"}
            </Button>
          </Empty>
        ) : (
          <div className="divide-y divide-border/60" data-workjet-settings-projects="">
            {rows.map((entry) => (
              <div key={entry.key}>
                {entry.row}
                <InlineExpand
                  hideCollapseControl
                  label={entry.name}
                  open={openKey === entry.key}
                  onOpenChange={(open) => {
                    if (!open) setOpenKey((current) => (current === entry.key ? null : current));
                  }}
                >
                  {openKey === entry.key ? (
                    <div className="px-3 sm:px-4" data-workjet-project-settings-inline="">
                      <SettingsEmbeddedContext.Provider value={{ onClose: () => setOpenKey(null) }}>
                        <ProjectSettingsPanel projectKey={entry.key} />
                      </SettingsEmbeddedContext.Provider>
                    </div>
                  ) : null}
                </InlineExpand>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/**
 * Generated folder names ("local-2026-08-25T113531Z-<uuid>", "acceptance-project-cc6e")
 * are ids, not names: show the readable part (#624).
 */
export function readableProjectName(name: string): string {
  const local = /^local-(\d{4})-(\d{2})-(\d{2})T\d{6}Z-[0-9a-f-]{36}$/i.exec(name);
  if (local)
    return workjetUiLanguage() === "en"
      ? `Project of ${local[1]}-${local[2]}-${local[3]}`
      : `Projekt vom ${local[3]}.${local[2]}.${local[1]}`;
  return name.replace(/-[0-9a-f]{4,}$/i, "");
}

function localProjectRow(
  group: SidebarProjectSnapshot,
  open: boolean,
  toggle: (key: string) => void,
) {
  const representative =
    group.memberProjects.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ?? group.memberProjects[0];
  return (
    <Row
      name={
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggle(group.projectKey)}
          className="flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-workjet-action={`project.settings:${group.projectKey}`}
        >
          {representative ? (
            <ProjectFavicon
              environmentId={representative.environmentId}
              cwd={representative.workspaceRoot}
              faviconPath={representative.faviconPath ?? null}
              className="size-4 shrink-0"
            />
          ) : null}
          <span className="truncate">{readableProjectName(group.displayName)}</span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      }
      chips={
        group.memberProjects.length > 1 ? (
          <span className="rounded-sm border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground">
            {group.memberProjects.length}{" "}
            {workjetUiLanguage() === "en" ? "working copies" : "Arbeitskopien"}
          </span>
        ) : undefined
      }
    />
  );
}

export function ProjectSettingsPanel({ projectKey }: { projectKey: string }) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate();

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const instance = useInstanceOnlyProjects();
  const instanceProject = projectKey.startsWith(INSTANCE_PROJECT_KEY_PREFIX)
    ? (instance.projects.find(
        (project) => project.id === projectKey.slice(INSTANCE_PROJECT_KEY_PREFIX.length),
      ) ?? null)
    : null;

  // Mitglieder der zuletzt gezeigten Gruppe merken: Ändert sich die
  // Gruppierungsregel (und damit der Schlüssel), folgt die Seite dem Projekt.
  const lastSelectionRef = useRef<{ key: string; memberKeys: string[] } | null>(null);
  useEffect(() => {
    if (!selected) return;
    lastSelectionRef.current = {
      key: selected.projectKey,
      memberKeys: selected.memberProjects.map((member) => member.physicalProjectKey),
    };
  }, [selected]);

  // A grouping-rule change replaces the group key mid-visit; follow the
  // project to its new key instead of parking on the not-found state.
  useEffect(() => {
    if (selected !== null) return;
    const last = lastSelectionRef.current;
    if (last?.key !== projectKey) return;
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => last.memberKeys.includes(member.physicalProjectKey)),
    );
    if (successor) {
      void navigate({
        to: "/settings/projects/$projectKey",
        params: { projectKey: successor.projectKey },
        replace: true,
        hashScrollIntoView: false,
      });
    }
  }, [groups, navigate, projectKey, selected]);

  if (!selected && instanceProject !== null && instance.instanceId !== null)
    return <InstanceProjectDetail instanceId={instance.instanceId} project={instanceProject} />;
  if (!selected) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle className="text-[13.5px]">Projekt nicht gefunden</EmptyTitle>
        </EmptyHeader>
        <Button size="sm" variant="outline" render={<Link to="/settings/projects" />}>
          Alle Projekte
        </Button>
      </Empty>
    );
  }
  return <ProjectDetail key={selected.projectKey} group={selected} />;
}

function ProjectDetail({ group }: { group: SidebarProjectSnapshot }) {
  const embedded = useSettingsEmbedded();
  const t = useUiText();
  type ProjectTab = "general" | "threads" | "checkout" | "scripts";
  const projectTabs: ReadonlyArray<readonly [ProjectTab, string]> = [
    ["general", t("Allgemein", "General")],
    ["threads", t("Unterhaltungen", "Threads")],
    ["checkout", t("Arbeitskopie", "Working copy")],
    ["scripts", t("Skripte", "Scripts")],
  ];
  const [tab, setTab] = useState<ProjectTab>("general");
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const settings = usePrimarySettings();
  const { workjetProjectRegistry, workjetProjects } = useAvailableProjectContext();
  const [isSavingName, setIsSavingName] = useState(false);
  const savingNameRef = useRef(false);
  const updateClientSettings = useUpdateClientSettings();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const threads = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Pfad kopiert", description: path });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Pfad nicht kopiert",
          description: error instanceof Error ? error.message : "Unbekannter Fehler.",
        }),
      );
    },
  });

  const representative =
    group.memberProjects.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ?? group.memberProjects[0]!;
  const faviconPath = representative.faviconPath ?? null;

  const threadCountByMember = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads]);
  const reportFailure = useCallback((title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "Unbekannter Fehler.",
      }),
    );
  }, []);

  // Group-shared fields live on each physical project record, so a
  // group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        title: string;
        defaultModelSelection: ModelSelection | null;
        defaultThreadEnvMode: ThreadEnvMode | null;
        faviconPath: string | null;
        overview: ProjectOverview | null;
      }>,
      failureTitle: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      for (const member of group.memberProjects) {
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              ...input,
              ...(input.overview
                ? { expectedTokenBudgetRevision: member.overview?.tokenBudget?.revision ?? 0 }
                : {}),
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // A partial fan-out is possible: earlier members already took the
          // write. Name the environment so the user knows where it stopped.
          reportFailure(
            group.memberProjects.length > 1
              ? `${failureTitle} auf ${member.environmentLabel ?? "dieser Umgebung"}`
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [group.memberProjects, reportFailure, updateProject],
  );

  const renameGroup = useCallback(
    async (nextTitle: string) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Projektname fehlt" });
        return;
      }
      if (savingNameRef.current) return;
      savingNameRef.current = true;
      setIsSavingName(true);
      try {
        const instanceId = workjetProjectRegistry.presentationInstanceId;
        const confirmed = await syncWorkjetProjectTitle({
          instanceId,
          nativeProjects: workjetProjects,
          projects: group.memberProjects,
          computers: settings.workjet.computers,
          title,
        });
        if (instanceId !== null) {
          for (const project of confirmed) recordWorkjetProjectProjection(instanceId, project);
        }
        if (!group.memberProjects.every((member) => member.title === title)) {
          await updateAllMembers({ title }, "Projekt nicht umbenannt");
        }
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Projektname nicht abgeglichen",
            description:
              error instanceof Error ? error.message : "Neu verbinden und erneut versuchen.",
          }),
        );
      } finally {
        savingNameRef.current = false;
        setIsSavingName(false);
      }
    },
    [
      group.memberProjects,
      settings.workjet.computers,
      updateAllMembers,
      workjetProjectRegistry.presentationInstanceId,
      workjetProjects,
    ],
  );

  // ----- default model -----
  const storedSelection = representative.defaultModelSelection;
  const resolvedSelection = resolveDefaultProviderModelSelection(serverProviders, storedSelection);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === resolvedSelection?.instanceId,
  );
  const setDefaultModel = useCallback(
    (selection: ModelSelection | null) =>
      void updateAllMembers(
        { defaultModelSelection: selection },
        "Standardmodell nicht gespeichert",
      ),
    [updateAllMembers],
  );

  // ----- new-thread workspace mode -----
  const storedEnvMode = representative.defaultThreadEnvMode ?? null;
  const setDefaultThreadEnvMode = useCallback(
    (mode: ThreadEnvMode | null) =>
      void updateAllMembers({ defaultThreadEnvMode: mode }, "Arbeitsbereich nicht gespeichert"),
    [updateAllMembers],
  );

  // ----- favicon -----
  const [faviconPickerOpen, setFaviconPickerOpen] = useState(false);
  // Selten gebrauchte Abschnitte sind zugeklappt; immer nur einer offen.
  const [openSection, setOpenSection] = useState<string | null>(null);
  const sectionToggle = (key: string) => ({
    open: openSection === key,
    onOpenChange: (open: boolean) =>
      setOpenSection((current) => (open ? key : current === key ? null : current)),
  });
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setFaviconPath = useCallback(
    async (faviconPath: string | null) => {
      if (savingFaviconRef.current) return;
      savingFaviconRef.current = true;
      setIsSavingFavicon(true);
      try {
        await updateAllMembers({ faviconPath }, "Projektsymbol nicht gespeichert");
      } finally {
        savingFaviconRef.current = false;
        setIsSavingFavicon(false);
      }
    },
    [updateAllMembers],
  );

  // ----- checkout selection and scripts -----
  const [selectedCheckoutKey, setSelectedCheckoutKey] = useState(representative.physicalProjectKey);
  const selectedCheckout =
    group.memberProjects.find((member) => member.physicalProjectKey === selectedCheckoutKey) ??
    representative;
  const selectedServerConfig = useAtomValue(
    serverEnvironment.configValueAtom(selectedCheckout.environmentId),
  );
  const keybindings = selectedServerConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const scripts = selectedCheckout.scripts;
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);
  // Script writes replace the whole array, so two overlapping writes computed
  // from the same snapshot would drop each other's changes. One at a time.
  const [isSavingScripts, setIsSavingScripts] = useState(false);
  const savingScriptsRef = useRef(false);
  const workjetFile = useWorkjetProjectFileState(
    selectedCheckout.environmentId,
    selectedCheckout.workspaceRoot,
  );
  // What the "Default" option resolves to while no override is set: the
  // repo's workjet.json value when present, otherwise the global setting.
  const inheritedEnvMode = workjetFile.file?.defaultThreadEnvMode ?? settings.defaultThreadEnvMode;
  const inheritedEnvModeSource =
    workjetFile.file?.defaultThreadEnvMode != null ? "workjet.json" : "global";
  const importableScripts = useMemo(
    () =>
      workjetFile.scripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [scripts, workjetFile.scripts],
  );

  const persistScripts = useCallback(
    async (
      nextScripts: ReadonlyArray<ReturnType<typeof buildProjectScript>>,
      keybinding: string | null | undefined,
      keybindingCommand: ReturnType<typeof commandForProjectScript>,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (savingScriptsRef.current) {
        return AsyncResult.failure(
          Cause.fail(new Error("Eine andere Skriptänderung wird noch gespeichert.")),
        );
      }
      savingScriptsRef.current = true;
      setIsSavingScripts(true);
      try {
        // Captured before the write so a cleared or deleted binding can be
        // removed from the keybindings config afterwards.
        const previousKeybinding = keybindingValueForCommand(keybindings, keybindingCommand);
        const updateResult = mapAtomCommandResult(
          await updateProject({
            environmentId: selectedCheckout.environmentId,
            input: { projectId: selectedCheckout.id, scripts: nextScripts },
          }),
          () => undefined,
        );
        if (updateResult._tag === "Failure") {
          reportFailure("Skripte nicht gespeichert", updateResult);
          return updateResult;
        }

        const keybindingRule = decodeProjectScriptKeybindingRule({
          keybinding,
          command: keybindingCommand,
        });
        if (!isElectron) return updateResult;
        const environmentIds = [selectedCheckout.environmentId];
        const previousTarget = previousKeybinding
          ? decodeProjectScriptKeybindingRule({
              keybinding: previousKeybinding,
              command: keybindingCommand,
            })
          : null;
        if (keybindingRule) {
          // `replace` swaps the command's previous rule instead of appending a
          // second one that would keep the old shortcut alive.
          const input =
            previousTarget && previousTarget.key !== keybindingRule.key
              ? { ...keybindingRule, replace: previousTarget }
              : keybindingRule;
          for (const environmentId of environmentIds) {
            const result = mapAtomCommandResult(
              await upsertKeybinding({ environmentId, input }),
              () => undefined,
            );
            if (result._tag === "Failure") {
              reportFailure("Tastenkürzel nicht gespeichert", result);
              return result;
            }
          }
        } else if (previousTarget) {
          for (const environmentId of environmentIds) {
            const result = mapAtomCommandResult(
              await removeKeybinding({ environmentId, input: previousTarget }),
              () => undefined,
            );
            if (result._tag === "Failure") {
              reportFailure("Tastenkürzel nicht entfernt", result);
              return result;
            }
          }
        }
        return updateResult;
      } finally {
        savingScriptsRef.current = false;
        setIsSavingScripts(false);
      }
    },
    [
      keybindings,
      removeKeybinding,
      reportFailure,
      selectedCheckout.environmentId,
      selectedCheckout.id,
      updateProject,
      upsertKeybinding,
    ],
  );

  const submitScript = useCallback(
    async (
      scriptId: string | null,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (scriptId === null) {
        const nextId = nextProjectScriptId(
          input.name,
          scripts.map((script) => script.id),
        );
        const nextScript = buildProjectScript(nextId, input);
        const nextScripts = input.runOnWorktreeCreate
          ? [
              ...scripts.map((script) =>
                script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
              ),
              nextScript,
            ]
          : [...scripts, nextScript];
        return persistScripts(nextScripts, input.keybinding, commandForProjectScript(nextId));
      }

      const updatedScript = buildProjectScript(scriptId, input);
      const nextScripts = scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );
      return persistScripts(nextScripts, input.keybinding, commandForProjectScript(scriptId));
    },
    [persistScripts, scripts],
  );

  const deleteScript = useCallback(
    (scriptId: string) => {
      const nextScripts = scripts.filter((script) => script.id !== scriptId);
      void persistScripts(nextScripts, null, commandForProjectScript(scriptId));
    },
    [persistScripts, scripts],
  );

  const importFileScript = useCallback(
    async (fileScript: WorkjetProjectFileScript) => {
      const payload: NewProjectScriptInput = {
        name: fileScript.name,
        command: fileScript.command,
        icon: fileScript.icon ?? "play",
        runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
        keybinding: null,
        previewUrl: fileScript.previewUrl ?? null,
        autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
      };
      const result = await submitScript(null, payload);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setEditorRequest({
          scriptId: null,
          initial: payload,
          error: error instanceof Error ? error.message : "Skript nicht übernommen.",
        });
      }
    },
    [submitScript],
  );

  // ----- checkouts -----
  const updateGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | "inherit") => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateClientSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides, updateClientSettings],
  );

  // Removal asks inline (the button turns into „Entfernen? [Entfernen]
  // [Abbrechen]“), never through a native or in-app dialog.
  const [confirmingRemoval, setConfirmingRemoval] = useState<"checkout" | "project" | null>(null);
  const removeMembers = useCallback(
    async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
      setConfirmingRemoval(null);
      const memberKeys = new Set(members.map(memberKey));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === group.memberProjects.length;

      const draftStore = useComposerDraftStore.getState();
      for (const member of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        );
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              ...(memberThreads.length > 0 ? { force: true } : {}),
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          reportFailure(`„${member.title}“ nicht entfernt`, result);
          return;
        }
        const projectRef = scopeProjectRef(member.environmentId, member.id);
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        if (projectDraftThread) {
          draftStore.clearDraftThread(projectDraftThread.draftId);
        }
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      // The project's settings page just deleted itself; fall back to the
      // project list in Einstellungen › Projekte.
      if (isWholeGroup) {
        void navigate({ to: "/settings/projects", replace: true });
      }
    },
    [deleteProject, group.memberProjects.length, navigate, reportFailure, threads],
  );

  const selectedCheckoutThreadCount = threadCountByMember.get(memberKey(selectedCheckout)) ?? 0;
  const selectedCheckoutGrouping =
    projectGroupingSettings.sidebarProjectGroupingOverrides?.[
      deriveProjectGroupingOverrideKey(selectedCheckout)
    ] ?? "inherit";
  const selectedCheckoutLabel = selectedCheckout.environmentLabel ?? "Dieser Rechner";

  // ----- CTOX configuration: Regeltermin, Supervisor (native projects) -----
  const { selectedInstanceId: activeCtoxInstanceId } = useActiveWorkjetScope();
  const nativeRegistry = useWorkjetProjectRegistry(activeCtoxInstanceId);
  const allProjects = useProjects();
  const nativeConfiguration = useMemo(() => {
    if (activeCtoxInstanceId === null) return undefined;
    const gallery = buildProjectGallery({
      projects: allProjects,
      nativeProjects: nativeRegistry.projects,
      instanceId: activeCtoxInstanceId,
      primaryEnvironmentId: representative.environmentId,
      computers: settings.workjet.computers,
    });
    return gallery.find(
      (project) =>
        project.configuration !== undefined &&
        project.local !== null &&
        group.memberProjects.some(
          (member) =>
            member.environmentId === project.local?.environmentId &&
            member.id === project.local?.id,
        ),
    )?.configuration;
  }, [
    activeCtoxInstanceId,
    allProjects,
    group.memberProjects,
    nativeRegistry.projects,
    representative.environmentId,
    settings.workjet.computers,
  ]);
  const saveNativeConfiguration = useCallback(
    async (values: ProjectConfigurationValues): Promise<boolean> => {
      if (activeCtoxInstanceId === null || nativeConfiguration === undefined) return false;
      if (readActiveWorkjetScope().selectedInstanceId !== activeCtoxInstanceId) return false;
      const result = await configureWorkjetProject(activeCtoxInstanceId, {
        action: "project.configure",
        commandId: newCommandId(),
        projectId: nativeConfiguration.id,
        title: group.displayName,
        ...values,
      });
      if (
        result._tag !== "completed" ||
        result.response.action !== "project.configure" ||
        readActiveWorkjetScope().selectedInstanceId !== activeCtoxInstanceId
      )
        return false;
      refreshWorkjetProjectRegistry(activeCtoxInstanceId);
      return true;
    },
    [activeCtoxInstanceId, group.displayName, nativeConfiguration],
  );

  const projectKpis = useProjectKpiSettings(activeCtoxInstanceId, nativeConfiguration?.id);

  const removeLabel =
    group.memberProjects.length > 1 ? "Alle Einträge entfernen" : "Projekt entfernen";

  // Regeltermin, budget and KPIs are edited on the project card; embedded settings skip them.
  const showTab = (id: ProjectTab | "card") => !embedded || (id === "card" ? false : id === tab);
  const content = (
    <>
      <div
        className={cn("flex min-w-0 items-center gap-2 px-1", embedded && "hidden")}
        data-workjet-project-settings-header=""
      >
        <ProjectFavicon
          environmentId={representative.environmentId}
          cwd={representative.workspaceRoot}
          faviconPath={faviconPath}
          className="size-5"
        />
        <h2 className="min-w-0 break-words text-[22px] font-semibold">{group.displayName}</h2>
      </div>

      {showTab("general") ? (
        <SettingsSection title={embedded ? "" : t("Projekt", "Project")}>
          <SettingsRow
            title="Name"
            control={
              <Input
                key={`${group.projectKey}:${group.displayName}`}
                className="w-full sm:w-64"
                aria-label="Projektname"
                disabled={isSavingName}
                defaultValue={group.displayName}
                onBlur={(event) => {
                  void renameGroup(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Symbol"
            status={faviconPath ?? "Automatisch"}
            resetAction={
              faviconPath !== null ? (
                <SettingResetButton
                  label="Projektsymbol"
                  disabled={isSavingFavicon}
                  onClick={() => void setFaviconPath(null)}
                />
              ) : null
            }
            control={
              <Button
                size="xs"
                variant="outline"
                type="button"
                aria-expanded={faviconPickerOpen}
                disabled={isSavingFavicon || representative.workspaceRoot === null}
                onClick={() => setFaviconPickerOpen((open) => !open)}
              >
                Datei wählen
              </Button>
            }
          />
          <InlineExpand
            hideCollapseControl
            label="Symbol"
            open={faviconPickerOpen && representative.workspaceRoot !== null}
            onOpenChange={setFaviconPickerOpen}
          >
            {faviconPickerOpen && representative.workspaceRoot !== null ? (
              <div className="px-3 pb-3 sm:px-4">
                <ProjectFaviconPicker
                  key={`${representative.environmentId}:${representative.workspaceRoot}`}
                  cwd={representative.workspaceRoot}
                  environmentId={representative.environmentId}
                  onClose={() => setFaviconPickerOpen(false)}
                  onSelect={(path) => void setFaviconPath(path)}
                />
              </div>
            ) : null}
          </InlineExpand>
        </SettingsSection>
      ) : null}

      {showTab("card") ? (
        <SettingsSection
          title={
            embedded
              ? ""
              : t("Regeltermin, Budget und Supervisor", "Regular meeting, budget and supervisor")
          }
        >
          <div className="px-3 py-3 sm:px-4" data-workjet-project-settings-overview="">
            <ProjectOverviewEditor
              key={group.projectKey}
              onCancel={embedded?.onClose}
              overview={representative.overview}
              configuration={nativeConfiguration}
              onSaveConfiguration={nativeConfiguration ? saveNativeConfiguration : undefined}
              kpis={projectKpis.kpis}
              onSaveKpis={projectKpis.save}
              kpisLoadFailed={projectKpis.loadFailed}
              renderLumaField={(props) => <ProjectSupervisorLumaField {...props} />}
              onSave={async (overview) => {
                if (
                  !group.memberProjects.every((member) =>
                    environments.some(
                      (environment) =>
                        environment.environmentId === member.environmentId &&
                        environment.connection.phase === "connected" &&
                        environment.serverConfig?.projectOverview === true,
                    ),
                  )
                )
                  return false;
                const result = await updateAllMembers(
                  { overview },
                  "Projektübersicht nicht gespeichert",
                );
                return result._tag === "Success";
              }}
            />
          </div>
        </SettingsSection>
      ) : null}

      {showTab("threads") ? (
        <SettingsSection
          title={embedded ? "" : t("Neue Unterhaltungen", "New threads")}
          {...(embedded ? {} : { collapsible: sectionToggle("Neue Unterhaltungen") })}
        >
          <SettingsRow
            title="Modell"
            resetAction={
              storedSelection !== null ? (
                <SettingResetButton label="Standardmodell" onClick={() => setDefaultModel(null)} />
              ) : null
            }
            control={
              resolvedSelection && activeEntry ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={resolvedSelection.instanceId}
                    model={resolvedSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerVariant="outline"
                    triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                    onInstanceModelChange={(instanceId, model) => {
                      setDefaultModel(createModelSelection(instanceId, model));
                    }}
                  />
                  <TraitsPicker
                    provider={activeEntry.driverKind as ProviderDriverKind}
                    models={activeEntry.models}
                    model={resolvedSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={resolvedSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    triggerVariant="outline"
                    triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                    onModelOptionsChange={(nextOptions) => {
                      setDefaultModel(
                        createModelSelection(
                          resolvedSelection.instanceId,
                          resolvedSelection.model,
                          nextOptions,
                        ),
                      );
                    }}
                  />
                </div>
              ) : (
                <span className="text-[13.5px] text-muted-foreground">Kein Anbieter verfügbar</span>
              )
            }
          />
          <SettingsRow
            title="Arbeitsbereich"
            resetAction={
              storedEnvMode !== null ? (
                <SettingResetButton
                  label="Arbeitsbereich"
                  onClick={() => setDefaultThreadEnvMode(null)}
                />
              ) : null
            }
            control={
              <Select
                value={storedEnvMode ?? "inherit"}
                onValueChange={(value) => {
                  if (value === "worktree" || value === "local") {
                    setDefaultThreadEnvMode(value);
                  } else if (value === "inherit") {
                    setDefaultThreadEnvMode(null);
                  }
                }}
              >
                <SelectTrigger aria-label="Arbeitsbereich neuer Unterhaltungen">
                  <SelectValue>
                    {storedEnvMode === null
                      ? group.memberProjects.length > 1
                        ? "Standard (je Arbeitskopie)"
                        : `Standard (${resolveEnvModeLabel(inheritedEnvMode).toLowerCase()})`
                      : resolveEnvModeLabel(storedEnvMode)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">
                    {group.memberProjects.length > 1
                      ? "Standard (je Arbeitskopie)"
                      : `Standard (${inheritedEnvModeSource === "global" ? "global" : "workjet.json"}: ${resolveEnvModeLabel(inheritedEnvMode).toLowerCase()})`}
                  </SelectItem>
                  <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
                  <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}

      {showTab("checkout") ? (
        <SettingsSection
          title={embedded ? "" : t("Arbeitskopie", "Working copy")}
          {...(embedded ? {} : { collapsible: sectionToggle("Arbeitskopie") })}
          headerAction={
            group.memberProjects.length > 1 ? (
              <Select
                value={selectedCheckout.physicalProjectKey}
                onValueChange={(value) => setSelectedCheckoutKey(String(value))}
              >
                <SelectTrigger className="max-w-64" aria-label="Arbeitskopie">
                  <SelectValue>{selectedCheckoutLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {group.memberProjects.map((member) => (
                    <SelectItem
                      key={member.physicalProjectKey}
                      hideIndicator
                      value={member.physicalProjectKey}
                    >
                      {member.environmentLabel ?? "Dieser Rechner"} · {member.workspaceRoot}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : undefined
          }
        >
          <div className="px-3 py-2 sm:px-4">
            <div className="flex min-w-0 items-center rounded-lg bg-muted/30 p-1 text-[13.5px] text-muted-foreground">
              <button
                disabled={selectedCheckout.workspaceRoot === null}
                aria-label="Pfad kopieren"
                className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                title="Pfad kopieren"
                type="button"
                onClick={() =>
                  selectedCheckout.workspaceRoot !== null &&
                  copyPathToClipboard(selectedCheckout.workspaceRoot, {
                    path: selectedCheckout.workspaceRoot,
                  })
                }
              >
                <code className="min-w-0 flex-1 truncate font-mono">
                  {selectedCheckout.workspaceRoot ?? "Ohne Ordner"}
                </code>
                <CopyIcon className="size-4 shrink-0 opacity-60 group-hover:opacity-100" />
              </button>
              <div className="shrink-0 border-l border-border/60 px-2 tabular-nums">
                {selectedCheckoutThreadCount === 1
                  ? "1 Unterhaltung"
                  : `${selectedCheckoutThreadCount} Unterhaltungen`}
              </div>
            </div>
          </div>
          <SettingsRow
            title="Gruppierung"
            control={
              <Select
                value={selectedCheckoutGrouping}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    updateGroupingPreference(selectedCheckout, value);
                  }
                }}
              >
                <SelectTrigger aria-label={`Gruppierung für ${selectedCheckoutLabel}`}>
                  <SelectValue>
                    {selectedCheckoutGrouping === "inherit"
                      ? `Standard (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                      : PROJECT_GROUPING_MODE_LABELS[selectedCheckoutGrouping]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="inherit">
                    Standard
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          {group.memberProjects.length > 1 ? (
            <SettingsRow
              title="Arbeitskopie entfernen"
              control={
                confirmingRemoval === "checkout" ? (
                  <InlineRemovalConfirm
                    label="Arbeitskopie entfernen"
                    onConfirm={() => void removeMembers([selectedCheckout])}
                    onCancel={() => setConfirmingRemoval(null)}
                  />
                ) : (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    onClick={() => setConfirmingRemoval("checkout")}
                  >
                    <Trash2Icon className="size-3.5" />
                    Entfernen
                  </Button>
                )
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}

      {showTab("scripts") ? (
        <SettingsSection
          title={embedded ? "" : t("Skripte", "Scripts")}
          {...(embedded ? {} : { collapsible: sectionToggle("Skripte") })}
          headerAction={
            <div className="flex flex-wrap gap-1.5">
              {importableScripts.length > 0 ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button size="xs" variant="ghost" disabled={isSavingScripts} type="button" />
                    }
                  >
                    Aus workjet.json
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" className="w-72">
                    {importableScripts.map((fileScript) => (
                      <MenuItem
                        key={`${fileScript.name} ${fileScript.command}`}
                        onClick={() => void importFileScript(fileScript)}
                      >
                        <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{fileScript.name}</div>
                          <div className="truncate font-mono text-muted-foreground">
                            {fileScript.command}
                          </div>
                        </div>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              ) : null}
              {editorRequest === null ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={isSavingScripts}
                  onClick={() =>
                    setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })
                  }
                >
                  <PlusIcon className="size-3.5" />
                  Skript hinzufügen
                </Button>
              ) : null}
            </div>
          }
        >
          {scripts.length === 0 && editorRequest === null ? (
            <p className="px-3 py-2 text-[13.5px] text-muted-foreground sm:px-4">Keine Skripte</p>
          ) : null}
          {scripts.map((script) => {
            const shortcutLabel = shortcutLabelForCommand(
              keybindings,
              commandForProjectScript(script.id),
            );
            if (editorRequest?.scriptId === script.id) {
              return (
                <div key={script.id} className="px-3 py-2 sm:px-4">
                  <ProjectScriptEditor
                    request={editorRequest}
                    scripts={scripts}
                    onSubmit={submitScript}
                    onDelete={deleteScript}
                    onClose={() => setEditorRequest(null)}
                  />
                </div>
              );
            }
            return (
              <SettingsRow
                key={script.id}
                className="group py-2"
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <ScriptIcon
                      icon={script.icon}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="max-w-40 shrink-0 truncate">{script.name}</span>
                    <code className="min-w-0 flex-1 truncate font-mono font-normal text-muted-foreground">
                      {script.command}
                    </code>
                    {script.runOnWorktreeCreate ? (
                      <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground">
                        Einrichtung
                      </span>
                    ) : null}
                    {script.previewUrl ? (
                      <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground max-sm:hidden">
                        Vorschau
                      </span>
                    ) : null}
                  </span>
                }
                control={
                  <>
                    {shortcutLabel ? (
                      <span className="text-xs text-muted-foreground">{shortcutLabel}</span>
                    ) : null}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="shrink-0 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                      aria-label={`${script.name} bearbeiten`}
                      disabled={isSavingScripts}
                      onClick={() => setEditorRequest(editorRequestForScript(script, keybindings))}
                    >
                      <SettingsIcon className="size-3.5" />
                    </Button>
                  </>
                }
              />
            );
          })}
          {editorRequest !== null && editorRequest.scriptId === null ? (
            <div className="px-3 py-2 sm:px-4">
              <ProjectScriptEditor
                request={editorRequest}
                scripts={scripts}
                onSubmit={submitScript}
                onDelete={deleteScript}
                onClose={() => setEditorRequest(null)}
              />
            </div>
          ) : null}
          {workjetFile.status === "invalid" ? (
            <SettingsRow title="workjet.json ist ungültig" className="text-warning" />
          ) : null}
        </SettingsSection>
      ) : null}

      {showTab("general") ? (
        <SettingsSection
          title={embedded ? "" : t("Entfernen", "Remove")}
          {...(embedded ? {} : { collapsible: sectionToggle("Entfernen") })}
        >
          <SettingsRow
            title={removeLabel}
            control={
              confirmingRemoval === "project" ? (
                <InlineRemovalConfirm
                  label={removeLabel}
                  onConfirm={() => void removeMembers(group.memberProjects)}
                  onCancel={() => setConfirmingRemoval(null)}
                />
              ) : (
                <Button
                  variant="destructive-outline"
                  onClick={() => setConfirmingRemoval("project")}
                >
                  <Trash2Icon />
                  {removeLabel}
                </Button>
              )
            }
          />
        </SettingsSection>
      ) : null}
    </>
  );
  // Embedded in the project list: compact tabs, at most ~30% of the viewport, autosave (#624).
  if (!embedded) {
    return <SettingsPageContainer>{content}</SettingsPageContainer>;
  }
  return (
    <div className="space-y-2" data-workjet-project-settings-tabs="">
      <div role="tablist" className="flex gap-1 border-b border-border/60">
        {projectTabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium",
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="max-h-[30vh] overflow-y-auto pr-1">
        {content}
      </div>
    </div>
  );
}

/** Inline confirmation in place of a destructive button (never a dialog). */
function InlineRemovalConfirm({
  label,
  onConfirm,
  onCancel,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5" role="group" data-slot="row-confirm">
      <span className="text-xs text-muted-foreground">{label}?</span>
      <Button size="xs" variant="destructive" onClick={onConfirm}>
        Entfernen
      </Button>
      <Button size="xs" variant="outline" onClick={onCancel}>
        Abbrechen
      </Button>
    </div>
  );
}
