import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@workjet/contracts";
import type { WorkjetThreadConfig } from "@workjet/contracts";
import {
  groupThreadsByProjectTeam,
  projectTeamSectionOf,
  projectTeamStatus,
  projectTeamProgressPreview,
  projectTeamHarnessLabel,
  duplicateProjectTeamTitles,
  projectTeamParentTitle,
  PROJECT_TEAM_SECTIONS,
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
    expect(projectTeamSectionOf(plain)).toBe("workers");
  });

  it("groups threads and keeps their order inside a section", () => {
    const second = { ...parent, id: "parent-2" };
    const groups = groupThreadsByProjectTeam([worker, parent, plain, supervisor, second]);
    expect(groups.supervisor.map((t) => t.id)).toEqual(["supervisor"]);
    expect(groups.parents.map((t) => t.id)).toEqual(["parent", "parent-2"]);
    expect(groups.workers.map((t) => t.id)).toEqual(["worker", "plain"]);
    expect(Object.keys(groups)).toEqual(["supervisor", "parents", "workers"]);
  });
});

const idle = { session: null, hasPendingApprovals: false, hasPendingUserInput: false };

it("uses the exact project labels and includes roleless project chats", () => {
  expect(PROJECT_TEAM_SECTIONS.map((section) => section.label)).toEqual([
    "Supervisor",
    "Persistent Worker",
    "One-Shot Worker",
  ]);
  expect(projectTeamSectionOf(plain)).toBe("workers");
});

it("resolves dispatched parent titles without crossing environments or projects", () => {
  const child = { ...worker, title: "Worker", environmentId: "local" };
  const owner = { ...supervisor, title: "Supervisor title", environmentId: "local" };
  expect(projectTeamParentTitle(child, [child, owner])).toBe("Supervisor title");
  expect(projectTeamParentTitle(child, [])).toBeUndefined();
  const specialist = { ...parent, title: "Persistent owner", environmentId: "local" };
  const specialistChild = {
    ...child,
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      team: {
        role: "worker" as const,
        projectId: PROJECT_ID,
        threadId: ThreadId.make("worker"),
        parentThreadId: ThreadId.make("parent"),
        packageId: "pr-1",
        goal: "Land one PR",
        createdAt: CREATED_AT,
      },
    },
  };
  expect(projectTeamParentTitle(specialistChild, [specialist])).toBe("Persistent owner");
  expect(projectTeamParentTitle(child, [{ ...owner, environmentId: "remote" }])).toBeUndefined();
  const foreign = {
    ...owner,
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      team: {
        role: "supervisor" as const,
        projectId: ProjectId.make("foreign"),
        threadId: SUPERVISOR_ID,
        parentThreadId: null,
        goal: "Foreign",
        createdAt: CREATED_AT,
      },
    },
  };
  expect(projectTeamParentTitle(child, [foreign as typeof owner])).toBeUndefined();
  expect(
    projectTeamParentTitle({ ...plain, title: "Manual", environmentId: "local" }, [owner]),
  ).toBeUndefined();
});

it("uses a dispatched worker’s authoritative source environment and rejects inconsistent identities", () => {
  const source = { ...parent, title: "Mac persistent worker", environmentId: "mac" };
  const dispatched = {
    ...worker,
    title: "GPU task",
    environmentId: "gpu3",
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      schemaVersion: 2 as const,
      role: "worker" as const,
      parent: { environmentId: EnvironmentId.make("mac"), threadId: ThreadId.make("parent") },
      team: {
        role: "worker" as const,
        projectId: PROJECT_ID,
        threadId: ThreadId.make("worker"),
        parentThreadId: ThreadId.make("parent"),
        packageId: "remote-pr",
        goal: "Land one PR remotely",
        createdAt: CREATED_AT,
      },
    },
  };
  expect(projectTeamParentTitle(dispatched, [source])).toBe("Mac persistent worker");
  expect(
    projectTeamParentTitle(dispatched, [{ ...source, environmentId: "gpu3" }]),
  ).toBeUndefined();
  const foreign = {
    ...source,
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      team: {
        role: "specialist" as const,
        projectId: ProjectId.make("foreign"),
        threadId: ThreadId.make("parent"),
        parentThreadId: SUPERVISOR_ID,
        domain: "desktop",
        goal: "Other project",
        createdAt: CREATED_AT,
      },
    },
  };
  expect(projectTeamParentTitle(dispatched, [foreign])).toBeUndefined();
  expect(
    projectTeamParentTitle(
      {
        ...dispatched,
        workjetConfig: {
          ...dispatched.workjetConfig,
          parent: { ...dispatched.workjetConfig.parent, threadId: ThreadId.make("wrong-parent") },
        },
      },
      [source],
    ),
  ).toBeUndefined();
});

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

  it("shows an imported history’s actual assistant preview without inventing live status", () => {
    const imported = {
      ...idle,
      latestTurn: null,
      latestAssistantMessagePreview: "  Installed.\nVerification complete.  ",
      planProgress: { step: "Old plan" },
    };
    expect(projectTeamProgressPreview(imported)).toBe("Installed. Verification complete.");
    expect(projectTeamStatus(imported)).toEqual({ label: "Idle", dot: "bg-muted-foreground/50" });
    expect(
      projectTeamProgressPreview({
        ...imported,
        latestTurn: { assistantMessagePreview: "New reply" },
      }),
    ).toBe("New reply");
    expect(projectTeamProgressPreview({ latestAssistantMessagePreview: "   " })).toBe("");
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
