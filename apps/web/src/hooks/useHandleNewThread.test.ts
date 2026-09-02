import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AvailableProject } from "../availableProjects";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { resolveNewThreadProjectTarget } from "./useHandleNewThread";

const newServerProjectId = ProjectId.make("33333333-3333-4333-8333-333333333333");
const existingServerProjectId = ProjectId.make("44444444-4444-4444-8444-444444444444");
const workjetProject: AvailableProject = {
  kind: "workjet",
  id: ProjectId.make("22222222-2222-4222-8222-222222222222"),
  title: "Synced project",
  environmentId: EnvironmentId.make("environment-remote"),
  path: "/workspace/synced",
  workingCopyId: "working-copy-remote",
};

function resetDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("Workjet new session target", () => {
  beforeEach(resetDraftStore);

  it("creates one server project and starts the draft with its ref and working-copy path", async () => {
    const createProject = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const reportProjectCreateFailure = vi.fn();

    const target = await resolveNewThreadProjectTarget({
      project: workjetProject,
      availableProjects: [workjetProject],
      projects: [],
      createProject,
      createProjectId: () => newServerProjectId,
      reportProjectCreateFailure,
    });

    expect(createProject).toHaveBeenCalledOnce();
    expect(createProject).toHaveBeenCalledWith({
      environmentId: workjetProject.environmentId,
      input: {
        projectId: newServerProjectId,
        title: workjetProject.title,
        workspaceRoot: workjetProject.path,
        createWorkspaceRootIfMissing: true,
      },
    });
    expect(reportProjectCreateFailure).not.toHaveBeenCalled();
    expect(target).toEqual({
      projectRef: {
        environmentId: workjetProject.environmentId,
        projectId: newServerProjectId,
      },
      workspaceOptions: {
        worktreePath: workjetProject.path,
        envMode: "local",
      },
    });

    const draftId = DraftId.make("draft-synced-project");
    if (target === null) throw new Error("expected a server-backed target");
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
      projectId: newServerProjectId,
      logicalProjectKey: scopedProjectKey(target.projectRef),
      worktreePath: workjetProject.path,
      envMode: "local",
    });
  });

  it("reuses a server project at the same normalized path without creating another", async () => {
    const existingProject = {
      id: existingServerProjectId,
      title: "Existing local project",
      environmentId: workjetProject.environmentId,
      workspaceRoot: `${workjetProject.path}/`,
    } as EnvironmentProject;
    const createProject = vi.fn().mockResolvedValue(AsyncResult.success(undefined));

    const target = await resolveNewThreadProjectTarget({
      project: workjetProject,
      availableProjects: [workjetProject],
      projects: [existingProject],
      createProject,
      createProjectId: () => newServerProjectId,
      reportProjectCreateFailure: vi.fn(),
    });

    expect(createProject).not.toHaveBeenCalled();
    expect(target).toEqual({
      projectRef: {
        environmentId: workjetProject.environmentId,
        projectId: existingServerProjectId,
      },
      workspaceOptions: {
        worktreePath: workjetProject.path,
        envMode: "local",
      },
    });
  });

  it("leaves the draft without a project and reports the create failure", async () => {
    const failure = AsyncResult.failure(Cause.fail(new Error("create failed")));
    const createProject = vi.fn().mockResolvedValue(failure);
    const reportProjectCreateFailure = vi.fn();

    const target = await resolveNewThreadProjectTarget({
      project: workjetProject,
      availableProjects: [workjetProject],
      projects: [],
      createProject,
      createProjectId: () => newServerProjectId,
      reportProjectCreateFailure,
    });

    expect(target).toBeNull();
    expect(reportProjectCreateFailure).toHaveBeenCalledOnce();
    expect(reportProjectCreateFailure).toHaveBeenCalledWith(failure);
    expect(useComposerDraftStore.getState().draftThreadsByThreadKey).toEqual({});
  });
});
