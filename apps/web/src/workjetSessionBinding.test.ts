import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  WorkjetComputerId,
  type CtoxWorkjetProjectProjection,
  type CtoxWorkjetSessionControlResult,
  type WorkjetComputer,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkjetProjectRegistrySnapshot } from "./workjetProjectRegistry";
import { resolveDraftCtoxSessionTarget, withCtoxSessionBinding } from "./workjetSessionBinding";

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

describe("withCtoxSessionBinding", () => {
  it("stores a completed session projection in the thread configuration", () => {
    const result = {
      _tag: "completed",
      response: {
        action: "session.create",
        session: {
          id: "session-1",
          projectId: ctoxProjectId,
          workingCopyId: "working-copy-local",
          computerId: computer.id,
          threadId: "thread-1",
          codingSessionId: null,
          runStatus: "running",
          fenceEpoch: 4,
          activeTransferId: null,
          updatedAtMs: 1,
        },
      },
    } satisfies CtoxWorkjetSessionControlResult;

    expect(
      withCtoxSessionBinding(DEFAULT_WORKJET_THREAD_CONFIG, {
        instanceId: "managed:welsch",
        result,
      }),
    ).toEqual({
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      ctoxSession: {
        instanceId: "managed:welsch",
        sessionId: "session-1",
        fenceEpoch: 4,
      },
    });
  });

  it("clears the session binding after a failed registration", () => {
    const config = {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      ctoxSession: {
        instanceId: "managed:welsch",
        sessionId: "stale-session",
        fenceEpoch: 2,
      },
    };
    const result = {
      _tag: "failed",
      code: "not_active",
    } satisfies CtoxWorkjetSessionControlResult;

    expect(withCtoxSessionBinding(config, { instanceId: "managed:welsch", result })).toEqual({
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      ctoxSession: null,
    });
  });
});

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
