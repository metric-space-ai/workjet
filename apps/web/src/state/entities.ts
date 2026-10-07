import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@workjet/client-runtime/state/shell";
import {
  type EnvironmentThreadStatus,
  mergeEnvironmentThread,
} from "@workjet/client-runtime/state/threads";
import type {
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThreadActivity,
  ScopedProjectRef,
  ScopedThreadRef,
  ServerConfig,
} from "@workjet/contracts";
import type { EnvironmentId, ThreadId } from "@workjet/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import {
  businessOsCodeScopeContainsEnvironment,
  readBusinessOsCodeScope,
  useBusinessOsCodeScope,
} from "../businessOsCodeScope";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "./projects";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { visibleLocalProjects } from "../localProjectVisibility";
import { useWorkjetProjectRegistry } from "../workjetProjectRegistry";
import { useActiveWorkjetScope, readActiveWorkjetScope } from "../activeWorkjetScope";
import { environmentServerConfigsAtom, primaryServerSettingsAtom } from "./server";
import { allEnvironmentShellsBootstrappedAtom } from "./shell";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = Object.freeze([]);
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([]);
const EMPTY_PROPOSED_PLANS: ReadonlyArray<OrchestrationProposedPlan> = Object.freeze([]);

const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("web-thread-shell:empty"),
);
const EMPTY_THREAD_DETAIL_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("web-thread-detail:empty"),
);
const EMPTY_THREAD_STATUS_ATOM = Atom.make<EnvironmentThreadStatus>("empty").pipe(
  Atom.withLabel("web-thread-status:empty"),
);
const EMPTY_MESSAGES_ATOM = Atom.make(EMPTY_MESSAGES).pipe(
  Atom.withLabel("web-thread-messages:empty"),
);
const EMPTY_ACTIVITIES_ATOM = Atom.make(EMPTY_ACTIVITIES).pipe(
  Atom.withLabel("web-thread-activities:empty"),
);
const EMPTY_PROPOSED_PLANS_ATOM = Atom.make(EMPTY_PROPOSED_PLANS).pipe(
  Atom.withLabel("web-thread-proposed-plans:empty"),
);
const EMPTY_SESSION_ATOM = Atom.make<OrchestrationSession | null>(null).pipe(
  Atom.withLabel("web-thread-session:empty"),
);

export const activeEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-active-environment-id"),
);

export function useActiveEnvironmentId(): EnvironmentId | null {
  return useAtomValue(activeEnvironmentIdAtom);
}

export function readActiveEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(activeEnvironmentIdAtom);
}

export function setActiveEnvironmentId(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(activeEnvironmentIdAtom, environmentId);
}

export function useProjectRefs(): ReadonlyArray<ScopedProjectRef> {
  const refs = useAtomValue(environmentProjects.projectRefsAtom);
  const projects = useProjects();
  return useMemo(
    () =>
      refs.filter((ref) =>
        projects.some(
          (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
        ),
      ),
    [refs, projects],
  );
}

export function useThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  const refs = useAtomValue(environmentThreadShells.threadRefsAtom);
  const threads = useThreadShells();
  return useMemo(
    () =>
      refs.filter((ref) =>
        threads.some(
          (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
        ),
      ),
    [refs, threads],
  );
}

export function useEnvironmentProjectRefs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ScopedProjectRef> {
  const refs = useProjectRefs();
  return useMemo(
    () => refs.filter((ref) => ref.environmentId === environmentId),
    [refs, environmentId],
  );
}

export function useEnvironmentThreadRefs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ScopedThreadRef> {
  const refs = useThreadRefs();
  return useMemo(
    () => refs.filter((ref) => ref.environmentId === environmentId),
    [refs, environmentId],
  );
}

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const scope = useBusinessOsCodeScope();
  const { selectedInstanceId } = useActiveWorkjetScope();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const registry = useWorkjetProjectRegistry(selectedInstanceId);
  const computers = useAtomValue(primaryServerSettingsAtom).workjet.computers;
  return useMemo(
    () =>
      visibleLocalProjects(
        projects,
        { scope, selectedInstanceId, primaryEnvironmentId },
        registry.projects,
        computers,
      ),
    [projects, scope, selectedInstanceId, primaryEnvironmentId, registry.projects, computers],
  );
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const projects = useProjects();
  const scope = useBusinessOsCodeScope();
  return useMemo(
    () =>
      new Map(
        [...configs].filter(
          ([environmentId]) =>
            businessOsCodeScopeContainsEnvironment(scope, environmentId) ||
            projects.some((project) => project.environmentId === environmentId),
        ),
      ),
    [configs, projects, scope],
  );
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  const projects = useProjects();
  return useMemo(
    () =>
      threads.filter((thread) =>
        projects.some(
          (project) =>
            project.environmentId === thread.environmentId && project.id === thread.projectId,
        ),
      ),
    [projects, threads],
  );
}

export function useAllEnvironmentShellsBootstrapped(): boolean {
  const allBootstrapped = useAtomValue(allEnvironmentShellsBootstrappedAtom);
  const scope = useBusinessOsCodeScope();
  const projects = useProjects();
  return (
    (scope.phase === "ready" && (scope.environmentIds.size === 0 || allBootstrapped)) ||
    (allBootstrapped && projects.some((project) => project.ctoxRegistration != null))
  );
}

export function useThreadShellsForProjectRefs(
  refs: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<EnvironmentThreadShell> {
  const projects = useProjects();
  const scopedRefs = useMemo(
    () =>
      refs.filter((ref) =>
        projects.some(
          (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
        ),
      ),
    [refs, projects],
  );
  return useAtomValue(environmentThreadShells.threadShellsForProjectRefsAtom(scopedRefs));
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  const projects = useProjects();
  return (
    projects.find(
      (project) => project.environmentId === ref?.environmentId && project.id === ref.projectId,
    ) ?? null
  );
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  const shell = useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
  );
  const project = useProject(
    shell === null ? null : { environmentId: shell.environmentId, projectId: shell.projectId },
  );
  return project === null ? null : shell;
}

function useVisibleThreadRef(ref: ScopedThreadRef | null): ScopedThreadRef | null {
  const scope = useBusinessOsCodeScope();
  const shell = useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
  );
  const project = useProject(
    shell === null ? null : { environmentId: shell.environmentId, projectId: shell.projectId },
  );
  if (shell !== null) return project === null ? null : ref;
  return ref !== null && businessOsCodeScopeContainsEnvironment(scope, ref.environmentId)
    ? ref
    : null;
}

export function useThreadDetail(ref: ScopedThreadRef | null): EnvironmentThread | null {
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null
      ? EMPTY_THREAD_DETAIL_ATOM
      : environmentThreadDetails.detailAtom(visibleRef),
  );
}

export function useThreadStatus(ref: ScopedThreadRef | null): EnvironmentThreadStatus {
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null
      ? EMPTY_THREAD_STATUS_ATOM
      : environmentThreadDetails.statusAtom(visibleRef),
  );
}

export function resolveThreadDetailRef(
  ref: ScopedThreadRef | null,
  options: {
    shellExists: boolean;
    waitForShell: boolean;
  },
): ScopedThreadRef | null {
  return ref !== null && (!options.waitForShell || options.shellExists) ? ref : null;
}

/** Detail collections composed with shell-authoritative thread/workspace metadata. */
export function useThread(
  ref: ScopedThreadRef | null,
  options?: {
    /**
     * Client-reserved draft thread ids do not exist on the server until the
     * first send. Waiting for the shell index avoids polling the detail
     * endpoint for an intentionally missing thread during that window.
     */
    waitForShell?: boolean;
  },
): EnvironmentThread | null {
  const shell = useThreadShell(ref);
  const detail = useThreadDetail(
    resolveThreadDetailRef(ref, {
      shellExists: shell !== null,
      waitForShell: options?.waitForShell === true,
    }),
  );
  return useMemo(() => mergeEnvironmentThread(detail, shell), [detail, shell]);
}

export function useThreadMessages(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationMessage> {
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null ? EMPTY_MESSAGES_ATOM : environmentThreadDetails.messagesAtom(visibleRef),
  );
}

export function useThreadActivities(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationThreadActivity> {
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null
      ? EMPTY_ACTIVITIES_ATOM
      : environmentThreadDetails.activitiesAtom(visibleRef),
  );
}

export function useThreadProposedPlans(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationProposedPlan> {
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null
      ? EMPTY_PROPOSED_PLANS_ATOM
      : environmentThreadDetails.proposedPlansAtom(visibleRef),
  );
}

export function useThreadSession(ref: ScopedThreadRef | null): OrchestrationSession | null {
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null ? EMPTY_SESSION_ATOM : environmentThreadDetails.sessionAtom(visibleRef),
  );
}

export function readProject(ref: ScopedProjectRef): EnvironmentProject | null {
  const project = appAtomRegistry.get(environmentProjects.projectAtom(ref));
  return project !== null &&
    localProjectIsVisible(project, {
      scope: readBusinessOsCodeScope(),
      selectedInstanceId: readActiveWorkjetScope().selectedInstanceId,
      primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    })
    ? project
    : null;
}

export function readThreadShell(ref: ScopedThreadRef): EnvironmentThreadShell | null {
  const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
  return shell !== null &&
    readProject({ environmentId: shell.environmentId, projectId: shell.projectId }) === null
    ? null
    : shell;
}

/** Whether the environment's server understands thread.settle/unsettle.
    False for pre-settlement servers (capability defaults false on decode),
    so clients under version skew fall back instead of erroring. */
export function readEnvironmentSupportsSettlement(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

/** Whether the environment's server understands thread.snooze/unsnooze.
    Same version-skew contract as settlement. */
export function readEnvironmentSupportsSnooze(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSnooze === true
  );
}

/** Whether the environment's server understands thread.pin/unpin.
    Same version-skew contract as settlement. */
export function readEnvironmentSupportsPinning(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinning === true
  );
}

/** Whether the environment's server understands thread title regeneration.
    Same version-skew contract as settlement. */
export function readEnvironmentSupportsTitleRegeneration(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadTitleRegeneration === true
  );
}

/** Whether the environment's server understands thread.pin.reorder (and
    orderKey on thread.pin). Same version-skew contract as settlement. */
export function readEnvironmentSupportsPinReorder(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinReorder === true
  );
}

export function readThreadDetail(ref: ScopedThreadRef): EnvironmentThread | null {
  const shell = readThreadShell(ref);
  if (shell === null) return null;
  return appAtomRegistry.get(environmentThreadDetails.detailAtom(ref));
}

export function readEnvironmentThreadRefs(
  environmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  return readThreadRefs().filter((ref) => ref.environmentId === environmentId);
}

export function readThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  return appAtomRegistry
    .get(environmentThreadShells.threadRefsAtom)
    .filter((ref) => readThreadShell(ref) !== null);
}

export function readThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter(
      (thread) =>
        readProject({ environmentId: thread.environmentId, projectId: thread.projectId }) !== null,
    );
}

export function findThreadRef(threadId: ThreadId): ScopedThreadRef | null {
  return readThreadRefs().find((ref) => ref.threadId === threadId) ?? null;
}
