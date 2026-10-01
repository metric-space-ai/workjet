import {
  InstanceOnboarding,
  resolveInstanceOnboardingState,
} from "../components/ctox/InstanceOnboarding";
import { useCtoxMode } from "../components/ctox/CtoxModeShell";
import { scopeProjectRef, scopeThreadRef } from "@workjet/client-runtime/environment";
import { buildThreadRouteParams } from "../threadRoutes";
import { findProjectSupervisor } from "../lib/projectSupervisor";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FolderPlusIcon, LinkIcon, PlusIcon, RotateCcwIcon, ServerIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkjetHeaderContent } from "../components/WorkjetHeaderSlots";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useBusinessOsScopedEnvironments } from "../state/environments";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { useWorkjetProjectRegistry } from "../workjetProjectRegistry";
import { useActiveWorkjetScope } from "../activeWorkjetScope";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments } = useBusinessOsScopedEnvironments();
  const mode = useCtoxMode();
  const onboarding = resolveInstanceOnboardingState(
    mode.discovery,
    mode.selectedId,
    mode.connection,
  );
  if (mode.bridge !== undefined && onboarding !== "ready")
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
  const { selectedInstanceId: activeCtoxInstanceId } = useActiveWorkjetScope();
  const registry = useWorkjetProjectRegistry(activeCtoxInstanceId);
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });
  const selectedNative =
    registry.projects.find((project) => project.id === registry.selectedProjectId) ??
    registry.projects[0] ??
    null;
  const landingProject = useMemo(() => {
    if (!bootstrapped) return null;
    const ordered = sortScopedProjectsForSidebar(projects, threads, "updated_at");
    if (selectedNative !== null)
      return ordered.find((project) => project.id === selectedNative.id) ?? null;
    return ordered[0] ?? null;
  }, [bootstrapped, projects, selectedNative, threads]);
  const supervisor =
    landingProject === null
      ? null
      : findProjectSupervisor(
          threads,
          scopeProjectRef(landingProject.environmentId, landingProject.id),
        );

  useEffect(() => {
    if (landingProject === null || startingRef.current) return;
    // A newly persisted project may arrive immediately before its supervisor event.
    if (landingProject.ctoxRegistration != null && supervisor === null) return;
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
  }, [handleNewThread, landingProject, navigate, startState.retryRequest, supervisor]);

  if (landingProject !== null)
    return startState.failed ? (
      <DraftStartError
        onRetry={() =>
          setStartState((state) => ({ failed: false, retryRequest: state.retryRequest + 1 }))
        }
      />
    ) : null;
  if (selectedNative !== null) return <WorkjetProjectReady projectTitle={selectedNative.title} />;
  if (!bootstrapped && registry.phase !== "ready") return null;
  return <NoProjectsHero />;
}

function WorkjetProjectReady({ projectTitle }: { readonly projectTitle: string }) {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1" data-workjet-project-state="ready">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">{projectTitle}</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            Project synced with this CTOX instance. Choose a computer when you are ready to run a
            worker; the project itself is not tied to one computer.
          </EmptyDescription>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="outline" onClick={openAddProject}>
              <FolderPlusIcon className="size-4" />
              Add project
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
