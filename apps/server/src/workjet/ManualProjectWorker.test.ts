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
const commissioned = {
  ...thread,
  workjetConfig: {
    ...DEFAULT_WORKJET_THREAD_CONFIG,
    role: "worker",
    parent: { environmentId: EnvironmentId.make("local"), threadId: supervisor.id },
  },
} as OrchestrationThreadShell;
describe("manual project worker qualification", () => {
  it("keeps ordinary project threads ordinary regardless of checkout or supervisor availability", () => {
    for (const checkout of [null, "/user/work"]) {
      const ordinary = { ...thread, worktreePath: checkout };
      expect(manualProjectWorkerParent(ordinary, [supervisor])).toBeUndefined();
      expect(manualProjectWorkerParent(ordinary, [])).toBeUndefined();
      expect(
        manualProjectWorkerParent(ordinary, [
          supervisor,
          { ...supervisor, id: ThreadId.make("duplicate") },
        ]),
      ).toBeUndefined();
    }
  });
  it("keeps ordinary Luma instructions and historical chats out of worker preparation", () => {
    const luma = {
      ...thread,
      worktreePath: "/user/luma",
      workjetConfig: {
        ...DEFAULT_WORKJET_THREAD_CONFIG,
        managedInstructions: "Review the project",
      },
    };
    expect(manualProjectWorkerParent(luma, [supervisor])).toBeUndefined();
    const used = { ...thread, latestTurn: {} } as OrchestrationThreadShell;
    expect(manualProjectWorkerParent(used, [supervisor])).toBeUndefined();
  });
  it("prepares only an explicit One-Shot Worker for its named coordinating parent", () => {
    expect(manualProjectWorkerParent(commissioned, [supervisor])).toBe(supervisor);
    const specialist = {
      ...supervisor,
      workjetConfig: {
        ...DEFAULT_WORKJET_THREAD_CONFIG,
        team: {
          role: "specialist",
          domain: "review",
          projectId,
          threadId: supervisor.id,
          parentThreadId: ThreadId.make("specialist-supervisor"),
          goal: "Review",
          createdAt: thread.createdAt,
        },
      },
    } as OrchestrationThreadShell;
    expect(manualProjectWorkerParent(commissioned, [specialist])).toBe(specialist);
    expect(() => manualProjectWorkerParent(commissioned, [])).toThrow("parent is unavailable");
    expect(() =>
      manualProjectWorkerParent(commissioned, [
        { ...supervisor, id: ThreadId.make("another-supervisor") },
      ]),
    ).toThrow("parent is unavailable");
  });
  it("excludes supervisors, persistent workers and already-dispatched team workers", () => {
    expect(manualProjectWorkerParent(supervisor, [supervisor])).toBeUndefined();
    const config = manualProjectWorkerConfig(
      thread,
      supervisor,
      EnvironmentId.make("local"),
      "Do task",
    );
    expect(
      manualProjectWorkerParent({ ...thread, workjetConfig: config }, [supervisor]),
    ).toBeUndefined();
  });
  it("does not migrate historical explicit workers or reuse an unavailable parent", () => {
    expect(() =>
      manualProjectWorkerParent({ ...commissioned, latestTurn: {} } as OrchestrationThreadShell, [
        supervisor,
      ]),
    ).toThrow("explicit isolated-worker migration");
    expect(() =>
      manualProjectWorkerParent(commissioned, [{ ...supervisor, archivedAt: thread.createdAt }]),
    ).toThrow("parent is unavailable");
  });
  it("retains capabilities and establishes retry-stable native worker ownership", () => {
    const original = {
      ...commissioned,
      workjetConfig: {
        ...commissioned.workjetConfig,
        managedInstructions: "Keep task",
      },
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
