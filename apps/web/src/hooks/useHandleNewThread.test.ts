import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AvailableProject } from "../availableProjects";
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
});
