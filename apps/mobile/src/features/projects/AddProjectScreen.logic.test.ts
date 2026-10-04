import type { EnvironmentConnectionPhase } from "@workjet/client-runtime/connection";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveAddProjectEnvironment,
  resolveProjectSupervisorTarget,
} from "./AddProjectScreen.logic";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

const PROJECT = ProjectId.make("project-a");
const THREAD = ThreadId.make("supervisor-a");
const project = { id: PROJECT, environmentId: ENVIRONMENT_A };
function supervisor(environmentId = ENVIRONMENT_A, threadId = THREAD) {
  return {
    id: threadId,
    environmentId,
    projectId: PROJECT,
    archivedAt: null,
    deletedAt: null,
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      role: "orchestrator" as const,
      team: {
        role: "supervisor" as const,
        projectId: PROJECT,
        threadId,
        parentThreadId: null,
        goal: "Coordinate this project",
        createdAt: "2026-10-04T00:00:00.000Z",
      },
    },
  };
}
function target(
  threads: Parameters<typeof resolveProjectSupervisorTarget>[0]["threads"],
  projects: Parameters<typeof resolveProjectSupervisorTarget>[0]["projects"] = [project],
) {
  return resolveProjectSupervisorTarget({
    environmentId: ENVIRONMENT_A,
    projectId: PROJECT,
    projects,
    threads,
  });
}

describe("resolveProjectSupervisorTarget", () => {
  it("opens the one saved supervisor in the exact project and environment", () => {
    expect(target([supervisor()])).toEqual({
      status: "ready",
      thread: { environmentId: ENVIRONMENT_A, threadId: THREAD },
    });
  });
  it("waits for the project and supervisor projections without selecting a foreign environment", () => {
    expect(target([supervisor()], [])).toEqual({ status: "pending" });
    expect(target([])).toEqual({ status: "pending" });
    expect(target([supervisor(ENVIRONMENT_B)])).toEqual({ status: "pending" });
    expect(target([supervisor()], [{ ...project, environmentId: ENVIRONMENT_B }])).toEqual({
      status: "pending",
    });
  });
  it("rejects duplicate active supervisors instead of selecting the first", () => {
    expect(
      target([supervisor(), supervisor(ENVIRONMENT_A, ThreadId.make("supervisor-b"))]),
    ).toEqual({ status: "conflict" });
  });
  it("rejects a supervisor with a foreign project or mismatched thread binding", () => {
    const saved = supervisor();
    expect(
      target([
        {
          ...saved,
          workjetConfig: {
            ...saved.workjetConfig,
            team: { ...saved.workjetConfig.team, projectId: ProjectId.make("foreign-project") },
          },
        },
      ]),
    ).toEqual({ status: "conflict" });
    expect(
      target([
        {
          ...saved,
          workjetConfig: {
            ...saved.workjetConfig,
            team: { ...saved.workjetConfig.team, threadId: ThreadId.make("foreign-thread") },
          },
        },
      ]),
    ).toEqual({ status: "conflict" });
  });
  it("does not open archived or deleted supervisors or ordinary task chats", () => {
    expect(target([{ ...supervisor(), archivedAt: "2026-10-04T00:00:00.000Z" }])).toEqual({
      status: "unavailable",
    });
    expect(target([{ ...supervisor(), deletedAt: "2026-10-04T00:00:00.000Z" }])).toEqual({
      status: "unavailable",
    });
    expect(target([{ ...supervisor(), workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG }])).toEqual({
      status: "pending",
    });
  });
});

function environment(environmentId: EnvironmentId, connectionState: EnvironmentConnectionPhase) {
  return { environmentId, connectionState };
}

describe("resolveAddProjectEnvironment", () => {
  it("does not redirect an explicit unavailable environment to another environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      ),
    ).toBeNull();
  });

  it("resolves an explicit connected environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "connected"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      )?.environmentId,
    ).toBe(ENVIRONMENT_A);
  });

  it("defaults to the first connected environment when no environment is requested", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        null,
      )?.environmentId,
    ).toBe(ENVIRONMENT_B);
  });
});
