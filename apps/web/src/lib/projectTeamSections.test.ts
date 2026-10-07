import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_WORKJET_THREAD_CONFIG, ProjectId, ThreadId } from "@workjet/contracts";
import type { WorkjetThreadConfig } from "@workjet/contracts";
import { groupThreadsByProjectTeam, projectTeamSectionOf } from "./projectTeamSections";

const PROJECT_ID = ProjectId.make("project-1");
const SUPERVISOR_ID = ThreadId.make("supervisor");
const CREATED_AT = "2026-10-07T10:00:00.000Z";

function thread(
  id: string,
  team?: NonNullable<Extract<WorkjetThreadConfig, { schemaVersion: 2 }>["team"]>,
) {
  return {
    id,
    workjetConfig: (team === undefined
      ? DEFAULT_WORKJET_THREAD_CONFIG
      : { ...DEFAULT_WORKJET_THREAD_CONFIG, team }) as WorkjetThreadConfig,
  };
}

const supervisor = thread("supervisor", {
  role: "supervisor",
  projectId: PROJECT_ID,
  threadId: SUPERVISOR_ID,
  parentThreadId: null,
  goal: "Coordinate the project",
  createdAt: CREATED_AT,
});
const parent = thread("parent", {
  role: "specialist",
  projectId: PROJECT_ID,
  threadId: ThreadId.make("parent"),
  parentThreadId: SUPERVISOR_ID,
  domain: "desktop",
  goal: "Own the desktop app",
  createdAt: CREATED_AT,
});
const worker = thread("worker", {
  role: "worker",
  projectId: PROJECT_ID,
  threadId: ThreadId.make("worker"),
  parentThreadId: SUPERVISOR_ID,
  packageId: "pr-1",
  goal: "Land one PR",
  createdAt: CREATED_AT,
});
const plain = thread("plain");

describe("projectTeamSections", () => {
  it("maps team roles to sidebar sections", () => {
    expect(projectTeamSectionOf(supervisor)).toBe("supervisor");
    expect(projectTeamSectionOf(parent)).toBe("parents");
    expect(projectTeamSectionOf(worker)).toBe("workers");
    expect(projectTeamSectionOf(plain)).toBe("other");
  });

  it("groups threads and keeps their order inside a section", () => {
    const second = { ...parent, id: "parent-2" };
    const groups = groupThreadsByProjectTeam([worker, parent, plain, supervisor, second]);
    expect(groups.supervisor.map((t) => t.id)).toEqual(["supervisor"]);
    expect(groups.parents.map((t) => t.id)).toEqual(["parent", "parent-2"]);
    expect(groups.workers.map((t) => t.id)).toEqual(["worker"]);
    expect(groups.other.map((t) => t.id)).toEqual(["plain"]);
  });
});
