import type { CtoxWorkjetProjectProjection, WorkjetComputer } from "@workjet/contracts";
import {
  resolveProjectHistoryBindings,
  type ProjectHistoryIdentity,
} from "./workjetProjectIdentity";

/** One selected project's retained supervisor and proven physical histories. */
export function workjetProjectConversationKeys(input: {
  readonly instanceId: string | null;
  readonly project: CtoxWorkjetProjectProjection | null;
  readonly nativeProjects?: readonly CtoxWorkjetProjectProjection[];
  readonly computers: readonly WorkjetComputer[];
  readonly projects: readonly ProjectHistoryIdentity[];
}): ReadonlySet<string> {
  const keys = new Set<string>();
  if (input.project === null) return keys;
  for (const binding of resolveProjectHistoryBindings({
    instanceId: input.instanceId,
    nativeProjects: input.nativeProjects ?? [input.project],
    computers: input.computers,
    projects: input.projects,
  })) {
    if (binding.nativeProjectId !== input.project.id) continue;
    keys.add(`${binding.environmentId}:${binding.projectId}`);
    keys.add(`${binding.environmentId}:${input.project.id}`);
  }
  return keys;
}
