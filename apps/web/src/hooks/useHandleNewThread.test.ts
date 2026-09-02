import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AvailableProject } from "../availableProjects";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { resolveNewThreadProjectTarget } from "./useHandleNewThread";

const workjetProject: AvailableProject = {
  kind: "workjet",
  id: ProjectId.make("22222222-2222-4222-8222-222222222222"),
  title: "Synced project",
  environmentId: EnvironmentId.make("environment-remote"),
  path: "/workspace/synced",
  workingCopyId: "working-copy-remote",
};

describe("Workjet new session target", () => {
  it("starts the draft on the computer environment at the working-copy path", () => {
    expect(
      resolveNewThreadProjectTarget({
        project: workjetProject,
        availableProjects: [workjetProject],
      }),
    ).toEqual({
      projectRef: {
        environmentId: workjetProject.environmentId,
        projectId: workjetProject.id,
      },
      workspaceOptions: {
        worktreePath: workjetProject.path,
        envMode: "local",
      },
    });
  });

  it("stores the computer environment, working-copy path, and synced project identity", () => {
    const target = resolveNewThreadProjectTarget({
      project: workjetProject,
      availableProjects: [workjetProject],
    });
    const draftId = DraftId.make("draft-synced-project");
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });

    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(
        scopedProjectKey(target.projectRef),
        target.projectRef,
        draftId,
        {
          threadId: ThreadId.make("thread-synced-project"),
          ...target.workspaceOptions,
        },
      );

    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      environmentId: workjetProject.environmentId,
      projectId: workjetProject.id,
      logicalProjectKey: scopedProjectKey(target.projectRef),
      worktreePath: workjetProject.path,
      envMode: "local",
    });
  });
});
