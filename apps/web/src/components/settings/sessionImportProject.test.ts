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
    attachLocalProjectFolder: vi.fn(async (chosen: SessionImportProject) => chosen),
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
  it("ignores unrelated folder-free projects when creating an import destination", async () => {
    const deps = port();
    const created = await prepareSessionImportProject({
      presentationInstanceId: null,
      environmentId,
      destination: {
        kind: "new",
        title: "Imported work",
        workspaceRoot: "/workspace/new",
      },
      localProjects: [{ ...project, workspaceRoot: null } as unknown as OrchestrationProjectShell],
      port: deps,
    });
    expect(created.workspaceRoot).toBe("/workspace/new");
    expect(created.id).not.toBe(project.id);
    expect(deps.createLocalProject).toHaveBeenCalledWith(created);
  });
  it("does not register a working copy after local folder binding fails", async () => {
    const deps = {
      ...port(),
      attachLocalProjectFolder: vi.fn(async () => {
        throw new Error("Folder binding failed");
      }),
    };
    await expect(
      prepareSessionImportProject({
        presentationInstanceId: "instance-a",
        environmentId,
        destination: { kind: "existing", project },
        localProjects: [
          { ...project, workspaceRoot: null } as unknown as OrchestrationProjectShell,
        ],
        port: deps,
      }),
    ).rejects.toThrow("Folder binding failed");
    expect(deps.createLocalProject).not.toHaveBeenCalled();
    expect(deps.confirmLogicalProject).not.toHaveBeenCalled();
  });
  it("binds an existing folder-free project before native working-copy confirmation", async () => {
    const actions: string[] = [];
    const deps = {
      ...port(),
      listLogicalProjects: async () => {
        actions.push("list");
        return [projection];
      },
      attachLocalProjectFolder: vi.fn(async (chosen: SessionImportProject) => {
        actions.push("bind");
        expect(chosen).toEqual(project);
        return chosen;
      }),
      confirmLogicalProject: vi.fn(async (chosen: SessionImportProject) => {
        actions.push("confirm");
        expect(chosen).toEqual(project);
      }),
    };
    const result = await prepareSessionImportProject({
      presentationInstanceId: "instance-a",
      environmentId,
      destination: { kind: "existing", project },
      localProjects: [{ ...project, workspaceRoot: null } as unknown as OrchestrationProjectShell],
      port: deps,
    });
    expect(result).toEqual(project);
    expect(actions).toEqual(["list", "bind", "confirm"]);
    expect(deps.createLocalProject).not.toHaveBeenCalled();
  });
  it.each([
    {
      label: "different project",
      id: ProjectId.make("different"),
      workspaceRoot: project.workspaceRoot,
    },
    { label: "different folder", id: project.id, workspaceRoot: "/workspace/different" },
  ])("refuses a confirmed binding for a $label", async ({ id, workspaceRoot }) => {
    const deps = {
      ...port(),
      attachLocalProjectFolder: vi.fn(async () => ({ ...project, id, workspaceRoot })),
    };
    await expect(
      prepareSessionImportProject({
        presentationInstanceId: "instance-a",
        environmentId,
        destination: { kind: "existing", project },
        localProjects: [
          { ...project, workspaceRoot: null } as unknown as OrchestrationProjectShell,
        ],
        port: deps,
      }),
    ).rejects.toThrow("binding was not confirmed");
    expect(deps.confirmLogicalProject).not.toHaveBeenCalled();
  });
  it("stops native confirmation if the active context changes during folder binding", async () => {
    let active = true;
    const deps = {
      ...port(),
      isActive: () => active,
      attachLocalProjectFolder: vi.fn(async () => {
        active = false;
        return project;
      }),
    };
    await expect(
      prepareSessionImportProject({
        presentationInstanceId: "instance-a",
        environmentId,
        destination: { kind: "existing", project },
        localProjects: [
          { ...project, workspaceRoot: null } as unknown as OrchestrationProjectShell,
        ],
        port: deps,
      }),
    ).rejects.toThrow("changed");
    expect(deps.confirmLogicalProject).not.toHaveBeenCalled();
  });
  it("retains the local binding when native confirmation fails and reuses it on retry", async () => {
    const localProjects = [
      { ...project, workspaceRoot: null } as unknown as OrchestrationProjectShell,
    ];
    const deps = {
      ...port(),
      attachLocalProjectFolder: vi.fn(async (chosen: SessionImportProject) => {
        localProjects[0] = chosen as unknown as OrchestrationProjectShell;
        return chosen;
      }),
      confirmLogicalProject: vi.fn(async () => {
        throw new Error("CTOX offline");
      }),
    };
    const input = {
      presentationInstanceId: "instance-a",
      environmentId,
      destination: { kind: "existing" as const, project },
      localProjects,
      port: deps,
    };
    await expect(prepareSessionImportProject(input)).rejects.toThrow("CTOX offline");
    await expect(prepareSessionImportProject(input)).rejects.toThrow("CTOX offline");
    expect(deps.attachLocalProjectFolder).toHaveBeenCalledTimes(1);
    expect(deps.confirmLogicalProject).toHaveBeenCalledTimes(2);
    expect(deps.createLocalProject).not.toHaveBeenCalled();
    expect(localProjects[0]?.id).toBe(project.id);
  });
});
