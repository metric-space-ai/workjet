import { type CtoxWorkjetProjectProjection, type WorkjetComputer } from "@workjet/contracts";
import { newCommandId } from "./lib/utils";
import { createWorkjetProject, type WorkjetProjectControlPort } from "./workjetProjectControl";
import {
  resolveProjectHistoryBindings,
  type ProjectHistoryIdentity,
} from "./workjetProjectIdentity";

/** The existing native project.create control is an ID-preserving project upsert. */
export async function syncWorkjetProjectTitle(input: {
  readonly instanceId: string | null;
  readonly nativeProjects: readonly CtoxWorkjetProjectProjection[];
  readonly projects: readonly ProjectHistoryIdentity[];
  readonly computers: readonly WorkjetComputer[];
  readonly title: string;
  readonly port?: WorkjetProjectControlPort | undefined;
}): Promise<readonly CtoxWorkjetProjectProjection[]> {
  const title = input.title.trim();
  if (title === "") throw new Error("Project title cannot be empty.");
  if (input.instanceId === null) return [];
  const bindings = resolveProjectHistoryBindings(input);
  if (
    input.projects.some(
      (project) =>
        project.ctoxRegistration?.instanceId === input.instanceId &&
        !bindings.some(
          (binding) =>
            binding.environmentId === project.environmentId && binding.projectId === project.id,
        ),
    )
  ) {
    throw new Error("Reconnect to the project's instance before synchronizing its name.");
  }
  const ids = new Set(bindings.map((binding) => binding.nativeProjectId));
  const confirmed: CtoxWorkjetProjectProjection[] = [];
  for (const project of input.nativeProjects) {
    if (!ids.has(project.id) || project.title === title) continue;
    const result = await createWorkjetProject(
      input.instanceId,
      {
        action: "project.create",
        commandId: newCommandId(),
        projectId: project.id,
        title,
        createdAt: project.createdAt ?? new Date().toISOString(),
      },
      input.port,
    );
    if (result._tag !== "completed") {
      throw new Error(
        `CTOX did not confirm the project name (${result.code}). Retry when connected.`,
      );
    }
    if (
      result.response.action !== "project.create" ||
      result.response.project.id !== project.id ||
      result.response.project.title !== title
    ) {
      throw new Error("CTOX returned a different project or name. The local name was not changed.");
    }
    confirmed.push(result.response.project);
  }
  return confirmed;
}
