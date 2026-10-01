import type {
  CtoxWorkjetProjectProjection,
  EnvironmentId,
  OrchestrationProjectShell,
} from "@workjet/contracts";

/** A native project keeps its identity when its local conversation is first opened. */
export function resolveNativeProjectOpening(input: {
  readonly instanceId: string;
  readonly project: Pick<CtoxWorkjetProjectProjection, "id" | "title">;
  readonly localEnvironmentId: EnvironmentId | null;
  readonly localConnected: boolean;
  readonly projects: readonly (Pick<OrchestrationProjectShell, "id" | "ctoxRegistration"> & {
    readonly environmentId: EnvironmentId;
  })[];
}) {
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
