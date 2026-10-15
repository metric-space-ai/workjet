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
import { readWorkjetProjectRegistry, useWorkjetProjectRegistry } from "../workjetProjectRegistry";
import { useActiveWorkjetScope, readActiveWorkjetScope } from "../activeWorkjetScope";
import { environmentServerConfigsAtom, primaryServerSettingsAtom } from "./server";
import { allEnvironmentShellsBootstrappedAtom } from "./shell";
import { useEnvironmentThread } from "./threads";
import {
  useWorkjetThreadShells,
  readWorkjetThreadShells,
  readWorkjetThreadDetail,
} from "../ctox/workjetThreadData";
import { getCtoxClient } from "../ctox/ctoxClient";
import * as Option from "effect/Option";

const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = Object.freeze([]);
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([]);
const EMPTY_PROPOSED_PLANS: ReadonlyArray<OrchestrationProposedPlan> = Object.freeze([]);

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
  return useThreadShells().map((thread) => ({
    environmentId: thread.environmentId,
    threadId: thread.id,
  }));
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
  const { selectedInstanceId } = useActiveWorkjetScope();
  return useWorkjetThreadShells(selectedInstanceId);
}

export function useAllEnvironmentShellsBootstrapped(): boolean {
  const allBootstrapped = useAtomValue(allEnvironmentShellsBootstrappedAtom);
  const scope = useBusinessOsCodeScope();
  const projects = useProjects();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  return (
    (scope.phase === "ready" && (scope.environmentIds.size === 0 || allBootstrapped)) ||
    (allBootstrapped &&
      projects.some(
        (project) =>
          project.ctoxRegistration != null || project.environmentId === primaryEnvironmentId,
      ))
  );
}

export function useThreadShellsForProjectRefs(
  refs: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useThreadShells();
  return useMemo(
    () =>
      threads.filter((thread) =>
        refs.some(
          (ref) => ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
        ),
      ),
    [threads, refs],
  );
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
  return (
    useThreadShells().find(
      (thread) => thread.id === ref?.threadId && thread.environmentId === ref.environmentId,
    ) ?? null
  );
}

export function useThreadDetail(ref: ScopedThreadRef | null): EnvironmentThread | null {
  const state = useEnvironmentThread(ref?.environmentId ?? null, ref?.threadId ?? null);
  const data = Option.getOrNull(state.data);
  return data === null || ref === null ? null : { ...data, environmentId: ref.environmentId };
}

export function useThreadStatus(ref: ScopedThreadRef | null): EnvironmentThreadStatus {
  return useEnvironmentThread(ref?.environmentId ?? null, ref?.threadId ?? null).status;
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
  return useThreadDetail(ref)?.messages ?? EMPTY_MESSAGES;
}

export function useThreadActivities(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationThreadActivity> {
  return useThreadDetail(ref)?.activities ?? EMPTY_ACTIVITIES;
}

export function useThreadProposedPlans(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationProposedPlan> {
  return useThreadDetail(ref)?.proposedPlans ?? EMPTY_PROPOSED_PLANS;
}

export function useThreadSession(ref: ScopedThreadRef | null): OrchestrationSession | null {
  return useThreadDetail(ref)?.session ?? null;
}

export function readProject(ref: ScopedProjectRef): EnvironmentProject | null {
  const project = appAtomRegistry.get(environmentProjects.projectAtom(ref));
  if (project === null) return null;
  const selectedInstanceId = readActiveWorkjetScope().selectedInstanceId;
  return (
    visibleLocalProjects(
      [project],
      {
        scope: readBusinessOsCodeScope(),
        selectedInstanceId,
        primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
      },
      readWorkjetProjectRegistry(selectedInstanceId).projects,
      appAtomRegistry.get(primaryServerSettingsAtom).workjet.computers,
    )[0] ?? null
  );
}

export function readThreadShell(ref: ScopedThreadRef): EnvironmentThreadShell | null {
  return (
    readThreadShells().find(
      (thread) => thread.id === ref.threadId && thread.environmentId === ref.environmentId,
    ) ?? null
  );
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
  return readWorkjetThreadDetail(getCtoxClient(readActiveWorkjetScope().selectedInstanceId), ref);
}

export function readEnvironmentThreadRefs(
  environmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  return readThreadRefs().filter((ref) => ref.environmentId === environmentId);
}

export function readThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  return readThreadShells().map((thread) => ({
    environmentId: thread.environmentId,
    threadId: thread.id,
  }));
}

export function readThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return readWorkjetThreadShells(readActiveWorkjetScope().selectedInstanceId);
}

export function findThreadRef(threadId: ThreadId): ScopedThreadRef | null {
  return readThreadRefs().find((ref) => ref.threadId === threadId) ?? null;
}
