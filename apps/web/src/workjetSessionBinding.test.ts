import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  WorkjetComputerId,
  type CtoxWorkjetProjectProjection,
  type WorkjetComputer,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkjetProjectRegistrySnapshot } from "./workjetProjectRegistry";
import { resolveDraftCtoxSessionTarget } from "./workjetSessionBinding";

const environmentId = EnvironmentId.make("environment-local");
const serverProjectId = ProjectId.make("11111111-1111-4111-8111-111111111111");
const ctoxProjectId = ProjectId.make("22222222-2222-4222-8222-222222222222");
const computer: WorkjetComputer = {
  id: WorkjetComputerId.make("computer-local"),
  label: "Local computer",
  environmentId,
  presentationKind: "local",
  harnesses: [],
};
const localProject = {
  id: serverProjectId,
  title: "Synced server project",
  environmentId,
  workspaceRoot: "/workspace/synced",
} as EnvironmentProject;

function syncedProject(
  path = "/workspace/synced",
  computerId: string = computer.id,
): CtoxWorkjetProjectProjection {
  return {
    id: ctoxProjectId,
    title: "Synced project",
    workingCopies: [
      {
        id: "working-copy-local",
        computerId,
        path,
        status: "active",
      },
    ],
  };
}

function registry(
  phase: WorkjetProjectRegistrySnapshot["phase"] = "ready",
  projects: readonly CtoxWorkjetProjectProjection[] = [syncedProject()],
): WorkjetProjectRegistrySnapshot {
  return {
    presentationInstanceId: "managed:welsch",
    phase,
    projects,
    selectedProjectId: ctoxProjectId,
  };
}

function resolve(
  overrides: {
    readonly path?: string;
    readonly registry?: WorkjetProjectRegistrySnapshot;
    readonly computers?: readonly WorkjetComputer[];
    readonly localProjects?: readonly EnvironmentProject[];
  } = {},
) {
  return resolveDraftCtoxSessionTarget({
    draft: {
      environmentId,
      projectId: serverProjectId,
      worktreePath: overrides.path ?? "/workspace/synced",
    },
    presentationInstanceId: "managed:welsch",
    registry: overrides.registry ?? registry(),
    computers: overrides.computers ?? [computer],
    localProjects: overrides.localProjects ?? [localProject],
  });
}

describe("resolveDraftCtoxSessionTarget", () => {
  it("resolves the CTOX project and active working copy for a synced draft", () => {
    expect(resolve()).toEqual({
      instanceId: "managed:welsch",
      ctoxProjectId,
      workingCopyId: "working-copy-local",
    });
  });

  it("returns null for a local project without a matching synced working copy", () => {
    expect(resolve({ registry: registry("ready", []) })).toBeNull();
  });

  it("returns null while the project registry is pending", () => {
    expect(resolve({ registry: registry("loading", []) })).toBeNull();
  });

  it.each([
    ["/workspace/synced/", "/workspace/synced"],
    ["/workspace/synced", "/workspace/synced/"],
  ])("normalizes draft path %s against working-copy path %s", (draftPath, workingCopyPath) => {
    expect(
      resolve({ path: draftPath, registry: registry("ready", [syncedProject(workingCopyPath)]) }),
    ).toMatchObject({ workingCopyId: "working-copy-local" });
  });

  it("returns null when the working copy belongs to another computer", () => {
    expect(
      resolve({ registry: registry("ready", [syncedProject(undefined, "computer-other")]) }),
    ).toBeNull();
  });
});
