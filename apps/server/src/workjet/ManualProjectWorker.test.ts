import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@workjet/contracts";
import { manualProjectWorkerConfig, manualProjectWorkerParent } from "./ManualProjectWorker.ts";
import { validateManualWorkerSource } from "./ManualProjectWorkerSource.ts";
import type { VcsStatusResult } from "@workjet/contracts";
const projectId = ProjectId.make("project");
const thread = {
  id: ThreadId.make("manual"),
  projectId,
  title: "User task",
  createdAt: "2026-10-10T10:00:00.000Z",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  archivedAt: null,
  workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
} as unknown as OrchestrationThreadShell;
const supervisor = {
  ...thread,
  id: ThreadId.make("supervisor"),
  workjetConfig: {
    ...DEFAULT_WORKJET_THREAD_CONFIG,
    role: "orchestrator",
    team: {
      role: "supervisor",
      projectId,
      threadId: ThreadId.make("supervisor"),
      parentThreadId: null,
      goal: "Own project",
      createdAt: thread.createdAt,
    },
  },
} as OrchestrationThreadShell;
describe("manual project worker qualification", () => {
  it("keeps standalone chats unchanged and uses only the actual project supervisor", () => {
    expect(manualProjectWorkerParent(thread, [thread])).toBeUndefined();
    expect(
      manualProjectWorkerParent(thread, [
        thread,
        { ...supervisor, projectId: ProjectId.make("other") },
      ]),
    ).toBeUndefined();
    expect(manualProjectWorkerParent(thread, [thread, supervisor])).toBe(supervisor);
    expect(manualProjectWorkerParent(supervisor, [thread, supervisor])).toBeUndefined();
  });
  it("excludes specialists and workers", () => {
    const config = manualProjectWorkerConfig(
      thread,
      supervisor,
      EnvironmentId.make("local"),
      "Do task",
    );
    expect(
      manualProjectWorkerParent({ ...thread, workjetConfig: config }, [supervisor]),
    ).toBeUndefined();
    const specialist = {
      ...thread,
      workjetConfig: {
        ...DEFAULT_WORKJET_THREAD_CONFIG,
        team: {
          role: "specialist",
          projectId,
          threadId: thread.id,
          parentThreadId: supervisor.id,
          domain: "review",
          goal: "Review",
          createdAt: thread.createdAt,
        },
      },
    } as OrchestrationThreadShell;
    expect(manualProjectWorkerParent(specialist, [supervisor])).toBeUndefined();
  });
  it("fails visibly rather than reusing a historical shared checkout", () => {
    const used = { ...thread, latestTurn: {} } as OrchestrationThreadShell;
    expect(() => manualProjectWorkerParent(used, [supervisor])).toThrow(
      "explicit isolated-worker migration",
    );
    expect(manualProjectWorkerParent(used, [])).toBeUndefined();
  });
  it("requires a real available supervisor for a registered project", () => {
    expect(() => manualProjectWorkerParent(thread, [], true)).toThrow("no available supervisor");
    expect(() =>
      manualProjectWorkerParent(thread, [{ ...supervisor, archivedAt: thread.createdAt }], true),
    ).toThrow("no available supervisor");
    expect(manualProjectWorkerParent(thread, [supervisor], true)).toBe(supervisor);
    expect(manualProjectWorkerParent(thread, [], false)).toBeUndefined();
  });
  it("rejects ambiguous supervisors", () => {
    expect(() =>
      manualProjectWorkerParent(thread, [
        supervisor,
        { ...supervisor, id: ThreadId.make("duplicate") },
      ]),
    ).toThrow("multiple supervisors");
  });
  it("retains capabilities and establishes retry-stable native ownership", () => {
    const original = {
      ...thread,
      workjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, managedInstructions: "Keep task" },
    };
    const config = manualProjectWorkerConfig(
      original,
      supervisor,
      EnvironmentId.make("local"),
      " Do task ",
    );
    expect(config).toMatchObject({
      schemaVersion: 2,
      role: "worker",
      managedInstructions: "Keep task",
      parent: { environmentId: "local", threadId: supervisor.id },
      team: {
        role: "worker",
        packageId: `manual:${thread.id}`,
        goal: "Do task",
        threadId: thread.id,
      },
    });
    expect(
      manualProjectWorkerConfig(original, supervisor, EnvironmentId.make("local"), "Do task"),
    ).toEqual(config);
  });
});

const published = {
  isRepo: true,
  hasPrimaryRemote: true,
  hasUpstream: true,
  aheadCount: 0,
  hasWorkingTreeChanges: false,
} as VcsStatusResult;
it("requires published clean source and never inherits an existing checkout", () => {
  expect(validateManualWorkerSource(thread, [], published)).toEqual({
    branch: `workjet/worker/${thread.id}`,
    resuming: false,
  });
  expect(
    validateManualWorkerSource({ ...thread, branch: "main", worktreePath: null }, [], published),
  ).toEqual({ branch: `workjet/worker/${thread.id}`, resuming: false });
  for (const status of [
    { ...published, hasWorkingTreeChanges: true },
    { ...published, aheadCount: 1 },
    { ...published, hasUpstream: false },
    { ...published, isRepo: false },
  ])
    expect(() => validateManualWorkerSource(thread, [], status)).toThrow("clean and published");
  expect(() =>
    validateManualWorkerSource({ ...thread, worktreePath: "/user/work" }, [], published),
  ).toThrow("ownership is ambiguous");
  const owned = {
    ...thread,
    branch: `workjet/worker/${thread.id}`,
    worktreePath: "/workers/manual",
  };
  expect(validateManualWorkerSource(owned, [], published).resuming).toBe(true);
  expect(() =>
    validateManualWorkerSource(
      owned,
      [{ ...supervisor, worktreePath: owned.worktreePath }],
      published,
    ),
  ).toThrow("shared");
});
