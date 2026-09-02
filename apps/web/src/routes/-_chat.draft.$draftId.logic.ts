import type { WorkjetComputer } from "@t3tools/contracts";

import type { BusinessOsCodeScopeSnapshot } from "../businessOsCodeScope";
import { businessOsCodeScopeContainsEnvironment } from "../businessOsCodeScope";
import type { DraftSessionState } from "../composerDraftStore";
import {
  workjetProjectMatchesDraftSession,
  workjetWorkingCopyMatchesDraftSession,
} from "../availableProjects";
import type { WorkjetProjectRegistrySnapshot } from "../workjetProjectRegistry";

export type DraftActiveInstanceStatus = "active" | "pending" | "foreign";

export function shouldRedirectDraftToIndex(input: {
  readonly draftSessionPresent: boolean;
  readonly activeInstanceStatus: DraftActiveInstanceStatus;
  readonly canonicalThreadPresent: boolean;
}): boolean {
  return (
    !input.canonicalThreadPresent &&
    (!input.draftSessionPresent || input.activeInstanceStatus === "foreign")
  );
}

export function resolveDraftActiveInstanceStatus(input: {
  readonly draftSession: Pick<
    DraftSessionState,
    "environmentId" | "projectId" | "worktreePath"
  > | null;
  readonly businessOsCodeScope: BusinessOsCodeScopeSnapshot;
  readonly workjetProjectRegistry: WorkjetProjectRegistrySnapshot;
  readonly computers: readonly WorkjetComputer[];
}): DraftActiveInstanceStatus {
  const draftSession = input.draftSession;
  if (draftSession === null) return "foreign";
  if (
    businessOsCodeScopeContainsEnvironment(input.businessOsCodeScope, draftSession.environmentId)
  ) {
    return "active";
  }
  if (input.businessOsCodeScope.phase !== "ready") return "pending";
  if (
    input.workjetProjectRegistry.presentationInstanceId !==
      input.businessOsCodeScope.presentationInstanceId ||
    input.workjetProjectRegistry.phase === "idle" ||
    input.workjetProjectRegistry.phase === "loading"
  ) {
    return "pending";
  }

  const identityProject = input.workjetProjectRegistry.projects.find(
    (project) => project.id === draftSession.projectId,
  );
  const matchesActiveWorkingCopy = identityProject
    ? workjetProjectMatchesDraftSession({
        project: identityProject,
        computers: input.computers,
        draftSession,
      })
    : input.workjetProjectRegistry.projects.some((project) =>
        workjetWorkingCopyMatchesDraftSession({
          project,
          computers: input.computers,
          draftSession,
        }),
      );
  return matchesActiveWorkingCopy ? "active" : "foreign";
}
