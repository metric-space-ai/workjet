import {
  InstanceOnboarding,
  canMountSelectedInstance,
  resolveInstanceOnboardingState,
} from "../components/ctox/InstanceOnboarding";
import { useCtoxMode } from "../components/ctox/CtoxModeShell";
import { scopeProjectRef, scopeThreadRef } from "@workjet/client-runtime/environment";
import { canCreateProjectInEnvironment } from "@workjet/client-runtime/operations/projects";
import { squashAtomCommandFailure } from "@workjet/client-runtime/state/runtime";
import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_WORKJET_THREAD_CONFIG,
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
import { buildThreadRouteParams } from "../threadRoutes";
import { findProjectSupervisor } from "../lib/projectSupervisor";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon, RotateCcwIcon, ServerIcon } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkjetHeaderContent } from "../components/WorkjetHeaderSlots";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
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
 * Opens the retained supervisor for the selected project. Legacy projects can
 * still open a draft, and an empty workspace offers project creation.
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
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });
  const [selectedLegacyProject, setSelectedLegacyProject] = useState<ReturnType<
    typeof scopeProjectRef
  > | null>(null);
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

  useEffect(() => {
    if (landingProject === null || startingRef.current) return;
    // Native selection always opens its Supervisor, including joined legacy histories.
    // A newly persisted project may arrive immediately before its supervisor event.
    if ((selectedNative !== null || landingProject.ctoxRegistration != null) && supervisor === null)
      return;
    startingRef.current = true;
    const opening =
      supervisor === null
        ? handleNewThread(scopeProjectRef(landingProject.environmentId, landingProject.id), {
            replace: true,
          })
        : navigate({
            to: "/$environmentId/$threadId",
            replace: true,
            params: buildThreadRouteParams(scopeThreadRef(supervisor.environmentId, supervisor.id)),
          });
    void opening.catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [
    handleNewThread,
    landingProject,
    navigate,
    selectedNative,
    startState.retryRequest,
    supervisor,
  ]);

  const openNativeSupervisor = async (
    nativeProject = selectedNative,
    overview?: ProjectOverview,
  ): Promise<boolean> => {
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
  };

  if (landingProject !== null && !(selectedNative !== null && supervisor === null))
    return startState.failed ? (
      <DraftStartError
        onRetry={() =>
          setStartState((state) => ({ failed: false, retryRequest: state.retryRequest + 1 }))
        }
      />
    ) : null;
  if (selectedNative !== null)
    return (
      <WorkjetProjectReady
        projectTitle={selectedNative.title}
        onOpenSupervisor={() => void openNativeSupervisor()}
        pending={nativeOpenState.pending}
        error={nativeOpenState.error}
      />
    );
  if (galleryProjects.length > 0)
    return (
      <ProjectGallery
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
          onOpen: () => {
            if (readActiveWorkjetScope().selectedInstanceId !== activeCtoxInstanceId) return;
            if (project.native && activeCtoxInstanceId !== null)
              selectWorkjetProject(activeCtoxInstanceId, project.id);
            else if (project.local !== null)
              setSelectedLegacyProject(
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
  onRefresh,
  projectsUnavailable,
}: {
  readonly onRefresh: (() => void) | undefined;
  readonly projectsUnavailable: boolean;
  readonly projects: readonly (GalleryProject & {
    readonly onOpen: () => void;
    readonly canArchive: boolean;
    readonly statistics: GalleryProjectStatistics;
    readonly onSave?: ((next: ProjectOverview) => Promise<boolean>) | undefined;
  })[];
}) {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const [showArchived, setShowArchived] = useState(false);
  const visibleProjects = visibleGalleryProjects(projects, showArchived);
  const archivedCount = visibleGalleryProjects(projects, true).length;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <main className="flex-1 overflow-auto px-6 py-10 sm:px-10" data-workjet-project-gallery="">
        <div className="mx-auto max-w-5xl">
          <div className="mb-8 flex items-center justify-between gap-4">
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
          {projectsUnavailable ? (
            <p role="status" className="mb-4 text-sm text-muted-foreground">
              Couldn’t refresh projects. Showing saved projects. Refresh projects to try again.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visibleProjects.map((project) => (
              <ProjectOverviewCard
                key={project.key}
                project={project}
                onOpen={project.onOpen}
                onSave={project.onSave}
                canArchive={project.canArchive}
                statistics={project.statistics}
              />
            ))}
          </div>
        </div>
      </main>
    </SidebarInset>
  );
}

function WorkjetProjectReady({
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
      <Empty className="flex-1" data-workjet-project-state="ready">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">{projectTitle}</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            Project synced with this CTOX instance. Open its supervisor to continue. You can attach
            a folder or choose a computer later.
          </EmptyDescription>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button
              size="sm"
              onClick={onOpenSupervisor}
              disabled={pending}
              data-workjet-action="project.open.supervisor"
            >
              {pending ? "Opening supervisor…" : "Open supervisor"}
            </Button>
            <Button render={<Link to="/settings/computers" />} size="sm">
              <ServerIcon className="size-4" />
              Choose computer
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Couldn’t open project</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            The project is still available. Try opening it again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
          </div>
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
