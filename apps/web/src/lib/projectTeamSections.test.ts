import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_WORKJET_THREAD_CONFIG, ProjectId, ThreadId } from "@workjet/contracts";
import type { WorkjetThreadConfig } from "@workjet/contracts";
import {
  groupThreadsByProjectTeam,
  projectTeamSectionOf,
  projectTeamStatus,
  projectTeamProgressPreview,
  projectTeamHarnessLabel,
  duplicateProjectTeamTitles,
} from "./projectTeamSections";

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

const idle = { session: null, hasPendingApprovals: false, hasPendingUserInput: false };

describe("project team row state", () => {
  it("shows actual running sessions and background work in yellow", () => {
    for (const status of ["running", "starting"]) {
      expect(projectTeamStatus({ ...idle, session: { status } })).toEqual({
        label: "Working",
        dot: "bg-amber-400",
      });
    }
    expect(projectTeamStatus({ ...idle, backgroundLiveness: "working" }).dot).toBe("bg-amber-400");
  });

  it("distinguishes waiting for Michael, failed sessions, and idle histories", () => {
    expect(
      projectTeamStatus({ ...idle, hasPendingApprovals: true, session: { status: "running" } }),
    ).toEqual({ label: "Needs attention", dot: "bg-rose-400" });
    expect(projectTeamStatus({ ...idle, hasPendingUserInput: true }).dot).toBe("bg-rose-400");
    expect(projectTeamStatus({ ...idle, session: { status: "error" } })).toEqual({
      label: "Error",
      dot: "bg-red-400",
    });
    expect(projectTeamStatus(idle)).toEqual({ label: "Idle", dot: "bg-muted-foreground/50" });
  });

  it("uses the assistant's latest message before an older plan caption", () => {
    expect(
      projectTeamProgressPreview({
        latestTurn: { assistantMessagePreview: "  PR ready.\nWaiting for review.  " },
        planProgress: { step: "Implement change" },
      }),
    ).toBe("PR ready. Waiting for review.");
    expect(
      projectTeamProgressPreview({
        latestTurn: { assistantMessagePreview: "  " },
        planProgress: { step: "Review change" },
      }),
    ).toBe("Review change");
    expect(projectTeamProgressPreview({ latestTurn: null })).toBe("");
  });

  it("disambiguates equal titles with real provider labels without renaming histories", () => {
    const sameTitle = [
      { title: "DevOps Refactor" },
      { title: "Models" },
      { title: "DevOps Refactor" },
    ];
    expect([...duplicateProjectTeamTitles(sameTitle)]).toEqual(["DevOps Refactor"]);
    expect(
      projectTeamHarnessLabel({
        session: { providerName: "codex" },
        modelSelection: { instanceId: "codex_personal" },
      }),
    ).toBe("Codex");
    expect(
      projectTeamHarnessLabel({
        session: { providerName: "claudeAgent" },
        modelSelection: { instanceId: "claudeAgent" },
      }),
    ).toBe("Claude");
    expect(
      projectTeamHarnessLabel({ session: null, modelSelection: { instanceId: "custom_harness" } }),
    ).toBe("custom_harness");
    expect(sameTitle[0]?.title).toBe("DevOps Refactor");
  });
});
