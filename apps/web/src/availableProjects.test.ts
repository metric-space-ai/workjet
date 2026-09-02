import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  WorkjetComputerId,
  type CtoxWorkjetProjectProjection,
  type WorkjetComputer,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildAvailableProjects, workjetProjectMatchesDraftSession } from "./availableProjects";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");
const localProjectId = ProjectId.make("11111111-1111-4111-8111-111111111111");
const workjetProjectId = ProjectId.make("22222222-2222-4222-8222-222222222222");

const localProject = {
  id: localProjectId,
  title: "Local project",
  environmentId: localEnvironmentId,
  workspaceRoot: "/workspace/local",
} as EnvironmentProject;

const computer: WorkjetComputer = {
  id: WorkjetComputerId.make("computer-remote"),
  label: "Remote computer",
  environmentId: remoteEnvironmentId,
  presentationKind: "remote",
  harnesses: [],
};

function syncedProject(
  options: {
    readonly status?: "active" | "detached";
    readonly computerId?: string;
  } = {},
): CtoxWorkjetProjectProjection {
  return {
    id: workjetProjectId,
    title: "Synced project",
    workingCopies: [
      {
        id: "working-copy-remote",
        computerId: options.computerId ?? computer.id,
        path: "/workspace/synced",
        status: options.status ?? "active",
      },
    ],
  };
}

describe("buildAvailableProjects", () => {
  it("returns local projects without a resolved computer", () => {
    expect(
      buildAvailableProjects({ projects: [localProject], workjetProjects: [], computer: null }),
    ).toEqual([
      {
        kind: "local",
        id: localProjectId,
        title: "Local project",
        environmentId: localEnvironmentId,
        path: "/workspace/local",
      },
    ]);
  });

  it("returns a sync-only project with an active working copy on the resolved computer", () => {
    expect(
      buildAvailableProjects({
        projects: [],
        workjetProjects: [syncedProject()],
        computer,
      }),
    ).toEqual([
      {
        kind: "workjet",
        id: workjetProjectId,
        title: "Synced project",
        environmentId: remoteEnvironmentId,
        path: "/workspace/synced",
        workingCopyId: "working-copy-remote",
      },
    ]);
  });

  it("keeps one local entry after the server project is created at the working-copy path", () => {
    const serverProject = {
      ...localProject,
      environmentId: computer.environmentId,
      workspaceRoot: "/workspace/synced/",
    } as EnvironmentProject;

    expect(
      buildAvailableProjects({
        projects: [serverProject],
        workjetProjects: [syncedProject()],
        computer,
      }),
    ).toEqual([
      {
        kind: "local",
        id: serverProject.id,
        title: serverProject.title,
        environmentId: computer.environmentId,
        path: serverProject.workspaceRoot,
      },
    ]);
  });

  it("excludes a sync project without an active working copy on the resolved computer", () => {
    expect(
      buildAvailableProjects({
        projects: [],
        workjetProjects: [syncedProject({ status: "detached" })],
        computer,
      }),
    ).toEqual([]);
  });

  it("excludes an active working copy assigned to a different computer", () => {
    expect(
      buildAvailableProjects({
        projects: [],
        workjetProjects: [syncedProject({ computerId: "computer-other" })],
        computer,
      }),
    ).toEqual([]);
  });

  it("matches a draft to its active working copy in the instance project registry", () => {
    expect(
      workjetProjectMatchesDraftSession({
        project: syncedProject(),
        computers: [computer],
        draftSession: {
          environmentId: computer.environmentId,
          projectId: workjetProjectId,
          worktreePath: "/workspace/synced/",
        },
      }),
    ).toBe(true);
  });

  it("does not match a draft with the same project id on another computer environment", () => {
    expect(
      workjetProjectMatchesDraftSession({
        project: syncedProject(),
        computers: [computer],
        draftSession: {
          environmentId: localEnvironmentId,
          projectId: workjetProjectId,
          worktreePath: "/workspace/synced",
        },
      }),
    ).toBe(false);
  });

  it("keeps only local projects when no computer can be resolved", () => {
    expect(
      buildAvailableProjects({
        projects: [localProject],
        workjetProjects: [syncedProject()],
        computer: null,
      }),
    ).toHaveLength(1);
  });
});
