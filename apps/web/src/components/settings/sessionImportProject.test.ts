import {
  EnvironmentId,
  ProjectId,
  type CtoxWorkjetProjectProjection,
  type OrchestrationProjectShell,
} from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  prepareSessionImportProject,
  type SessionImportProject,
  type SessionImportProjectPort,
} from "./sessionImportProject";

const project: SessionImportProject = {
  id: ProjectId.make("project-a"),
  title: "Destination",
  workspaceRoot: "/workspace/destination",
};
const environmentId = EnvironmentId.make("computer-a");
const projection = {
  id: project.id,
  title: project.title,
  workingCopies: [],
} as unknown as CtoxWorkjetProjectProjection;
function port(): SessionImportProjectPort {
  return {
    isActive: () => true,
    listLogicalProjects: vi.fn(async () => [projection]),
    createLocalProject: vi.fn(async () => {}),
    confirmLogicalProject: vi.fn(async () => {}),
  };
}

describe("session import destination preparation", () => {
  it("creates the exact chosen Code mirror and confirms it in CTOX before returning", async () => {
    const actions: string[] = [];
    const result = await prepareSessionImportProject({
      presentationInstanceId: "instance-a",
      environmentId,
      destination: { kind: "existing", project },
      localProjects: [],
      port: {
        ...port(),
        listLogicalProjects: async () => {
          actions.push("list");
          return [projection];
        },
        createLocalProject: async (created) => {
          actions.push("local");
          expect(created.id).toBe(project.id);
        },
        confirmLogicalProject: async (confirmed) => {
          actions.push("ctox");
          expect(confirmed.id).toBe(project.id);
        },
      },
    });
    expect(result).toEqual(project);
    expect(actions).toEqual(["list", "local", "ctox"]);
  });
  it("does not recreate a local mirror or choose the source's project", async () => {
    const deps = port();
    await prepareSessionImportProject({
      presentationInstanceId: "instance-a",
      environmentId,
      destination: { kind: "existing", project },
      localProjects: [project as unknown as OrchestrationProjectShell],
      port: deps,
    });
    expect(deps.createLocalProject).not.toHaveBeenCalled();
    expect(deps.confirmLogicalProject).toHaveBeenCalledWith(project);
  });
  it("refuses a deleted logical project before any local create", async () => {
    const deps = { ...port(), listLogicalProjects: async () => [] };
    await expect(
      prepareSessionImportProject({
        presentationInstanceId: "instance-a",
        environmentId,
        destination: { kind: "existing", project },
        localProjects: [],
        port: deps,
      }),
    ).rejects.toThrow("no longer available");
    expect(deps.createLocalProject).not.toHaveBeenCalled();
  });
  it("stops after an instance switch during the project listing", async () => {
    let active = true;
    const deps = {
      ...port(),
      isActive: () => active,
      listLogicalProjects: async () => {
        active = false;
        return [projection];
      },
    };
    await expect(
      prepareSessionImportProject({
        presentationInstanceId: "instance-a",
        environmentId,
        destination: { kind: "existing", project },
        localProjects: [],
        port: deps,
      }),
    ).rejects.toThrow("changed");
    expect(deps.createLocalProject).not.toHaveBeenCalled();
    expect(deps.confirmLogicalProject).not.toHaveBeenCalled();
  });
  it("keeps a failed CTOX registration retryable on the same project id", async () => {
    const ids: string[] = [];
    const localProjects: OrchestrationProjectShell[] = [];
    const deps = {
      ...port(),
      createLocalProject: async (created: SessionImportProject) => {
        ids.push(created.id);
        localProjects.push(created as unknown as OrchestrationProjectShell);
      },
      confirmLogicalProject: async () => {
        throw new Error("CTOX offline");
      },
    };
    const input = {
      presentationInstanceId: "instance-a",
      environmentId,
      destination: {
        kind: "new" as const,
        title: "Imported work",
        workspaceRoot: "/workspace/new",
      },
      localProjects,
      port: deps,
    };
    await expect(prepareSessionImportProject(input)).rejects.toThrow("CTOX offline");
    await expect(prepareSessionImportProject(input)).rejects.toThrow("CTOX offline");
    expect(ids).toHaveLength(1);
    expect(localProjects[0]?.id).toBe(ids[0]);
  });
  it("creates named Code projects without requiring a desktop CTOX bridge", async () => {
    const deps = port();
    const created = await prepareSessionImportProject({
      presentationInstanceId: null,
      environmentId,
      destination: {
        kind: "new",
        title: "Selected conversations",
        workspaceRoot: "/workspace/new",
      },
      localProjects: [],
      port: deps,
    });
    expect(created.title).toBe("Selected conversations");
    expect(deps.listLogicalProjects).not.toHaveBeenCalled();
    expect(deps.confirmLogicalProject).not.toHaveBeenCalled();
    expect(deps.createLocalProject).toHaveBeenCalledWith(created);
  });
});
