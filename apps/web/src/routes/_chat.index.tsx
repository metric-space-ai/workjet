import {
  InstanceOnboarding,
  canMountSelectedInstance,
  resolveInstanceOnboardingState,
} from "../components/ctox/InstanceOnboarding";
import { useCtoxMode } from "../components/ctox/CtoxModeShell";
import { scopeProjectRef } from "@workjet/client-runtime/environment";
import { canCreateProjectInEnvironment } from "@workjet/client-runtime/operations/projects";
import { squashAtomCommandFailure } from "@workjet/client-runtime/state/runtime";
import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_WORKJET_THREAD_CONFIG,
  ProjectId,
  type CommandId,
  type ProjectOverview,
} from "@workjet/contracts";
import {
  buildProjectGallery,
  resolveGalleryProjectHistory,
  resolveGalleryProjectStatistics,
  visibleGalleryProjects,
  type GalleryProject,
  type GalleryProjectStatistics,
} from "../projectOverview";
import { ProjectOverviewCard } from "../components/ProjectOverviewCard";
import { ConnectedProjectCalendar } from "../components/ConnectedProjectCalendar";
import { ProjectWorkspace } from "../components/ProjectWorkspace";
import { selectProjectOverviewRef, useProjectOverviewRef } from "../projectOverviewSelection";
import type { ProjectConfigurationValues } from "../components/ProjectOverviewEditor";
import {
  configureWorkjetProject,
  readWorkjetGalleryOrder,
  readWorkjetProjectKpis,
  saveWorkjetProjectKpis,
  saveWorkjetGalleryOrder,
} from "../workjetProjectControl";
import {
  createGalleryOrderWriter,
  galleryProjectIdsForSave,
  moveGalleryItem,
  orderGalleryProjects,
} from "../projectGalleryOrder";
import type { PromptedProjectKpis, ProjectKpiPromptInput } from "../projectKpis";
import { mergeProjectKpiRead, readGalleryProjectKpis } from "../projectKpiProjection";
import { SortableProjectTile } from "../components/SortableProjectTile";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { buildThreadRouteParams } from "../threadRoutes";
import { findProjectSupervisor } from "../lib/projectSupervisor";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon, RotateCcwIcon, ServerIcon } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { NoInstanceHero } from "../components/NoInstanceHero";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkjetHeaderContent } from "../components/WorkjetHeaderSlots";
import { usePrimarySettings } from "../hooks/useSettings";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import {
  useBusinessOsScopedEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
  useEnvironments,
} from "../state/environments";
import { environmentProjects, projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveNativeProjectOpening } from "../nativeProjectOpening";
import { resolveProjectTeamModelSelection } from "../providerInstances";
import { threadEnvironment } from "../state/threads";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { cn, newCommandId, newThreadId } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import {
  readWorkjetProjectRegistry,
  refreshWorkjetProjectRegistry,
  selectWorkjetProject,
  useWorkjetProjectRegistry,
} from "../workjetProjectRegistry";
import { readActiveWorkjetScope, useActiveWorkjetScope } from "../activeWorkjetScope";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments } = useBusinessOsScopedEnvironments();
  const mode = useCtoxMode();
  const onboarding = resolveInstanceOnboardingState(
    mode.discovery,
    mode.selectedId,
    mode.connection,
  );
  if (mode.bridge !== undefined && !canMountSelectedInstance(onboarding))
    return <InstanceOnboarding state={onboarding} />;

  if (authGateState.status === "hosted-static" && environments.length === 0) {
    return <HostedStaticOnboardingState />;
  }

  return <IndexDraftLanding />;
}

/**
 * Opens a selected project overview; its retained supervisor is created through
 * the existing durable command path, and only a chat click opens the composer.
 */
function IndexDraftLanding() {
  const projects = useProjects();
  const computers = usePrimarySettings((settings) => settings.workjet.computers);
  const { selectedInstanceId: activeCtoxInstanceId } = useActiveWorkjetScope();
  const registry = useWorkjetProjectRegistry(activeCtoxInstanceId);
  const projectStore = useContext(RegistryContext);
  const primaryEnvironment = usePrimaryEnvironment();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const openingNative = useRef(false);
  const [meetingProjectKey, setMeetingProjectKey] = useState<string | null>(null);
  const automaticNativeAttempt = useRef<string | null>(null);
  const nativeAttempt = useRef<{
    key: string;
    commandId: CommandId;
    threadId: ReturnType<typeof newThreadId>;
  } | null>(null);
  const [nativeOpenState, setNativeOpenState] = useState({
    pending: false,
    error: null as string | null,
  });
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const navigate = useNavigate();
  const selectedLegacyProject = useProjectOverviewRef(activeCtoxInstanceId);
  const selectedNative =
    registry.projects.find((project) => project.id === registry.selectedProjectId) ?? null;
  const galleryProjects = useMemo(
    () =>
      buildProjectGallery({
        projects: sortScopedProjectsForSidebar(projects, threads, "updated_at"),
        nativeProjects: registry.projects,
        instanceId: activeCtoxInstanceId,
        primaryEnvironmentId,
        computers,
      }),
    [projects, threads, registry.projects, activeCtoxInstanceId, primaryEnvironmentId, computers],
  );
  useEffect(() => {
    setNativeOpenState({ pending: openingNative.current, error: null });
  }, [activeCtoxInstanceId, selectedNative?.id]);
  const landingProject = useMemo(() => {
    if (!bootstrapped) return null;
    const ordered = sortScopedProjectsForSidebar(projects, threads, "updated_at");
    if (selectedNative !== null)
      return resolveGalleryProjectHistory(ordered, galleryProjects, selectedNative.id);
    if (selectedLegacyProject === null) return null;
    const local =
      ordered.find(
        (project) =>
          project.id === selectedLegacyProject.projectId &&
          project.environmentId === selectedLegacyProject.environmentId,
      ) ?? null;
    return local !== null &&
      (activeCtoxInstanceId === null
        ? local.ctoxRegistration == null
        : local.ctoxRegistration?.instanceId === activeCtoxInstanceId)
      ? local
      : null;
  }, [
    activeCtoxInstanceId,
    bootstrapped,
    galleryProjects,
    projects,
    selectedLegacyProject,
    selectedNative,
    threads,
  ]);
  const supervisor =
    landingProject === null
      ? null
      : findProjectSupervisor(
          threads,
          scopeProjectRef(landingProject.environmentId, landingProject.id),
        );

  const openNativeSupervisor = useCallback(
    async (nativeProject = selectedNative, overview?: ProjectOverview): Promise<boolean> => {
      if (openingNative.current || nativeProject === null || activeCtoxInstanceId === null)
        return false;
      const instanceId = activeCtoxInstanceId;
      const scope = readActiveWorkjetScope();
      if (scope.selectedInstanceId !== instanceId) return false;
      const currentProjects = projectStore.get(environmentProjects.projectsAtom);
      const plan = resolveNativeProjectOpening({
        instanceId,
        project: nativeProject,
        localEnvironmentId: primaryEnvironmentId,
        localConnected:
          bootstrapped && canCreateProjectInEnvironment(primaryEnvironment?.connection.phase),
        projects: currentProjects,
        gallery: buildProjectGallery({
          projects: sortScopedProjectsForSidebar(currentProjects, threads, "updated_at"),
          nativeProjects: registry.projects,
          instanceId,
          primaryEnvironmentId,
          computers,
        }),
      });
      if (plan._tag === "blocked") {
        setNativeOpenState({ pending: false, error: plan.message });
        return false;
      }
      const needsSupervisor =
        plan._tag === "existing" &&
        overview === undefined &&
        findProjectSupervisor(
          threads,
          scopeProjectRef(plan.project.environmentId, plan.project.id),
        ) === null;
      if (plan._tag === "existing" && overview === undefined && !needsSupervisor) return true;
      const target =
        plan._tag === "existing"
          ? {
              environmentId: plan.project.environmentId,
              projectId: plan.project.id,
              title: nativeProject.title,
            }
          : plan;
      const key = JSON.stringify([instanceId, target.environmentId, target.projectId]);
      if (nativeAttempt.current?.key !== key)
        nativeAttempt.current = { key, commandId: newCommandId(), threadId: newThreadId() };
      const commandId = nativeAttempt.current.commandId;
      openingNative.current = true;
      setNativeOpenState({ pending: true, error: null });
      try {
        const modelSelection = resolveProjectTeamModelSelection(
          environments.find((environment) => environment.environmentId === target.environmentId)
            ?.serverConfig?.providers ?? [],
        );
        if ((plan._tag === "create" || needsSupervisor) && modelSelection === null)
          throw new Error(
            "Configure an available gpt-6.1-sol model in Models to create this project’s Lumas.",
          );
        if (plan._tag === "create") {
          const result = await createProject({
            environmentId: target.environmentId,
            input: {
              projectId: target.projectId,
              commandId,
              title: target.title,
              workspaceRoot: null,
              ctoxRegistration: { instanceId, commandId, status: "pending" },
              defaultModelSelection: modelSelection,
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
        if (needsSupervisor && modelSelection !== null) {
          const threadId = nativeAttempt.current.threadId;
          const createdAt = new Date().toISOString();
          const result = await createThread({
            environmentId: target.environmentId,
            input: {
              threadId,
              projectId: target.projectId,
              title: "Project supervisor",
              modelSelection,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: "default",
              workjetConfig: {
                ...DEFAULT_WORKJET_THREAD_CONFIG,
                role: "orchestrator",
                team: {
                  role: "supervisor",
                  projectId: target.projectId,
                  threadId,
                  parentThreadId: null,
                  goal: `Coordinate the goals of ${target.title}`,
                  createdAt,
                },
              },
              branch: null,
              worktreePath: null,
              createdAt,
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
        if (overview !== undefined) {
          const saved = await updateProject({
            environmentId: target.environmentId,
            input: { projectId: target.projectId, overview },
          });
          if (saved._tag === "Failure") throw squashAtomCommandFailure(saved);
        }
        return true;
      } catch (error) {
        if (
          readActiveWorkjetScope().selectionRevision === scope.selectionRevision &&
          readWorkjetProjectRegistry(instanceId).selectedProjectId === nativeProject.id
        )
          setNativeOpenState({
            pending: false,
            error:
              error instanceof Error ? error.message : "Couldn’t open this supervisor. Try again.",
          });
        return false;
      } finally {
        openingNative.current = false;
        setNativeOpenState((state) => ({ ...state, pending: false }));
      }
    },
    [
      activeCtoxInstanceId,
      bootstrapped,
      computers,
      createProject,
      createThread,
      environments,
      primaryEnvironment?.connection.phase,
      primaryEnvironmentId,
      projectStore,
      registry.projects,
      selectedNative,
      threads,
      updateProject,
    ],
  );

  useEffect(() => {
    if (selectedNative === null) {
      automaticNativeAttempt.current = null;
      return;
    }
    if (!bootstrapped || supervisor !== null || openingNative.current) return;
    const key = JSON.stringify([activeCtoxInstanceId, selectedNative.id]);
    if (automaticNativeAttempt.current === key) return;
    automaticNativeAttempt.current = key;
    void openNativeSupervisor(selectedNative);
  }, [
    activeCtoxInstanceId,
    bootstrapped,
    nativeOpenState.pending,
    openNativeSupervisor,
    primaryEnvironment?.connection.phase,
    selectedNative,
    supervisor,
  ]);

  if (landingProject !== null && !(selectedNative !== null && supervisor === null)) {
    const project = galleryProjects.find(
      (candidate) =>
        candidate.local?.id === landingProject.id &&
        candidate.local.environmentId === landingProject.environmentId,
    );
    if (project)
      return (
        <ProjectWorkspace
          project={project}
          ctoxInstanceId={activeCtoxInstanceId}
          openMeeting={meetingProjectKey === project.key}
          threads={threads}
          onAddParent={async (domain, goal) => {
            if (
              !supervisor ||
              supervisor.workjetConfig.schemaVersion !== 2 ||
              supervisor.workjetConfig.team?.role !== "supervisor" ||
              readActiveWorkjetScope().selectedInstanceId !== activeCtoxInstanceId
            )
              return false;
            const modelSelection = resolveProjectTeamModelSelection(
              environments.find(
                (environment) => environment.environmentId === supervisor.environmentId,
              )?.serverConfig?.providers ?? [],
            );
            if (!modelSelection) return false;
            const threadId = newThreadId();
            const createdAt = new Date().toISOString();
            const result = await createThread({
              environmentId: supervisor.environmentId,
              input: {
                threadId,
                projectId: supervisor.projectId,
                title: domain,
                modelSelection,
                runtimeMode: supervisor.runtimeMode,
                interactionMode: "default",
                workjetConfig: {
                  ...supervisor.workjetConfig,
                  role: "orchestrator",
                  parent: null,
                  team: {
                    role: "specialist",
                    projectId: supervisor.projectId,
                    threadId,
                    parentThreadId: supervisor.id,
                    domain,
                    goal,
                    createdAt,
                  },
                },
                branch: null,
                worktreePath: null,
                createdAt,
              },
            });
            return result._tag === "Success";
          }}
          onOpenChat={(thread) =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(thread),
            })
          }
        />
      );
  }
  if (selectedNative !== null)
    return (
      <WorkjetProjectOpening
        projectTitle={selectedNative.title}
        onOpenSupervisor={() => void openNativeSupervisor()}
        pending={nativeOpenState.pending}
        error={nativeOpenState.error}
      />
    );
  if (galleryProjects.length > 0)
    return (
      <ProjectGallery
        key={activeCtoxInstanceId ?? "local"}
        instanceId={activeCtoxInstanceId}
        onRefresh={
          activeCtoxInstanceId === null
            ? undefined
            : () => refreshWorkjetProjectRegistry(activeCtoxInstanceId)
        }
        projectsUnavailable={registry.phase === "blocked" || registry.refreshFailed === true}
        projects={galleryProjects.map((project) => ({
          ...project,
          statistics: resolveGalleryProjectStatistics(project, threads, bootstrapped),

          canArchive: environments.some(
            (environment) =>
              environment.environmentId ===
                (project.local?.environmentId ?? primaryEnvironmentId) &&
              environment.connection.phase === "connected" &&
              environment.serverConfig?.projectArchive === true,
          ),
          onSaveConfiguration:
            project.configuration && activeCtoxInstanceId !== null
              ? async (values: ProjectConfigurationValues) => {
                  if (
                    readActiveWorkjetScope().selectedInstanceId !== activeCtoxInstanceId ||
                    !project.configuration
                  )
                    return false;
                  const result = await configureWorkjetProject(activeCtoxInstanceId, {
                    action: "project.configure",
                    commandId: newCommandId(),
                    projectId: project.configuration.id,
                    title: project.title,
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
                }
              : undefined,
          onOpenJourFixe: project.native
            ? () => {
                if (
                  readActiveWorkjetScope().selectedInstanceId !== activeCtoxInstanceId ||
                  activeCtoxInstanceId === null
                )
                  return;
                setMeetingProjectKey(project.key);
                if (selectWorkjetProject(activeCtoxInstanceId, project.id))
                  selectProjectOverviewRef(activeCtoxInstanceId, null);
              }
            : undefined,
          onOpen: () => {
            setMeetingProjectKey(null);
            if (readActiveWorkjetScope().selectedInstanceId !== activeCtoxInstanceId) return;
            if (project.native && activeCtoxInstanceId !== null) {
              if (selectWorkjetProject(activeCtoxInstanceId, project.id))
                selectProjectOverviewRef(activeCtoxInstanceId, null);
            } else if (project.local !== null)
              selectProjectOverviewRef(
                activeCtoxInstanceId,
                scopeProjectRef(project.local.environmentId, project.local.id),
              );
          },
          onSave: (
            project.local === null
              ? !project.native ||
                !bootstrapped ||
                primaryEnvironment?.serverConfig?.projectOverview !== true ||
                !canCreateProjectInEnvironment(primaryEnvironment?.connection.phase)
              : !environments.some(
                  (environment) =>
                    environment.environmentId === project.local?.environmentId &&
                    environment.connection.phase === "connected" &&
                    environment.serverConfig?.projectOverview === true,
                )
          )
            ? undefined
            : async (overview: ProjectOverview) => {
                const local = project.local;
                if (readActiveWorkjetScope().selectedInstanceId !== activeCtoxInstanceId)
                  return false;
                if (local === null) {
                  const nativeProject = registry.projects.find(
                    (candidate) => candidate.id === project.id,
                  );
                  return nativeProject === undefined
                    ? false
                    : openNativeSupervisor(nativeProject, overview);
                }
                const result = await updateProject({
                  environmentId: local.environmentId,
                  input: { projectId: local.id, overview },
                });
                return result._tag === "Success";
              },
        }))}
      />
    );
  if (activeCtoxInstanceId === null && bootstrapped) return <NoInstanceHero />;
  if ((!bootstrapped && registry.phase !== "ready") || registry.phase === "loading") return null;
  if (registry.phase === "blocked")
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Couldn’t load projects</EmptyTitle>
            <EmptyDescription>Reconnect to this instance to load your projects.</EmptyDescription>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => refreshWorkjetProjectRegistry(activeCtoxInstanceId)}>
                <RotateCcwIcon className="size-4" />
                Refresh projects
              </Button>
              <Button render={<Link to="/settings/computers" />} size="sm">
                Open Computers
              </Button>
            </div>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  return <NoProjectsHero />;
}

function ProjectGallery({
  projects,
  instanceId,
  onRefresh,
  projectsUnavailable,
}: {
  readonly instanceId: string | null;
  readonly onRefresh: (() => void) | undefined;
  readonly projectsUnavailable: boolean;
  readonly projects: readonly (GalleryProject & {
    readonly onOpen: () => void;
    readonly onOpenJourFixe?: (() => void) | undefined;
    readonly onSaveConfiguration?:
      | ((next: ProjectConfigurationValues) => Promise<boolean>)
      | undefined;
    readonly canArchive: boolean;
    readonly statistics: GalleryProjectStatistics;
    readonly onSave?: ((next: ProjectOverview) => Promise<boolean>) | undefined;
  })[];
}) {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const [showArchived, setShowArchived] = useState(false);
  const [view, setView] = useState<"gallery" | "calendar">("gallery");
  const [galleryOrder, setGalleryOrder] = useState<{
    readonly revision: number;
    readonly projectIds: readonly string[];
  }>({ revision: 0, projectIds: [] });
  const galleryOrderRef = useRef(galleryOrder);
  const orderWriter = useRef<ReturnType<typeof createGalleryOrderWriter> | null>(null);
  const [orderLoaded, setOrderLoaded] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [kpiProjection, setKpiProjection] = useState<{
    readonly instanceId: string | null;
    readonly records: Readonly<Record<string, PromptedProjectKpis>>;
  }>({ instanceId: null, records: {} });
  const kpiScope = useRef<{ instanceId: string | null; active: boolean }>({
    instanceId: null,
    active: false,
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const visibleProjects = useMemo(
    () =>
      orderGalleryProjects(visibleGalleryProjects(projects, showArchived), galleryOrder.projectIds),
    [projects, showArchived, galleryOrder.projectIds],
  );
  const nativeProjectIds = useMemo(
    () =>
      visibleProjects
        .filter((project) => project.native)
        .map((project) => project.id)
        .join("\n"),
    [visibleProjects],
  );

  useEffect(() => {
    if (instanceId === null) return;
    const writer = createGalleryOrderWriter({
      current: () => galleryOrderRef.current,
      persist: async (previous, projectIds) => {
        const result = await saveWorkjetGalleryOrder(instanceId, {
          commandId: newCommandId(),
          operationId: newCommandId(),
          expectedRevision: previous.revision,
          projectIds: projectIds.map((id) => ProjectId.make(id)),
        });
        return result._tag === "completed" && "order" in result.response
          ? result.response.order
          : null;
      },
      apply: (next) => {
        galleryOrderRef.current = next;
        setGalleryOrder(next);
      },
      pending: setSavingOrder,
    });
    orderWriter.current = writer;
    return () => {
      writer.dispose();
      if (orderWriter.current === writer) orderWriter.current = null;
    };
  }, [instanceId]);

  useEffect(() => {
    if (instanceId === null) return;
    let cancelled = false;
    void readWorkjetGalleryOrder(instanceId, newCommandId()).then((result) => {
      if (cancelled || result._tag !== "completed" || !("order" in result.response)) return;
      const next = {
        revision: result.response.order.revision,
        projectIds: result.response.order.projectIds,
      };
      galleryOrderRef.current = next;
      setGalleryOrder(next);
      setOrderLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  const readKpis = useCallback(
    async (projectId: string) => {
      const scope = kpiScope.current;
      if (
        instanceId === null ||
        !scope.active ||
        scope.instanceId !== instanceId ||
        !nativeProjectIds.split("\n").includes(projectId)
      )
        return null;
      const result = await readWorkjetProjectKpis(
        instanceId,
        ProjectId.make(projectId),
        newCommandId(),
      );
      if (
        !scope.active ||
        kpiScope.current !== scope ||
        result._tag !== "completed" ||
        !("kpis" in result.response)
      )
        return null;
      const kpis = result.response.kpis;
      setKpiProjection((previous) => mergeProjectKpiRead(previous, instanceId, projectId, kpis));
      return kpis;
    },
    [instanceId, nativeProjectIds],
  );

  useEffect(() => {
    if (instanceId === null) return;
    const scope = { instanceId, active: true };
    kpiScope.current = scope;
    const projectIds = nativeProjectIds === "" ? [] : nativeProjectIds.split("\n");
    void readGalleryProjectKpis(projectIds, readKpis, () => scope.active);
    return () => {
      scope.active = false;
    };
  }, [instanceId, nativeProjectIds, readKpis]);

  const saveKpis = useCallback(
    async (
      projectId: string,
      prompts: readonly ProjectKpiPromptInput[],
      expectedRevision: number,
    ) => {
      const scope = kpiScope.current;
      if (
        instanceId === null ||
        !scope.active ||
        scope.instanceId !== instanceId ||
        !nativeProjectIds.split("\n").includes(projectId)
      )
        return false;
      const kpis = await saveWorkjetProjectKpis(instanceId, {
        action: "project.kpis.configure",
        commandId: newCommandId(),
        operationId: newCommandId(),
        projectId: ProjectId.make(projectId),
        expectedRevision,
        prompts,
      });
      if (!kpis || !scope.active || kpiScope.current !== scope) return false;
      setKpiProjection((previous) =>
        previous.instanceId === instanceId
          ? { instanceId, records: { ...previous.records, [projectId]: kpis } }
          : previous,
      );
      return true;
    },
    [instanceId, nativeProjectIds],
  );

  const reorderProjects = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (
        instanceId === null ||
        !orderLoaded ||
        showArchived ||
        over === null ||
        active.id === over.id
      )
        return;
      const from = visibleProjects.findIndex((project) => project.key === active.id);
      const to = visibleProjects.findIndex((project) => project.key === over.id);
      if (from < 0 || to < 0) return;
      const projectIds = galleryProjectIdsForSave(moveGalleryItem(visibleProjects, from, to));
      void orderWriter.current?.save(projectIds);
    },
    [instanceId, orderLoaded, showArchived, visibleProjects],
  );
  const archivedCount = visibleGalleryProjects(projects, true).length;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <main className="flex-1 overflow-auto px-5 py-6 sm:px-6" data-workjet-project-gallery="">
        <div className="mx-auto max-w-6xl">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">
                {showArchived ? "Archived projects" : "All projects"}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">Choose a project to continue.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowArchived((show) => !show)}>
                {showArchived ? "All projects" : `Archived projects (${archivedCount})`}
              </Button>
              {onRefresh ? (
                <Button size="sm" variant="outline" onClick={onRefresh}>
                  <RotateCcwIcon className="size-4" />
                  Refresh projects
                </Button>
              ) : null}
              <Button size="sm" onClick={openAddProject}>
                <PlusIcon className="size-4" />
                Add project
              </Button>
            </div>
          </div>
          <div
            className="mb-5 inline-flex gap-1 rounded-md border border-border p-1"
            aria-label="Project view"
          >
            <Button
              size="sm"
              variant={view === "gallery" ? "secondary" : "ghost"}
              aria-pressed={view === "gallery"}
              data-workjet-action="project.view.gallery"
              onClick={() => setView("gallery")}
            >
              Projects
            </Button>
            <Button
              size="sm"
              variant={view === "calendar" ? "secondary" : "ghost"}
              aria-pressed={view === "calendar"}
              data-workjet-action="project.view.calendar"
              onClick={() => setView("calendar")}
            >
              Calendar
            </Button>
          </div>
          {projectsUnavailable ? (
            <div
              role="status"
              className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
              data-workjet-project-registry-stale=""
            >
              <span>Project list is out of date</span>
              {onRefresh && (
                <Button size="sm" variant="ghost" onClick={onRefresh}>
                  Refresh
                </Button>
              )}
            </div>
          ) : null}
          {view === "calendar" ? (
            <ConnectedProjectCalendar projects={visibleProjects} />
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={reorderProjects}
            >
              <SortableContext
                items={visibleProjects.map((project) => project.key)}
                strategy={rectSortingStrategy}
              >
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-4">
                  {visibleProjects.map((project) => (
                    <SortableProjectTile
                      key={project.key}
                      id={project.key}
                      label={project.title}
                      disabled={!project.native || !orderLoaded || savingOrder || showArchived}
                    >
                      {(reorderHandle) => (
                        <ProjectOverviewCard
                          project={project}
                          onOpen={project.onOpen}
                          onSave={project.onSave}
                          onSaveConfiguration={project.onSaveConfiguration}
                          canArchive={project.canArchive}
                          statistics={project.statistics}
                          kpis={
                            kpiProjection.instanceId === instanceId
                              ? kpiProjection.records[project.id]
                              : undefined
                          }
                          onSaveKpis={
                            project.native && instanceId !== null
                              ? (prompts, revision) => saveKpis(project.id, prompts, revision)
                              : undefined
                          }
                          onReadKpis={project.native && instanceId !== null ? readKpis : undefined}
                          reorderHandle={reorderHandle}
                        />
                      )}
                    </SortableProjectTile>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </main>
    </SidebarInset>
  );
}

function WorkjetProjectOpening({
  projectTitle,
  onOpenSupervisor,
  pending,
  error,
}: {
  readonly projectTitle: string;
  readonly onOpenSupervisor: () => void;
  readonly pending: boolean;
  readonly error: string | null;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1" data-workjet-project-state={error ? "opening-error" : "opening"}>
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">{projectTitle}</EmptyTitle>
          {!error && (
            <p role="status" className="mt-2 text-sm text-muted-foreground/78">
              Opening supervisor…
            </p>
          )}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {error && (
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button
                size="sm"
                onClick={onOpenSupervisor}
                disabled={pending}
                data-workjet-action="project.open.supervisor"
              >
                {pending ? "Opening supervisor…" : "Retry opening supervisor"}
              </Button>
              <Button render={<Link to="/settings/computers" />} size="sm">
                <ServerIcon className="size-4" />
                Choose computer
              </Button>
            </div>
          )}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function NoProjectsHero() {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Workjet Collective
              </p>
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                Your instance is ready.
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Create your first project by name. Its supervisor keeps your work together; you can
                attach a computer and working copy later.
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button size="sm" data-workjet-action="project.add.hero" onClick={openAddProject}>
                  <PlusIcon className="size-4" />
                  Add project
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkjetHeaderContent
          className={cn(
            "workspace-topbar border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkjetHeaderContent>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect an environment to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {cloudEnabled
                  ? "Sign in to Workjet Connect to connect a linked environment through its managed tunnel, or add a reachable backend manually."
                  : "Add a reachable backend manually to start working from this browser."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/computers" />} size="sm">
                  <PlusIcon className="size-4" />
                  {cloudEnabled ? "Open Computers" : "Add computer"}
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
