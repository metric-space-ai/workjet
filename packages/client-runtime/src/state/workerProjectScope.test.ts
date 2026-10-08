import { EnvironmentId, ProjectId, ThreadId, type WorkjetThreadConfig } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  groupWorkerThreads,
  selectThreadsForProjectScope,
  selectWorkersForOrchestrator,
} from "./workerOverview.ts";

const source = EnvironmentId.make("source");
const target = EnvironmentId.make("gpu3");
const foreign = EnvironmentId.make("foreign");
const projectId = ProjectId.make("real-project");
const parentId = ThreadId.make("specialist");
const scope = new Set([`${source}:${projectId}`]);

function parent(environmentId = source, role: "supervisor" | "specialist" = "specialist") {
  return {
    id: parentId,
    environmentId,
    projectId,
    archivedAt: null,
    deletedAt: null,
    workjetConfig: {
      schemaVersion: 2,
      role: "orchestrator",
      parent: null,
      managedInstructions: "",
      enabledCapabilityIds: [],
      capabilityBindings: [],
      ctoxSession: null,
      team: {
        role,
        projectId,
        threadId: parentId,
        parentThreadId: role === "supervisor" ? null : ThreadId.make("supervisor"),
        domain: "instances",
        goal: "Run project workers",
        createdAt: "2026-10-07T00:00:00Z",
      },
    } as WorkjetThreadConfig,
  };
}
function worker(parentEnvironmentId = source) {
  const id = ThreadId.make("worker");
  return {
    id,
    environmentId: target,
    projectId,
    archivedAt: null as string | null,
    deletedAt: null as string | null,
    workjetConfig: {
      schemaVersion: 2,
      role: "worker",
      parent: { environmentId: parentEnvironmentId, threadId: parentId },
      managedInstructions: "",
      enabledCapabilityIds: [],
      capabilityBindings: [],
      ctoxSession: null,
      team: {
        role: "worker",
        projectId,
        threadId: id,
        parentThreadId: parentId,
        packageId: "one-pr",
        goal: "Ship the package",
        createdAt: "2026-10-07T00:00:00Z",
      },
    } as WorkjetThreadConfig,
  };
}

describe("remote worker project scope", () => {
  it.each(["supervisor", "specialist"] as const)(
    "includes the real remote worker of a %s",
    (role) => {
      const sourceParent = parent(source, role);
      const remote = worker();
      expect(selectThreadsForProjectScope([sourceParent, remote], scope)).toEqual([
        sourceParent,
        remote,
      ]);
      expect(selectWorkersForOrchestrator([sourceParent, remote], source, parentId)).toEqual([
        remote,
      ]);
      expect(groupWorkerThreads([sourceParent, remote]).groups).toEqual([
        { orchestrator: sourceParent, workers: [remote] },
      ]);
    },
  );

  it("resolves colliding parent IDs by environment and preserves the remote identity", () => {
    const sourceParent = parent();
    const collision = parent(target);
    const remote = worker();
    const rows = [collision, remote, sourceParent];
    expect(selectWorkersForOrchestrator(rows, source, parentId)).toEqual([remote]);
    expect(selectWorkersForOrchestrator(rows, target, parentId)).toEqual([]);
    expect(selectThreadsForProjectScope(rows, scope)).toEqual([remote, sourceParent]);
    expect(remote.environmentId).toBe(target);
    expect(remote.id).toBe(ThreadId.make("worker"));
  });

  it("does not attach a foreign or missing parent with a colliding thread ID", () => {
    const sourceParent = parent();
    const remote = worker(foreign);
    expect(selectThreadsForProjectScope([sourceParent, parent(foreign), remote], scope)).toEqual([
      sourceParent,
    ]);
    expect(selectThreadsForProjectScope([sourceParent, remote], scope)).toEqual([sourceParent]);
    expect(groupWorkerThreads([sourceParent, remote]).unlinkedWorkers).toEqual([remote]);
  });

  it("rejects a remote worker from a different project or inconsistent team identity", () => {
    const sourceParent = parent();
    const remote = worker();
    const config = remote.workjetConfig;
    if (config.schemaVersion !== 2 || config.role !== "worker" || config.team?.role !== "worker")
      throw new Error("invalid fixture");
    const variants = [
      { ...remote, projectId: ProjectId.make("foreign-project") },
      {
        ...remote,
        workjetConfig: {
          ...config,
          team: { ...config.team, projectId: ProjectId.make("foreign-project") },
        },
      },
      {
        ...remote,
        workjetConfig: {
          ...config,
          team: { ...config.team, threadId: ThreadId.make("different-worker") },
        },
      },
      {
        ...remote,
        workjetConfig: {
          ...config,
          team: { ...config.team, parentThreadId: ThreadId.make("different-parent") },
        },
      },
    ];
    for (const invalid of variants) {
      expect(selectThreadsForProjectScope([sourceParent, invalid], scope)).toEqual([sourceParent]);
    }
  });

  it("requires a real orchestrator with a coherent source team", () => {
    const sourceParent = parent();
    const remote = worker();
    const config = sourceParent.workjetConfig;
    if (
      config.schemaVersion !== 2 ||
      config.role !== "orchestrator" ||
      config.team?.role !== "specialist"
    )
      throw new Error("invalid fixture");
    const standard = { ...sourceParent, workjetConfig: { ...config, role: "standard" as const } };
    const mismatch = {
      ...sourceParent,
      workjetConfig: { ...config, team: { ...config.team, threadId: ThreadId.make("wrong") } },
    };
    for (const invalid of [standard, mismatch]) {
      expect(selectThreadsForProjectScope([invalid, remote], scope)).toEqual([invalid]);
    }
  });

  it("hides retained archived/deleted workers and shows them again only after reopening", () => {
    const sourceParent = parent();
    const remote = worker();
    const archived = { ...remote, archivedAt: "2026-10-07T12:00:00Z" };
    const deleted = { ...remote, deletedAt: "2026-10-07T12:00:00Z" };
    for (const hidden of [archived, deleted]) {
      expect(selectThreadsForProjectScope([sourceParent, hidden], scope)).toEqual([sourceParent]);
      expect(selectWorkersForOrchestrator([sourceParent, hidden], source, parentId)).toEqual([]);
      expect(groupWorkerThreads([sourceParent, hidden])).toEqual({
        groups: [],
        unlinkedWorkers: [],
      });
    }
    expect(selectThreadsForProjectScope([sourceParent, remote], scope)).toEqual([
      sourceParent,
      remote,
    ]);
  });

  it("retains existing logical project membership and an empty scope reveals no workers", () => {
    const sourceParent = parent();
    const remote = worker();
    expect(selectThreadsForProjectScope([remote], new Set([`${target}:${projectId}`]))).toEqual([
      remote,
    ]);
    expect(selectThreadsForProjectScope([sourceParent, remote], new Set())).toEqual([]);
    expect(selectThreadsForProjectScope([sourceParent, remote], null)).toEqual([
      sourceParent,
      remote,
    ]);
  });
});
