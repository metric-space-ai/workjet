import { EnvironmentId, ThreadId, type WorkjetThreadConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupWorkerThreads,
  selectWorkersForOrchestrator,
  type WorkerOverviewThreadLike,
} from "./workerOverview.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

function standardConfig(): WorkjetThreadConfig {
  return {
    schemaVersion: 1,
    role: "standard",
    parent: null,
    managedInstructions: "",
    enabledCapabilityIds: [],
  };
}

function orchestratorConfig(): WorkjetThreadConfig {
  return {
    schemaVersion: 1,
    role: "orchestrator",
    parent: null,
    managedInstructions: "",
    enabledCapabilityIds: [],
  };
}

function workerConfig(
  parentEnvironmentId: EnvironmentId,
  parentThreadId: ThreadId,
): WorkjetThreadConfig {
  return {
    schemaVersion: 1,
    role: "worker",
    parent: { environmentId: parentEnvironmentId, threadId: parentThreadId },
    managedInstructions: "",
    enabledCapabilityIds: [],
  };
}

function makeThread(
  id: string,
  environmentId: EnvironmentId,
  workjetConfig: WorkjetThreadConfig,
): WorkerOverviewThreadLike {
  return { id: ThreadId.make(id), environmentId, workjetConfig };
}

describe("groupWorkerThreads", () => {
  it("groups worker children under their orchestrator parent", () => {
    const orchestrator = makeThread("orch-1", envA, orchestratorConfig());
    const workerOne = makeThread("worker-1", envA, workerConfig(envA, orchestrator.id));
    const workerTwo = makeThread("worker-2", envA, workerConfig(envA, orchestrator.id));

    const grouping = groupWorkerThreads([orchestrator, workerOne, workerTwo]);

    expect(grouping.groups).toHaveLength(1);
    expect(grouping.groups[0]!.orchestrator).toBe(orchestrator);
    expect(grouping.groups[0]!.workers).toEqual([workerOne, workerTwo]);
    expect(grouping.unlinkedWorkers).toEqual([]);
  });

  it("preserves input order across multiple orchestrators", () => {
    const orchestratorOne = makeThread("orch-1", envA, orchestratorConfig());
    const orchestratorTwo = makeThread("orch-2", envA, orchestratorConfig());
    const workerForTwo = makeThread("worker-a", envA, workerConfig(envA, orchestratorTwo.id));
    const workerForOne = makeThread("worker-b", envA, workerConfig(envA, orchestratorOne.id));

    const grouping = groupWorkerThreads([
      orchestratorOne,
      orchestratorTwo,
      workerForTwo,
      workerForOne,
    ]);

    // Order follows first-worker appearance: orch-2's worker is seen first.
    expect(grouping.groups.map((group) => group.orchestrator.id)).toEqual([
      orchestratorTwo.id,
      orchestratorOne.id,
    ]);
  });

  it("buckets a worker with a missing parent as unlinked", () => {
    const worker = makeThread("worker-1", envA, workerConfig(envA, ThreadId.make("ghost-orch")));

    const grouping = groupWorkerThreads([worker]);

    expect(grouping.groups).toEqual([]);
    expect(grouping.unlinkedWorkers).toEqual([worker]);
  });

  it("buckets a worker whose parent is not an orchestrator as unlinked", () => {
    // A standard (or worker) parent is never a valid orchestrator link.
    const notAnOrchestrator = makeThread("plain-1", envA, standardConfig());
    const worker = makeThread("worker-1", envA, workerConfig(envA, notAnOrchestrator.id));

    const grouping = groupWorkerThreads([notAnOrchestrator, worker]);

    expect(grouping.groups).toEqual([]);
    expect(grouping.unlinkedWorkers).toEqual([worker]);
  });

  it("excludes a cross-environment parent reference", () => {
    // Parent orchestrator genuinely exists, but in a different environment than
    // the worker: the link is invalid and the worker is unlinked.
    const orchestratorInB = makeThread("orch-1", envB, orchestratorConfig());
    const workerInA = makeThread("worker-1", envA, workerConfig(envB, orchestratorInB.id));

    const grouping = groupWorkerThreads([orchestratorInB, workerInA]);

    expect(grouping.groups).toEqual([]);
    expect(grouping.unlinkedWorkers).toEqual([workerInA]);
  });

  it("never treats standard or orchestrator threads as worker children", () => {
    const orchestrator = makeThread("orch-1", envA, orchestratorConfig());
    const standard = makeThread("plain-1", envA, standardConfig());

    const grouping = groupWorkerThreads([orchestrator, standard]);

    expect(grouping.groups).toEqual([]);
    expect(grouping.unlinkedWorkers).toEqual([]);
  });
});

describe("selectWorkersForOrchestrator", () => {
  it("returns the worker children of a specific orchestrator", () => {
    const orchestrator = makeThread("orch-1", envA, orchestratorConfig());
    const otherOrchestrator = makeThread("orch-2", envA, orchestratorConfig());
    const mine = makeThread("worker-1", envA, workerConfig(envA, orchestrator.id));
    const theirs = makeThread("worker-2", envA, workerConfig(envA, otherOrchestrator.id));

    const workers = selectWorkersForOrchestrator(
      [orchestrator, otherOrchestrator, mine, theirs],
      envA,
      orchestrator.id,
    );

    expect(workers).toEqual([mine]);
  });

  it("returns an empty array for a non-orchestrator thread", () => {
    const standard = makeThread("plain-1", envA, standardConfig());
    const worker = makeThread("worker-1", envA, workerConfig(envA, ThreadId.make("orch-1")));

    expect(selectWorkersForOrchestrator([standard, worker], envA, standard.id)).toEqual([]);
  });

  it("returns an empty array when the orchestrator is absent", () => {
    const worker = makeThread("worker-1", envA, workerConfig(envA, ThreadId.make("orch-1")));

    expect(selectWorkersForOrchestrator([worker], envA, ThreadId.make("orch-1"))).toEqual([]);
  });
});
