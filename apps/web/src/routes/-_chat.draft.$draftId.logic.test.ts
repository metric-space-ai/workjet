import {
  EnvironmentId,
  ProjectId,
  WorkjetComputerId,
  type CtoxWorkjetProjectProjection,
  type WorkjetComputer,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveDraftActiveInstanceStatus,
  shouldRedirectDraftToIndex,
} from "./-_chat.draft.$draftId.logic";

const computerEnvironmentId = EnvironmentId.make("385a20df-8851-44af-af9b-bf0297dbf755");
const relayEnvironmentId = EnvironmentId.make("environment-managed-instance");
const projectId = ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7");
const computer: WorkjetComputer = {
  id: WorkjetComputerId.make("50988886-2a39-4a55-9d91-640930524b13"),
  label: "This machine",
  environmentId: computerEnvironmentId,
  presentationKind: "local",
  harnesses: [],
};
const project: CtoxWorkjetProjectProjection = {
  id: projectId,
  title: "greppy",
  workingCopies: [
    {
      id: "working-copy-greppy",
      computerId: computer.id,
      path: "/Users/michaelwelsch/Documents/greppy",
      status: "active",
    },
  ],
};
const scope = {
  phase: "ready" as const,
  presentationInstanceId: "managed:322084e5-8239-48d7-b3c5-c5178fbe5822",
  businessOsInstanceId: "322084e5-8239-48d7-b3c5-c5178fbe5822" as never,
  environmentIds: new Set([relayEnvironmentId]),
  blocker: null,
};
const draftSession = {
  environmentId: computerEnvironmentId,
  projectId,
  worktreePath: "/Users/michaelwelsch/Documents/greppy",
};

function registry(projects: readonly CtoxWorkjetProjectProjection[]) {
  return {
    presentationInstanceId: scope.presentationInstanceId,
    phase: "ready" as const,
    projects,
    selectedProjectId: projects[0]?.id ?? null,
  };
}

describe("resolveDraftActiveInstanceStatus", () => {
  it("keeps a synced-project draft running on the active instance computer", () => {
    const activeInstanceStatus = resolveDraftActiveInstanceStatus({
      draftSession,
      businessOsCodeScope: scope,
      workjetProjectRegistry: registry([project]),
      computers: [computer],
    });

    expect(activeInstanceStatus).toBe("active");
    expect(
      shouldRedirectDraftToIndex({
        draftSessionPresent: true,
        activeInstanceStatus,
        canonicalThreadPresent: false,
      }),
    ).toBe(false);
  });

  it("redirects a draft whose synced project belongs to a different instance", () => {
    const activeInstanceStatus = resolveDraftActiveInstanceStatus({
      draftSession,
      businessOsCodeScope: scope,
      workjetProjectRegistry: registry([]),
      computers: [computer],
    });

    expect(activeInstanceStatus).toBe("foreign");
    expect(
      shouldRedirectDraftToIndex({
        draftSessionPresent: true,
        activeInstanceStatus,
        canonicalThreadPresent: false,
      }),
    ).toBe(true);
  });
});
