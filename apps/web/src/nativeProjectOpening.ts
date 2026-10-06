import type {
  CtoxWorkjetProjectProjection,
  EnvironmentId,
  OrchestrationProjectShell,
} from "@workjet/contracts";
import type { GalleryProject } from "./projectOverview";

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
      message: "Connect the local Code environment to open this supervisor.",
    } as const;
  if (
    input.projects.some(
      (project) =>
        project.id === input.project.id && project.environmentId === input.localEnvironmentId,
    )
  )
    return {
      _tag: "blocked",
      message:
        "This local project ID is already bound to another instance. Its conversation has been preserved.",
    } as const;
  return {
    _tag: "create",
    environmentId: input.localEnvironmentId,
    projectId: input.project.id,
    title: input.project.title,
  } as const;
}
