import type {
  CtoxWorkjetProjectProjection,
  EnvironmentId,
  ProjectId,
  WorkjetComputer,
} from "@workjet/contracts";
import { workjetWorkingCopyMatchesDraftSession } from "./availableProjects";

/**
 * A selected logical project can have different physical IDs on each computer.
 * Its confirmed working copies determine the visible conversations; a missing
 * selection is empty, never an implicit request for every project.
 */
export function workjetProjectConversationKeys(input: {
  readonly project: CtoxWorkjetProjectProjection | null;
  readonly computers: readonly WorkjetComputer[];
  readonly projects: readonly {
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }[];
}): ReadonlySet<string> {
  const keys = new Set<string>();
  if (input.project === null) return keys;
  for (const physical of input.projects) {
    if (
      !workjetWorkingCopyMatchesDraftSession({
        project: input.project,
        computers: input.computers,
        draftSession: {
          environmentId: physical.environmentId,
          projectId: physical.id,
          worktreePath: physical.workspaceRoot,
        },
      })
    )
      continue;
    keys.add(`${physical.environmentId}:${physical.id}`);
    // An unsent draft may still carry the logical ID until server promotion.
    keys.add(`${physical.environmentId}:${input.project.id}`);
  }
  return keys;
}
