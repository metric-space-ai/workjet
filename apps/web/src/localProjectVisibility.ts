import type {
  CtoxWorkjetProjectProjection,
  EnvironmentId,
  WorkjetComputer,
} from "@workjet/contracts";
import {
  resolveProjectHistoryBindings,
  type ProjectHistoryBinding,
  type ProjectHistoryIdentity,
} from "./workjetProjectIdentity";
import {
  businessOsCodeScopeContainsEnvironment,
  type BusinessOsCodeScopeSnapshot,
} from "./businessOsCodeScope";

type LocalProjectVisibilityContext = {
  readonly scope: BusinessOsCodeScopeSnapshot;
  readonly selectedInstanceId: string | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly historyBinding?: ProjectHistoryBinding | undefined;
};

/** Local project intent is tenant-bound, even before any computer is assigned.
 * This does not grant membership or access to any remote environment. */
export function localProjectIsVisible(
  project: {
    readonly id?: string | undefined;
    readonly environmentId: EnvironmentId;
    readonly ctoxRegistration?: { readonly instanceId: string } | null | undefined;
  },
  context: LocalProjectVisibilityContext,
): boolean {
  const registration = project.ctoxRegistration;
  if (registration != null) {
    if (registration.instanceId !== context.selectedInstanceId) return false;
    if (
      context.selectedInstanceId !== null &&
      project.environmentId === context.primaryEnvironmentId
    )
      return true;
  }
  const binding = context.historyBinding;
  if (
    registration == null &&
    context.selectedInstanceId !== null &&
    project.environmentId === context.primaryEnvironmentId &&
    binding?.proof.kind === "working-copy" &&
    binding.instanceId === context.selectedInstanceId &&
    binding.environmentId === project.environmentId &&
    binding.projectId === project.id
  )
    return true;
  return businessOsCodeScopeContainsEnvironment(context.scope, project.environmentId);
}

/** Retained local histories use the gallery's existing unique working-copy proof.
 * This never makes an unassigned remote environment accessible. */
export function visibleLocalProjects<Project extends ProjectHistoryIdentity>(
  projects: readonly Project[],
  context: LocalProjectVisibilityContext,
  nativeProjects: readonly CtoxWorkjetProjectProjection[],
  computers: readonly WorkjetComputer[],
): readonly Project[] {
  const bindings = resolveProjectHistoryBindings({
    instanceId: context.selectedInstanceId,
    nativeProjects,
    projects: projects.filter(
      (project) =>
        project.ctoxRegistration == null &&
        project.environmentId === context.primaryEnvironmentId,
    ),
    computers,
  });
  const bindingByProject = new Map(
    bindings.map((binding) => [binding.projectId, binding] as const),
  );
  return projects.filter((project) =>
    localProjectIsVisible(project, {
      ...context,
      historyBinding: bindingByProject.get(project.id),
    }),
  );
}
