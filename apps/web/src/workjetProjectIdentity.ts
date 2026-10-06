import type {
  CtoxProjectRegistration,
  CtoxWorkjetProjectProjection,
  EnvironmentId,
  ProjectId,
  WorkjetComputer,
} from "@workjet/contracts";

export interface ProjectHistoryIdentity {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot?: string | null | undefined;
  readonly ctoxRegistration?: CtoxProjectRegistration | null | undefined;
}

export interface ProjectHistoryBinding {
  readonly instanceId: string;
  readonly nativeProjectId: ProjectId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly proof:
    | { readonly kind: "registered-project" }
    | {
        readonly kind: "working-copy";
        readonly workingCopyId: string;
        readonly computerId: string;
      };
}

function normalizedPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
}

/** Rebuild the alias projection from persisted identities, never from titles.
 * Source projects and their conversation IDs remain untouched. A physical
 * history belongs to exactly one native project or stays unresolved.
 */
export function resolveProjectHistoryBindings(input: {
  readonly instanceId: string | null;
  readonly nativeProjects: readonly CtoxWorkjetProjectProjection[];
  readonly projects: readonly ProjectHistoryIdentity[];
  readonly computers: readonly WorkjetComputer[];
}): readonly ProjectHistoryBinding[] {
  const instanceId = input.instanceId;
  if (instanceId === null) return [];
  return input.projects.flatMap((physical): ProjectHistoryBinding[] => {
    const registration = physical.ctoxRegistration;
    if (registration != null) {
      if (
        registration.instanceId !== instanceId ||
        !input.nativeProjects.some((project) => project.id === physical.id)
      )
        return [];
      return [
        {
          instanceId,
          nativeProjectId: physical.id,
          projectId: physical.id,
          environmentId: physical.environmentId,
          proof: { kind: "registered-project" },
        },
      ];
    }
    if (physical.workspaceRoot == null) return [];
    const path = normalizedPath(physical.workspaceRoot);
    const matches = input.nativeProjects.flatMap((native) =>
      native.workingCopies.flatMap((copy) =>
        copy.status === "active" &&
        normalizedPath(copy.path) === path &&
        input.computers.some(
          (computer) =>
            computer.id === copy.computerId && computer.environmentId === physical.environmentId,
        )
          ? [{ nativeProjectId: native.id, copy }]
          : [],
      ),
    );
    if (matches.length !== 1 || matches[0] === undefined) return [];
    const match = matches[0];
    return [
      {
        instanceId,
        nativeProjectId: match.nativeProjectId,
        projectId: physical.id,
        environmentId: physical.environmentId,
        proof: {
          kind: "working-copy",
          workingCopyId: match.copy.id,
          computerId: match.copy.computerId,
        },
      },
    ];
  });
}
