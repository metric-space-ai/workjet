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
import { useActiveWorkjetScope, readActiveWorkjetScope } from "../activeWorkjetScope";
import { environmentServerConfigsAtom } from "./server";
import { allEnvironmentShellsBootstrappedAtom } from "./shell";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

const EMPTY_PROJECT_REFS: ReadonlyArray<ScopedProjectRef> = Object.freeze([]);
const EMPTY_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = Object.freeze([]);
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([]);
const EMPTY_PROPOSED_PLANS: ReadonlyArray<OrchestrationProposedPlan> = Object.freeze([]);

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("web-project:empty"),
);
const EMPTY_PROJECT_REFS_ATOM = Atom.make(EMPTY_PROJECT_REFS).pipe(
  Atom.withLabel("web-project-refs:empty"),
);
const EMPTY_THREAD_REFS_ATOM = Atom.make(EMPTY_THREAD_REFS).pipe(
  Atom.withLabel("web-thread-refs:empty"),
);
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
  const scope = useBusinessOsCodeScope();
  return useAtomValue(
    environmentId === null || !businessOsCodeScopeContainsEnvironment(scope, environmentId)
      ? EMPTY_PROJECT_REFS_ATOM
      : environmentProjects.environmentProjectRefsAtom(environmentId),
  );
}

export function useEnvironmentThreadRefs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ScopedThreadRef> {
  const scope = useBusinessOsCodeScope();
  return useAtomValue(
    environmentId === null || !businessOsCodeScopeContainsEnvironment(scope, environmentId)
      ? EMPTY_THREAD_REFS_ATOM
      : environmentThreadShells.environmentThreadRefsAtom(environmentId),
  );
}

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const scope = useBusinessOsCodeScope();
  const { selectedInstanceId } = useActiveWorkjetScope();
  return useMemo(
    () =>
      projects.filter(
        (project) =>
          businessOsCodeScopeContainsEnvironment(scope, project.environmentId) &&
          (project.ctoxRegistration == null ||
            project.ctoxRegistration.instanceId === selectedInstanceId),
      ),
    [projects, scope, selectedInstanceId],
  );
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const scope = useBusinessOsCodeScope();
  return useMemo(
    () =>
      new Map(
        [...configs].filter(([environmentId]) =>
          businessOsCodeScopeContainsEnvironment(scope, environmentId),
        ),
      ),
    [configs, scope],
  );
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  const projects = useProjects();
  const scope = useBusinessOsCodeScope();
  return useMemo(
    () =>
      threads.filter(
        (thread) =>
          businessOsCodeScopeContainsEnvironment(scope, thread.environmentId) &&
          projects.some(
            (project) =>
              project.environmentId === thread.environmentId && project.id === thread.projectId,
          ),
      ),
    [projects, scope, threads],
  );
}

export function useAllEnvironmentShellsBootstrapped(): boolean {
  const allBootstrapped = useAtomValue(allEnvironmentShellsBootstrappedAtom);
  const scope = useBusinessOsCodeScope();
  return scope.phase === "ready" && (scope.environmentIds.size === 0 || allBootstrapped);
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
  const scope = useBusinessOsCodeScope();
  const { selectedInstanceId } = useActiveWorkjetScope();
  const project = useAtomValue(
    ref === null || !businessOsCodeScopeContainsEnvironment(scope, ref.environmentId)
      ? EMPTY_PROJECT_ATOM
      : environmentProjects.projectAtom(ref),
  );
  return project?.ctoxRegistration != null &&
    project.ctoxRegistration.instanceId !== selectedInstanceId
    ? null
    : project;
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  const scope = useBusinessOsCodeScope();
  const shell = useAtomValue(
    ref === null || !businessOsCodeScopeContainsEnvironment(scope, ref.environmentId)
      ? EMPTY_THREAD_SHELL_ATOM
      : environmentThreadShells.threadShellAtom(ref),
  );
  const project = useProject(
    shell === null ? null : { environmentId: shell.environmentId, projectId: shell.projectId },
  );
  return shell !== null && project === null ? null : shell;
}

function useVisibleThreadRef(ref: ScopedThreadRef | null): ScopedThreadRef | null {
  const scope = useBusinessOsCodeScope();
  const shell = useAtomValue(
    ref === null || !businessOsCodeScopeContainsEnvironment(scope, ref.environmentId)
      ? EMPTY_THREAD_SHELL_ATOM
      : environmentThreadShells.threadShellAtom(ref),
  );
  const project = useProject(
    shell === null ? null : { environmentId: shell.environmentId, projectId: shell.projectId },
  );
  return shell !== null && project === null ? null : ref;
}

export function useThreadDetail(ref: ScopedThreadRef | null): EnvironmentThread | null {
  const scope = useBusinessOsCodeScope();
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null || !businessOsCodeScopeContainsEnvironment(scope, visibleRef.environmentId)
      ? EMPTY_THREAD_DETAIL_ATOM
      : environmentThreadDetails.detailAtom(visibleRef),
  );
}

export function useThreadStatus(ref: ScopedThreadRef | null): EnvironmentThreadStatus {
  const scope = useBusinessOsCodeScope();
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null || !businessOsCodeScopeContainsEnvironment(scope, visibleRef.environmentId)
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
  const scope = useBusinessOsCodeScope();
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null || !businessOsCodeScopeContainsEnvironment(scope, visibleRef.environmentId)
      ? EMPTY_MESSAGES_ATOM
      : environmentThreadDetails.messagesAtom(visibleRef),
  );
}

export function useThreadActivities(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationThreadActivity> {
  const scope = useBusinessOsCodeScope();
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null || !businessOsCodeScopeContainsEnvironment(scope, visibleRef.environmentId)
      ? EMPTY_ACTIVITIES_ATOM
      : environmentThreadDetails.activitiesAtom(visibleRef),
  );
}

export function useThreadProposedPlans(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationProposedPlan> {
  const scope = useBusinessOsCodeScope();
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null || !businessOsCodeScopeContainsEnvironment(scope, visibleRef.environmentId)
      ? EMPTY_PROPOSED_PLANS_ATOM
      : environmentThreadDetails.proposedPlansAtom(visibleRef),
  );
}

export function useThreadSession(ref: ScopedThreadRef | null): OrchestrationSession | null {
  const scope = useBusinessOsCodeScope();
  const visibleRef = useVisibleThreadRef(ref);
  return useAtomValue(
    visibleRef === null || !businessOsCodeScopeContainsEnvironment(scope, visibleRef.environmentId)
      ? EMPTY_SESSION_ATOM
      : environmentThreadDetails.sessionAtom(visibleRef),
  );
}

export function readProject(ref: ScopedProjectRef): EnvironmentProject | null {
  if (!businessOsCodeScopeContainsEnvironment(readBusinessOsCodeScope(), ref.environmentId)) {
    return null;
  }
  const project = appAtomRegistry.get(environmentProjects.projectAtom(ref));
  return project?.ctoxRegistration != null &&
    project.ctoxRegistration.instanceId !== readActiveWorkjetScope().selectedInstanceId
    ? null
    : project;
}

export function readThreadShell(ref: ScopedThreadRef): EnvironmentThreadShell | null {
  if (!businessOsCodeScopeContainsEnvironment(readBusinessOsCodeScope(), ref.environmentId)) {
    return null;
  }
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
  if (!businessOsCodeScopeContainsEnvironment(readBusinessOsCodeScope(), ref.environmentId)) {
    return null;
  }
  const detail = appAtomRegistry.get(environmentThreadDetails.detailAtom(ref));
  return detail !== null &&
    readProject({ environmentId: detail.environmentId, projectId: detail.projectId }) === null
    ? null
    : detail;
}

export function readEnvironmentThreadRefs(
  environmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  if (!businessOsCodeScopeContainsEnvironment(readBusinessOsCodeScope(), environmentId)) return [];
  return appAtomRegistry.get(environmentThreadShells.environmentThreadRefsAtom(environmentId));
}

export function readThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  const scope = readBusinessOsCodeScope();
  return appAtomRegistry
    .get(environmentThreadShells.threadRefsAtom)
    .filter((ref) => businessOsCodeScopeContainsEnvironment(scope, ref.environmentId));
}

export function readThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  const scope = readBusinessOsCodeScope();
  return appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter((thread) => businessOsCodeScopeContainsEnvironment(scope, thread.environmentId));
}

export function findThreadRef(threadId: ThreadId): ScopedThreadRef | null {
  const scope = readBusinessOsCodeScope();
  return (
    appAtomRegistry
      .get(environmentThreadShells.threadRefsAtom)
      .find(
        (ref) =>
          ref.threadId === threadId &&
          businessOsCodeScopeContainsEnvironment(scope, ref.environmentId),
      ) ?? null
  );
}
