import type {
  CtoxWorkjetProjectProjection,
  EnvironmentId,
  OrchestrationProjectShell,
} from "@workjet/contracts";
import { canCreateProjectInEnvironment } from "@workjet/client-runtime/operations/projects";
import type { GalleryProject } from "./projectOverview";

/** One automatic opening per project and local-environment readiness. */
export function nativeOpenAttemptKey(
  instanceId: string | null,
  projectId: string,
  localEnvironmentId: EnvironmentId | null,
  localPhase: Parameters<typeof canCreateProjectInEnvironment>[0],
): string {
  return JSON.stringify([
    instanceId,
    projectId,
    localEnvironmentId !== null && canCreateProjectInEnvironment(localPhase),
  ]);
}

/** A native project keeps its identity when its local conversation is first opened. */
export function resolveNativeProjectOpening(input: {
  readonly instanceId: string;
  readonly project: Pick<CtoxWorkjetProjectProjection, "id" | "title">;
  readonly localEnvironmentId: EnvironmentId | null;
  readonly localConnected: boolean;
  /** Gallery entries already carry the persisted instance/computer/working-copy join. */
  readonly gallery?: readonly GalleryProject[];
  readonly projects: readonly (Pick<OrchestrationProjectShell, "id" | "ctoxRegistration"> & {
    readonly environmentId: EnvironmentId;
  })[];
}) {
  const history = input.gallery?.find(
    (entry) =>
      entry.native &&
      entry.id === input.project.id &&
      entry.key === `${input.instanceId}:${input.project.id}`,
  )?.local;
  const retained =
    history == null
      ? undefined
      : input.projects.find(
          (project) =>
            project.id === history.id &&
            project.environmentId === history.environmentId &&
            (project.ctoxRegistration == null ||
              project.ctoxRegistration.instanceId === input.instanceId),
        );
  if (retained) return { _tag: "existing", project: retained } as const;
  const existing = input.projects.find(
    (project) =>
      project.id === input.project.id && project.ctoxRegistration?.instanceId === input.instanceId,
  );
  if (existing) return { _tag: "existing", project: existing } as const;
  if (input.localEnvironmentId === null || !input.localConnected)
    return {
      _tag: "blocked",
      message: "Lokale Code-Umgebung nicht verbunden.",
    } as const;
  if (
    input.projects.some(
      (project) =>
        project.id === input.project.id && project.environmentId === input.localEnvironmentId,
    )
  )
    return {
      _tag: "blocked",
      message: "Projekt-ID gehört bereits zu einer anderen Instanz.",
    } as const;
  return {
    _tag: "create",
    environmentId: input.localEnvironmentId,
    projectId: input.project.id,
    title: input.project.title,
  } as const;
}
