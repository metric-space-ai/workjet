import { workjetWorkingCopyMatchesDraftSession } from "./availableProjects";
import type { WorkjetProjectRegistrySnapshot } from "./workjetProjectRegistry";

export function resolvePrivateChatDraftProject(input: {
  registry: WorkjetProjectRegistrySnapshot;
  draft: Parameters<typeof workjetWorkingCopyMatchesDraftSession>[0]["draftSession"] | null;
  computers: Parameters<typeof workjetWorkingCopyMatchesDraftSession>[0]["computers"];
}) {
  if (input.registry.phase !== "ready" || input.draft === null) return undefined;
  const draft = input.draft;
  const matches = input.registry.projects.filter((project) =>
    workjetWorkingCopyMatchesDraftSession({
      project,
      computers: input.computers,
      draftSession: draft,
    }),
  );
  return matches.length === 1 && matches[0]?.id === input.registry.selectedProjectId
    ? matches[0]
    : undefined;
}
