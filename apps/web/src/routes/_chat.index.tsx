import { workjetUiLanguage } from "../workjetProjectControl";
import {
  InstanceOnboarding,
  canMountSelectedInstance,
  resolveInstanceOnboardingState,
} from "../components/ctox/InstanceOnboarding";
import { canActivateCtoxInstance, useCtoxMode } from "../components/ctox/CtoxModeShell";
import { ctoxInstanceDisplayTitle } from "../components/ctox/ctoxInstanceDisplayTitle";
import { scopeProjectRef } from "@workjet/client-runtime/environment";
import { canCreateProjectInEnvironment } from "@workjet/client-runtime/operations/projects";
import { squashAtomCommandFailure } from "@workjet/client-runtime/state/runtime";
import { RegistryContext } from "@effect/atom-react";
import {
  ProjectId,
  type CommandId,
  type CtoxDiscoveryResult,
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
import type { ProjectCardConfigurationValues } from "../components/ProjectOverviewEditor";
import { ProjectTokenBudget } from "../components/ProjectTokenBudget";
import { ConnectedProjectCalendar } from "../components/ConnectedProjectCalendar";
import { ProjectWorkspace } from "../components/ProjectWorkspace";
import { selectProjectOverviewRef, useProjectOverviewRef } from "../projectOverviewSelection";
import {
  configureWorkjetProject,
  describeWorkjetProjectControlFailure,
  readWorkjetGalleryOrder,
  refreshWorkjetProjectKpis,
  saveWorkjetProjectKpis,
  saveWorkjetGalleryOrder,
} from "../workjetProjectControl";
import {
  createGalleryOrderWriter,
  galleryProjectIdsForSave,
  moveGalleryItem,
  orderGalleryProjects,
} from "../projectGalleryOrder";
import type { ProjectKpiPromptInput, PromptedProjectKpis } from "../projectKpis";
import { mergeProjectKpiRead } from "../projectKpiProjection";
import { useWorkjetProjectKpis } from "../ctox/useWorkjetProjectKpis";
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
import { findProjectSupervisor, projectSupervisorThreadInput } from "../lib/projectSupervisor";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon, ServerIcon } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { consumeProjectCreateRequest, onProjectCreateRequest } from "../commandPaletteBus";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { InlinePanel } from "../components/ui/inline-panel";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyLoading,
  EmptyTitle,
} from "../components/ui/empty";
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
import { nativeOpenAttemptKey, resolveNativeProjectOpening } from "../nativeProjectOpening";
import {
  resolveDefaultProviderModelSelection,
  resolveProjectTeamModelSelection,
} from "../providerInstances";
import { createPersistentWorkerConfig } from "./-projectWorkerConfig";
import {
  ProjectCloneFields,
  ProjectComputerSelect,
  ProjectCreateRequirementLine,
  ProjectCreateSourceSegment,
  ProjectFolderFields,
} from "../components/ProjectCreateSources";
import {
  defaultCloneBaseDirectory,
  knownCloneTargetFolders,
  type ProjectCreateSource,
} from "../components/ProjectCreateSources.logic";
import { useProjectCreateSources } from "../components/useProjectCreateSources";
import { threadEnvironment } from "../state/threads";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { cn, newCommandId, newProjectId, newThreadId } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import {
  readWorkjetProjectRegistry,
  refreshWorkjetProjectRegistry,
  selectWorkjetProject,
  useWorkjetProjectRegistry,
} from "../workjetProjectRegistry";
import { useUiText } from "../hooks/useUiText";
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
          projects.find(
            (project) =>
              project.id === target.projectId && project.environmentId === target.environmentId,
          )?.defaultModelSelection,
        );
        if ((plan._tag === "create" || needsSupervisor) && modelSelection === null)
          throw new Error(MODEL_ACCOUNT_MISSING);
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
            input: projectSupervisorThreadInput({
              threadId,
              projectId: target.projectId,
              title: target.title,
              modelSelection,
              createdAt,
            }),
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
        if (overview !== undefined) {
          const saved = await updateProject({
            environmentId: target.environmentId,
            input: {
              projectId: target.projectId,
              overview,
              expectedTokenBudgetRevision: overview.tokenBudget?.revision ?? 0,
            },
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
            error: error instanceof Error ? error.message : "Supervisor nicht geöffnet.",
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
    // Desktop registers the local environment only after its backend is up. An attempt
    // made before that is repeated once it is connected instead of parking on "blocked" (#492).
    const key = nativeOpenAttemptKey(
      activeCtoxInstanceId,
      selectedNative.id,
      primaryEnvironmentId,
      primaryEnvironment?.connection.phase,
    );
    if (automaticNativeAttempt.current === key) return;
    automaticNativeAttempt.current = key;
    void openNativeSupervisor(selectedNative);
  }, [
    activeCtoxInstanceId,
    bootstrapped,
    nativeOpenState.pending,
    openNativeSupervisor,
    primaryEnvironment?.connection.phase,
    primaryEnvironmentId,
    selectedNative,
    supervisor,
  ]);

  // Without a model account no Supervisor can start, but the project stays
  // usable: history, organigram and settings open with a compact notice (QA 0.0.95 F).
  const modelAccountMissing =
    nativeOpenState.error === MODEL_ACCOUNT_MISSING && !nativeOpenState.pending;
  if (
    landingProject !== null &&
    (!(selectedNative !== null && supervisor === null) || modelAccountMissing)
  ) {
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
          {...(modelAccountMissing ? { notice: <ModelAccountMissingNotice /> } : {})}
          onOpenPullRequests={() =>
            void navigate({
              to: "/pull-requests",
              search: {
                involvement: "all",
                state: "open",
                projectId: landingProject.id,
                environmentId: landingProject.environmentId,
              },
            })
          }
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
              supervisor.modelSelection,
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
                workjetConfig: createPersistentWorkerConfig({
                  supervisorConfig: supervisor.workjetConfig,
                  projectId: supervisor.projectId,
                  supervisorThreadId: supervisor.id,
                  threadId,
                  domain,
                  goal,
                  createdAt,
                }),
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
        registryStatus={
          registry.refreshError
            ? describeWorkjetProjectControlFailure(registry.refreshError, activeCtoxInstanceId)
            : undefined
        }
        lastUpdatedAt={registry.lastUpdatedAt}
        projectsUnavailable={showsCachedProjectRegistryNotice(registry)}
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
          // „Projekt konfigurieren“ bleibt in der Karte: derselbe Speicherpfad
          // (project.configure) wie Einstellungen › Projekt, keine Navigation.
          onSaveConfiguration:
            project.configuration !== undefined && activeCtoxInstanceId !== null
              ? async (values) => {
                  const configuration = project.configuration;
                  if (configuration === undefined || activeCtoxInstanceId === null) return false;
                  if (readActiveWorkjetScope().selectedInstanceId !== activeCtoxInstanceId)
                    return false;
                  const result = await configureWorkjetProject(activeCtoxInstanceId, {
                    action: "project.configure",
                    commandId: newCommandId(),
                    projectId: configuration.id,
                    title: values.title,
                    repoUrl: values.repositoryUrl,
                    publicUrl: values.websiteUrl,
                    info: configuration.info ?? null,
                    jourFixe: values.jourFixe,
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
              openCreatedProject(
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
                  input: {
                    projectId: local.id,
                    overview,
                    expectedTokenBudgetRevision: overview.tokenBudget?.revision ?? 0,
                  },
                });
                return result._tag === "Success";
              },
        }))}
      />
    );
  if (activeCtoxInstanceId === null && bootstrapped) return <NoInstanceHero />;
  if ((!bootstrapped && registry.phase !== "ready") || registry.phase === "loading")
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <EmptyLoading
          className="flex-1"
          title="Projekte werden geladen …"
          slowMessage="Projekte noch nicht geladen"
          onRetry={() => refreshWorkjetProjectRegistry(activeCtoxInstanceId)}
        />
      </SidebarInset>
    );
  if (registry.phase === "blocked")
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
        <Empty className="flex-1" data-workjet-project-state="blocked">
          <EmptyHeader>
            <EmptyTitle className="text-[22px]">Projekte nicht geladen</EmptyTitle>
            <EmptyDescription className="text-xs">
              {registry.refreshError
                ? describeWorkjetProjectControlFailure(registry.refreshError, activeCtoxInstanceId)
                : "Instanz nicht erreichbar"}
            </EmptyDescription>
          </EmptyHeader>
          <Button
            size="sm"
            variant="outline"
            data-workjet-action="project.registry.retry"
            onClick={() => refreshWorkjetProjectRegistry(activeCtoxInstanceId)}
          >
            Erneut versuchen
          </Button>
        </Empty>
      </SidebarInset>
    );
  return <NoProjectsHero />;
}

/**
 * Die ruhige Zeile nur, wenn die Karten wirklich der letzte gespeicherte Stand sind.
 * Ein noch laufender Read und ein einzelner Zeitüberschreitungs-Read zeigen nichts:
 * die Liste ist dann nicht als veralteter Cache bestätigt.
 */
export function showsCachedProjectRegistryNotice(registry: {
  readonly refreshFailed?: boolean | undefined;
  readonly lastUpdatedAt?: number | undefined;
  readonly projects: readonly unknown[];
  readonly refreshError?:
    | {
        readonly code?: string;
        readonly diagnostic?: { readonly reason?: string } | undefined;
        readonly preparation?: { readonly reason?: string } | undefined;
      }
    | undefined;
}): boolean {
  if (registry.refreshFailed !== true) return false;
  if (registry.lastUpdatedAt === undefined || registry.projects.length === 0) return false;
  const error = registry.refreshError;
  if (
    error?.code === "timeout" ||
    error?.diagnostic?.reason === "request_timeout" ||
    error?.preparation?.reason === "navigation_timeout"
  )
    return false;
  return true;
}

export function ProjectGallery({
  projects,
  instanceId,
  registryStatus,
  lastUpdatedAt,
  projectsUnavailable,
  createForm,
}: {
  readonly instanceId: string | null;
  readonly registryStatus: string | undefined;
  readonly lastUpdatedAt: number | undefined;
  readonly projectsUnavailable: boolean;
  readonly projects: readonly (GalleryProject & {
    readonly onOpen: () => void;
    readonly onOpenJourFixe?: (() => void) | undefined;
    readonly onSaveConfiguration?:
      | ((values: ProjectCardConfigurationValues) => Promise<boolean>)
      | undefined;
    readonly canArchive: boolean;
    readonly statistics: GalleryProjectStatistics;
    readonly onSave?: ((next: ProjectOverview) => Promise<boolean>) | undefined;
  })[];
  /** Ersetzt „Projekt anlegen“. `null` lässt die Zeile weg (Tests, Einbettung). */
  readonly createForm?: ReactNode;
}) {
  const t = useUiText();
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
  const [kpiFailures, setKpiFailures] = useState<ReadonlySet<string>>(() => new Set());
  const kpiFailuresRef = useRef<ReadonlySet<string>>(kpiFailures);
  const [kpiProjection, setKpiProjection] = useState<{
    readonly instanceId: string | null;
    readonly records: Readonly<Record<string, PromptedProjectKpis>>;
  }>({ instanceId: null, records: {} });
  const kpiScope = useRef<{ instanceId: string | null; active: boolean }>({
    instanceId: null,
    active: false,
  });
  const markKpiFailure = useCallback((projectId: string, failed: boolean) => {
    const previous = kpiFailuresRef.current;
    if (failed === previous.has(projectId)) return;
    const next = new Set(previous);
    if (failed) next.add(projectId);
    else next.delete(projectId);
    kpiFailuresRef.current = next;
    setKpiFailures(next);
  }, []);
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

  const localKpis = useWorkjetProjectKpis(instanceId, nativeProjectIds);
  const readKpis = localKpis.readKpis;
  useEffect(() => {
    const scope = { instanceId, active: true };
    kpiScope.current = scope;
    return () => {
      scope.active = false;
    };
  }, [instanceId]);
  useEffect(() => {
    if (instanceId === null) return;
    setKpiProjection((previous) => {
      const retained = previous.instanceId === instanceId ? previous.records : {};
      let next: typeof previous = {
        instanceId,
        records: Object.fromEntries(
          Object.entries(retained).filter(([id]) => id in localKpis.records),
        ),
      };
      for (const [id, kpis] of Object.entries(localKpis.records))
        next = mergeProjectKpiRead(next, instanceId, id, kpis);
      return next;
    });
    for (const id of nativeProjectIds.split("\n").filter(Boolean))
      markKpiFailure(id, !localKpis.available);
  }, [instanceId, localKpis.records, localKpis.available, nativeProjectIds, markKpiFailure]);

  // Inline KPI edit and recalculation on the card write straight into the projection.
  const saveKpis = useCallback(
    async (
      projectId: string,
      prompts: readonly ProjectKpiPromptInput[],
      expectedRevision: number,
    ) => {
      const scope = kpiScope.current;
      if (instanceId === null || !scope.active || scope.instanceId !== instanceId) return false;
      const saved = await saveWorkjetProjectKpis(instanceId, {
        action: "project.kpis.configure",
        commandId: newCommandId(),
        projectId: ProjectId.make(projectId),
        operationId: newCommandId(),
        expectedRevision,
        prompts: [...prompts],
      });
      if (saved === null || !scope.active || kpiScope.current !== scope) return false;
      setKpiProjection((previous) => mergeProjectKpiRead(previous, instanceId, projectId, saved));
      return true;
    },
    [instanceId],
  );
  const refreshKpis = useCallback(
    async (projectId: string) => {
      const scope = kpiScope.current;
      if (instanceId === null || !scope.active || scope.instanceId !== instanceId) return false;
      const kpis = await refreshWorkjetProjectKpis(instanceId, ProjectId.make(projectId));
      if (kpis === null || !scope.active || kpiScope.current !== scope) return false;
      setKpiProjection((previous) => mergeProjectKpiRead(previous, instanceId, projectId, kpis));
      return true;
    },
    [instanceId],
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
          <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
            {/* No visible page title: the pressed view switch already says where you are (#576). */}
            <h1 className="sr-only">
              {showArchived
                ? t("Archivierte Projekte", "Archived projects")
                : t("Alle Projekte", "All projects")}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="inline-flex gap-1 rounded-md border border-border p-1"
                role="group"
                aria-label={t("Projektansicht", "Project view")}
              >
                <Button
                  size="sm"
                  variant={view === "gallery" && !showArchived ? "secondary" : "ghost"}
                  aria-pressed={view === "gallery" && !showArchived}
                  data-workjet-action="project.view.gallery"
                  onClick={() => {
                    setShowArchived(false);
                    setView("gallery");
                  }}
                >
                  {t("Projekte", "Projects")}
                </Button>
                <Button
                  size="sm"
                  variant={view === "calendar" && !showArchived ? "secondary" : "ghost"}
                  aria-pressed={view === "calendar" && !showArchived}
                  data-workjet-action="project.view.calendar"
                  onClick={() => {
                    setShowArchived(false);
                    setView("calendar");
                  }}
                >
                  {t("Kalender", "Calendar")}
                </Button>
                {/* Fixed place, fixed name: the archive is the third view, never a toggle that renames itself (#596). */}
                <Button
                  size="sm"
                  variant={showArchived ? "secondary" : "ghost"}
                  aria-pressed={showArchived}
                  data-workjet-action="project.view.archive"
                  onClick={() => {
                    // The archive is a list of project cards; it never shows the calendar.
                    setView("gallery");
                    setShowArchived(true);
                  }}
                >
                  {t("Archiv", "Archive")}
                  {archivedCount > 0 ? (
                    <span className="ms-1 tabular-nums text-muted-foreground">{archivedCount}</span>
                  ) : null}
                </Button>
              </div>
            </div>
          </div>
          {showArchived ? null : createForm !== undefined ? (
            createForm
          ) : (
            <InlineProjectCreate className="mb-5" />
          )}
          {showArchived && visibleProjects.length === 0 ? (
            <div
              role="status"
              className="flex flex-col items-center gap-3 py-10 text-center text-sm"
              data-workjet-archive-empty=""
            >
              <p>{t("Noch nichts archiviert", "Nothing archived yet")}</p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Projekte archivierst du über das Menü einer Projektkarte.",
                  "Archive a project from its card menu.",
                )}
              </p>
              <Button
                size="sm"
                variant="outline"
                data-workjet-action="project.archive.back"
                onClick={() => setShowArchived(false)}
              >
                {t("Zurück zu Projekten", "Back to projects")}
              </Button>
            </div>
          ) : null}
          {projectsUnavailable ? (
            <div
              role="status"
              className="mb-4 text-xs text-muted-foreground"
              data-workjet-project-registry-stale=""
            >
              <span>{registryStatus ?? "Instanz nicht erreichbar"}</span>
              {lastUpdatedAt !== undefined && (
                <span>
                  {" "}
                  · Letzter Stand:{" "}
                  {new Date(lastUpdatedAt).toLocaleString(
                    workjetUiLanguage() === "en" ? "en-US" : "de-DE",
                    {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    },
                  )}
                </span>
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
                <div
                  className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4 max-sm:grid-cols-1"
                  data-workjet-project-gallery-grid=""
                >
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
                          tokenBudget={<ProjectTokenBudget project={project} />}
                          ctoxInstanceId={instanceId}
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
                          kpisUnavailable={kpiFailures.has(project.id)}
                          onSaveKpis={
                            project.native
                              ? (prompts, revision) => saveKpis(project.id, prompts, revision)
                              : undefined
                          }
                          onRefreshKpis={project.native ? () => refreshKpis(project.id) : undefined}
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

const PROJECT_OPENING_TIMEOUT_MS = 10_000;

/**
 * Opens a project that may exist only locally yet (just created, registration pending).
 * A previously selected native project would otherwise win and the user lands on
 * the old project instead of the new one (#585).
 */
function openCreatedProject(
  instanceId: string | null,
  project: ReturnType<typeof scopeProjectRef>,
): void {
  if (instanceId !== null && selectWorkjetProject(instanceId, project.projectId)) {
    selectProjectOverviewRef(instanceId, null);
    return;
  }
  if (instanceId !== null) selectWorkjetProject(instanceId, null);
  selectProjectOverviewRef(instanceId, project);
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const MODEL_ACCOUNT_MISSING =
  "Kein Modell-Konto: Der Supervisor startet, sobald eines eingerichtet ist.";

function ModelAccountMissingNotice() {
  return (
    <>
      <span>{MODEL_ACCOUNT_MISSING}</span>
      <Button size="xs" variant="outline" render={<Link to="/settings/models" />}>
        Modell-Konto einrichten
      </Button>
    </>
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
  // Ein Laden endet immer (UI-Vertrag §1.3): nach 10 s Statuszeile mit „Erneut versuchen“.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (error) return;
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), PROJECT_OPENING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [error, pending]);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty
        className="flex-1"
        data-workjet-project-state={error ? "opening-error" : slow ? "opening-slow" : "opening"}
      >
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-[22px] text-foreground">{projectTitle}</EmptyTitle>
          {!error && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {slow ? "Supervisor noch nicht geöffnet" : "Supervisor wird geöffnet …"}
            </p>
          )}
          {!error && slow && (
            <div className="mt-5 flex justify-center">
              <Button
                size="sm"
                variant="outline"
                onClick={onOpenSupervisor}
                data-workjet-action="project.open.supervisor.retry"
              >
                Erneut versuchen
              </Button>
            </div>
          )}
          {error ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {error === MODEL_ACCOUNT_MISSING ? (
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button size="sm" render={<Link to="/settings/models" />}>
                Modell-Konto einrichten
              </Button>
            </div>
          ) : null}
          {error && error !== MODEL_ACCOUNT_MISSING && (
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button
                size="sm"
                onClick={onOpenSupervisor}
                disabled={pending}
                data-workjet-action="project.open.supervisor"
              >
                {pending ? "Supervisor wird geöffnet …" : "Erneut versuchen"}
              </Button>
              <Button render={<Link to="/settings/computers" />} size="sm" variant="outline">
                <ServerIcon className="size-4" />
                Rechner wählen
              </Button>
            </div>
          )}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function NoProjectsHero() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="flex w-full max-w-md flex-col items-stretch gap-4 px-6 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-[22px] text-foreground">Noch keine Projekte</EmptyTitle>
            </EmptyHeader>
            <InlineProjectCreate
              defaultOpen
              className="self-center text-left"
              triggerAction="project.add.hero"
            />
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

interface ProjectInstanceOption {
  readonly id: string;
  readonly label: string;
}

/** Connected (activatable) instances, plus the active one when discovery lags. */
function resolveProjectInstanceOptions(
  discovery: "loading" | CtoxDiscoveryResult,
  activeInstanceId: string | null,
  workspaceNames: ReadonlyMap<string, string> = new Map(),
): readonly ProjectInstanceOption[] {
  const options: ProjectInstanceOption[] =
    discovery !== "loading" && discovery._tag === "ready"
      ? discovery.instances.filter(canActivateCtoxInstance).map((instance) => ({
          id: instance.id,
          label: ctoxInstanceDisplayTitle(instance, workspaceNames.get(instance.id) ?? null),
        }))
      : [];
  if (activeInstanceId !== null && !options.some((option) => option.id === activeInstanceId))
    options.unshift({ id: activeInstanceId, label: "Aktive Instanz" });
  return options;
}

/** Preselect when exactly one instance is connected, else the active one. */
function resolvePreselectedProjectInstance(
  options: readonly ProjectInstanceOption[],
  activeInstanceId: string | null,
): string | null {
  if (options.length === 1) return options[0]!.id;
  if (activeInstanceId !== null && options.some((option) => option.id === activeInstanceId))
    return activeInstanceId;
  return null;
}

/**
 * Inline „Projekt anlegen“ (drei Orte, keine Popups). A segment picks the
 * source: „Neu“ (name only), „Aus Ordner“ (a folder on a connected computer,
 * via the system folder chooser or path suggestions) or „Repository klonen“
 * (URL or provider repository into a target folder). The project is saved
 * with a pending CTOX registration (the native registration loop confirms
 * it), then its overview opens. Other places ask for this panel via the bus.
 */
function InlineProjectCreate({
  className,
  defaultOpen = false,
  triggerAction = "project.add.gallery",
}: {
  readonly className?: string;
  readonly defaultOpen?: boolean;
  readonly triggerAction?: string;
}) {
  const mode = useCtoxMode();
  const navigate = useNavigate();
  const { selectedInstanceId: activeCtoxInstanceId } = useActiveWorkjetScope();
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectStore = useContext(RegistryContext);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const [open, setOpen] = useState(() => consumeProjectCreateRequest() || defaultOpen);
  useEffect(() => onProjectCreateRequest(() => setOpen(true)), []);
  const [source, setSource] = useState<ProjectCreateSource>("new");
  const sources = useProjectCreateSources({ active: open, source });
  const knownProjects = useProjects();
  const { environments: scopedEnvironments } = useBusinessOsScopedEnvironments();
  const cloneTargetFolders = useMemo(() => {
    const environment = scopedEnvironments.find(
      (candidate) => candidate.environmentId === sources.environmentId,
    );
    return knownCloneTargetFolders(
      defaultCloneBaseDirectory(environment?.serverConfig?.settings?.addProjectBaseDirectory),
      knownProjects
        .filter((project) => project.environmentId === sources.environmentId)
        .map((project) => project.workspaceRoot),
    );
  }, [knownProjects, scopedEnvironments, sources.environmentId]);
  // „Ordner wählen“ für den Zielordner nutzt dieselbe Ordnerwahl wie „Aus
  // Ordner“ und übernimmt den gewählten Pfad als Zielordner.
  const cloneTargetPick = useRef(false);
  const { folderPath: sourcesFolderPath, setBaseDirectory: setSourcesBaseDirectory } = sources;
  useEffect(() => {
    if (!cloneTargetPick.current) return;
    cloneTargetPick.current = false;
    setSourcesBaseDirectory(sourcesFolderPath);
  }, [setSourcesBaseDirectory, sourcesFolderPath]);
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [chosenInstanceId, setChosenInstanceId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [progressStep, setProgressStep] = useState<{ step: number; of: number } | null>(null);
  const [progressStartedAt, setProgressStartedAt] = useState<number | null>(null);
  const [progressNow, setProgressNow] = useState(() => Date.now());
  useEffect(() => {
    if (progressStartedAt === null) return;
    const timer = window.setInterval(() => setProgressNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progressStartedAt]);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef<{
    key: string;
    projectId: ReturnType<typeof newProjectId>;
    commandId: CommandId;
  } | null>(null);
  const options = useMemo(
    () => resolveProjectInstanceOptions(mode.discovery, activeCtoxInstanceId, mode.workspaceNames),
    [activeCtoxInstanceId, mode.discovery, mode.workspaceNames],
  );
  const instanceId =
    chosenInstanceId !== null && options.some((option) => option.id === chosenInstanceId)
      ? chosenInstanceId
      : resolvePreselectedProjectInstance(options, activeCtoxInstanceId);
  const instanceLabel = options.find((option) => option.id === instanceId)?.label ?? null;
  const effectiveTitle = source === "new" || titleEdited ? title : sources.derivedTitle;

  const activateInstance = async (targetInstanceId: string) => {
    if (targetInstanceId === readActiveWorkjetScope().selectedInstanceId) return;
    const instance =
      mode.discovery !== "loading" && mode.discovery._tag === "ready"
        ? mode.discovery.instances.find((candidate) => candidate.id === targetInstanceId)
        : undefined;
    if (instance === undefined || !(await mode.select(instance)))
      throw new Error("Instanz nicht erreichbar.");
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || pending || instanceId === null) return;
    setPending(true);
    setError(null);
    try {
      await activateInstance(instanceId);
      const environmentId = primaryEnvironmentId;
      if (
        environmentId === null ||
        !canCreateProjectInEnvironment(primaryEnvironment?.connection.phase)
      )
        throw new Error("Lokale Umgebung nicht verbunden.");
      const key = JSON.stringify([instanceId, environmentId, trimmed]);
      if (attemptRef.current?.key !== key)
        attemptRef.current = { key, projectId: newProjectId(), commandId: newCommandId() };
      const attempt = attemptRef.current;
      const existing = projectStore
        .get(environmentProjects.projectsAtom)
        .some(
          (project) => project.environmentId === environmentId && project.id === attempt.projectId,
        );
      if (!existing) {
        const result = await createProject({
          environmentId,
          input: {
            projectId: attempt.projectId,
            commandId: attempt.commandId,
            title: trimmed,
            workspaceRoot: null,
            ctoxRegistration: { instanceId, commandId: attempt.commandId, status: "pending" },
            defaultModelSelection: resolveDefaultProviderModelSelection(
              primaryEnvironment?.serverConfig?.providers ?? [],
              null,
            ),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
      attemptRef.current = null;
      setTitle("");
      setOpen(false);
      toastManager.add({ type: "success", title: `Projekt „${trimmed}“ angelegt` });
      if (readActiveWorkjetScope().selectedInstanceId === instanceId)
        openCreatedProject(instanceId, scopeProjectRef(environmentId, attempt.projectId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Projekt nicht angelegt.");
    } finally {
      setPending(false);
    }
  };

  /** „Aus Ordner“ and „Repository klonen“: working copy first, then the project. */
  const submitFromSource = async () => {
    const trimmed = effectiveTitle.trim();
    if (!trimmed || pending || instanceId === null || !sources.ready) return;
    setPending(true);
    setError(null);
    try {
      await activateInstance(instanceId);
      const duplicate = sources.duplicate;
      if (source === "clone" && duplicate !== null && sources.environmentId !== null) {
        // Never clone into an existing working copy or add a second card.
        sources.reset();
        setSource("new");
        setOpen(false);
        toastManager.add({ type: "info", title: `„${duplicate.title}“ ist schon da – geöffnet` });
        if (readActiveWorkjetScope().selectedInstanceId === instanceId)
          openCreatedProject(instanceId, scopeProjectRef(sources.environmentId, duplicate.id));
        return;
      }
      const en = workjetUiLanguage() === "en";
      setProgressStartedAt(Date.now());
      setProgressNow(Date.now());
      setProgressStep({ step: 1, of: 2 });
      setProgress(
        source === "clone"
          ? en
            ? "Cloning repository …"
            : "Repository wird geklont …"
          : en
            ? "Checking folder …"
            : "Ordner wird geprüft …",
      );
      const workspaceRoot = await sources.resolveWorkspaceRoot();
      setProgressStep({ step: 2, of: 2 });
      setProgress(en ? "Creating project …" : "Projekt wird angelegt …");
      const created = await sources.createWorkspaceProject({
        title: trimmed,
        workspaceRoot,
        instanceId,
      });
      setTitle("");
      setTitleEdited(false);
      sources.reset();
      setSource("new");
      setOpen(false);
      toastManager.add(
        created.reusedTitle === undefined
          ? { type: "success", title: `Projekt „${trimmed}“ angelegt` }
          : { type: "info", title: `„${created.reusedTitle}“ ist schon da – geöffnet` },
      );
      if (readActiveWorkjetScope().selectedInstanceId === instanceId)
        openCreatedProject(instanceId, scopeProjectRef(created.environmentId, created.projectId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Projekt nicht angelegt.");
    } finally {
      setProgress(null);
      setProgressStep(null);
      setProgressStartedAt(null);
      setPending(false);
    }
  };

  const pickFolder = async () => {
    setError(null);
    try {
      await sources.pickFolder();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Ordner nicht gewählt.");
    }
  };

  const pickCloneTarget = async () => {
    setError(null);
    cloneTargetPick.current = true;
    try {
      if ((await sources.pickFolder()) === null) cloneTargetPick.current = false;
    } catch (failure) {
      cloneTargetPick.current = false;
      setError(failure instanceof Error ? failure.message : "Ordner nicht gewählt.");
    }
  };

  const computerSelect = (
    <ProjectComputerSelect
      options={sources.computerOptions}
      value={sources.environmentId}
      onChange={sources.setEnvironmentId}
    />
  );
  const needsComputer = source !== "new" && !sources.hasConnectedComputer;
  const requirement =
    options.length === 0 ? (
      <ProjectCreateRequirementLine
        text="Keine Instanz verbunden"
        actionLabel="Einstellungen › Instanzen"
        onAction={() => void navigate({ to: "/settings/business-os" })}
      />
    ) : needsComputer ? (
      <ProjectCreateRequirementLine
        text="Kein Rechner verbunden"
        actionLabel="Einstellungen › Rechner"
        onAction={() => void navigate({ to: "/settings/computers" })}
      />
    ) : null;
  // Clone/folder progress (#584): step, elapsed time and a running bar, not one grey line.
  const progressNode =
    progress !== null && progressStep !== null && progressStartedAt !== null ? (
      <div className="grid gap-1" data-workjet-project-create-progress="">
        <div className="flex items-center justify-between gap-2">
          <span>
            {workjetUiLanguage() === "en"
              ? `Step ${progressStep.step} of ${progressStep.of}`
              : `Schritt ${progressStep.step} von ${progressStep.of}`}
            {" · "}
            {progress}
          </span>
          <span className="tabular-nums">
            {formatElapsed(Math.max(0, progressNow - progressStartedAt))}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${(progressStep.step / (progressStep.of + 1)) * 100}%` }}
          />
        </div>
      </div>
    ) : (
      progress
    );
  const status = error ?? progressNode ?? requirement ?? undefined;
  const submitDisabled =
    effectiveTitle.trim().length === 0 ||
    instanceId === null ||
    (source !== "new" && !sources.ready);

  return (
    <div className={cn("w-full", className)}>
      <InlinePanel
        triggerLabel="Projekt anlegen"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(null);
        }}
        segment={
          <ProjectCreateSourceSegment
            value={source}
            disabled={pending}
            onChange={(next) => {
              setSource(next);
              setError(null);
            }}
          />
        }
        submitLabel={
          error !== null && source === "clone"
            ? workjetUiLanguage() === "en"
              ? "Try again"
              : "Erneut versuchen"
            : "Anlegen"
        }
        submitDisabled={submitDisabled}
        busy={pending}
        status={status}
        statusTone={error !== null ? "error" : "neutral"}
        onSubmit={() => void (source === "new" ? submit() : submitFromSource())}
      >
        {source === "folder" ? (
          <ProjectFolderFields
            computer={computerSelect}
            path={sources.folderPath}
            onPathChange={sources.setFolderPath}
            onPick={sources.canPickFolder ? () => void pickFolder() : null}
            picking={sources.picking}
            suggestions={sources.folderSuggestions}
            onSuggestion={sources.selectFolderSuggestion}
          />
        ) : source === "clone" ? (
          <ProjectCloneFields
            computer={computerSelect}
            providers={sources.cloneProviders}
            provider={sources.cloneProvider}
            onProviderChange={sources.setCloneProvider}
            repository={sources.repository}
            onRepositoryChange={sources.setRepository}
            baseDirectory={sources.baseDirectory}
            onBaseDirectoryChange={sources.setBaseDirectory}
            targetFolders={cloneTargetFolders}
            onPickTarget={sources.canPickFolder ? () => void pickCloneTarget() : null}
            picking={sources.picking}
          />
        ) : null}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
          <label className="grid min-w-0 gap-1 text-[13.5px]">
            Name
            <Input
              autoFocus={source === "new"}
              aria-label="Projektname"
              maxLength={256}
              value={effectiveTitle}
              data-workjet-action={triggerAction}
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleEdited(true);
              }}
            />
          </label>
          <div className="grid min-w-0 gap-1 text-[13.5px]">
            <span>Instanz</span>
            <Select
              value={instanceId ?? ""}
              onValueChange={(value) =>
                setChosenInstanceId(typeof value === "string" && value !== "" ? value : null)
              }
            >
              <SelectTrigger aria-label="Instanz" disabled={options.length === 0}>
                <SelectValue>{instanceLabel ?? "Keine Instanz verbunden"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
      </InlinePanel>
    </div>
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
            <span className="text-[13.5px] font-medium text-foreground md:text-muted-foreground/60">
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
              <EmptyTitle className="text-[22px] text-foreground">Umgebung verbinden</EmptyTitle>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/computers" />} size="sm">
                  <PlusIcon className="size-4" />
                  {cloudEnabled ? "Rechner öffnen" : "Rechner hinzufügen"}
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
