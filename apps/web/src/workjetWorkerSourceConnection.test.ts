import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkjetConnectionId,
  type WorkjetConnectionSummary,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import {
  withWorkerSourceConnection,
  workerSourceConnectionForInstance,
  workerSourceIsBound,
  workerSourceProvisionRequest,
} from "./workjetWorkerSourceConnection";

const environmentId = EnvironmentId.make("worker-source-environment");
const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nativeInstance = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const selected = `managed:${tenant}`;
const connection: WorkjetConnectionSummary = {
  connectionId: WorkjetConnectionId.make(`ctox-dev-worker-source:${tenant}:${nativeInstance}`),
  instanceId: nativeInstance,
  displayName: "Project workers",
  source: "ctox_dev",
  status: "ready",
  reason: null,
};

describe("native supervisor worker source connection", () => {
  it("uses the existing worker-source provisioner with the selected environment and tenant", () => {
    expect(workerSourceProvisionRequest(environmentId, selected)).toEqual({
      environmentId,
      purpose: "worker_source",
      target: { _tag: "ctox_dev", tenantId: tenant },
    });
  });
  it("does not invent a managed tenant for a native instance, an empty selection or a local fixture", () => {
    for (const target of [null, nativeInstance, "managed:", "local:acceptance"]) {
      expect(workerSourceProvisionRequest(environmentId, target)).toBeNull();
    }
  });
  it("retains the actual native instance pin instead of substituting the presentation tenant", () => {
    expect(workerSourceConnectionForInstance([connection], selected)).toBe(connection);
    expect(connection.instanceId).not.toBe(tenant);
  });
  it("does not treat the decision-hub-only grant as a worker source", () => {
    expect(
      workerSourceConnectionForInstance(
        [{ ...connection, connectionId: WorkjetConnectionId.make(`ctox-dev:${tenant}`) }],
        selected,
      ),
    ).toBeUndefined();
  });
  it("does not expose a different tenant or an invalid source connection identity", () => {
    expect(workerSourceConnectionForInstance([connection], "managed:foreign")).toBeUndefined();
    expect(
      workerSourceConnectionForInstance(
        [
          {
            ...connection,
            connectionId: WorkjetConnectionId.make(`ctox-dev-worker-source:${tenant}:invalid`),
          },
        ],
        selected,
      ),
    ).toBeUndefined();
  });
  it("prefers a ready source over an offline older connection", () => {
    const offline: WorkjetConnectionSummary = { ...connection, status: "offline" };
    expect(workerSourceConnectionForInstance([offline, connection], selected)).toBe(connection);
    expect(workerSourceConnectionForInstance([offline], selected)).toBe(offline);
  });
});

describe("persisted supervisor worker authority", () => {
  const config: WorkjetThreadConfig = {
    ...DEFAULT_WORKJET_THREAD_CONFIG,
    role: "orchestrator",
    managedInstructions: "Retain the existing supervisor instructions.",
    enabledCapabilityIds: ["greppy"],
    ctoxSupervisorTurn: {
      intent: {
        instanceId: selected,
        projectId: ProjectId.make("source-project"),
        threadId: ThreadId.make("source-supervisor"),
        commandId: CommandId.make("existing-turn"),
        goal: "Already submitted supervisor task",
        createdAt: "2026-10-09T00:00:00.000Z",
      },
      submission: "awaiting-receipt",
      turn: null,
    },
  };
  it("persists source binding with the native pin while preserving an existing supervisor turn", () => {
    const next = withWorkerSourceConnection(config, selected, connection)!;
    expect(workerSourceIsBound(next, connection)).toBe(true);
    expect(next.role).toBe("orchestrator");
    expect(next.managedInstructions).toBe(config.managedInstructions);
    expect(next.enabledCapabilityIds).toEqual(["greppy", "ctox-business-os"]);
    expect(next.schemaVersion === 2 && next.ctoxSupervisorTurn).toBe(config.ctoxSupervisorTurn);
    expect(next.schemaVersion === 2 && next.capabilityBindings).toEqual([
      {
        capabilityId: "ctox-business-os",
        target: {
          kind: "ctox-connection",
          connectionId: connection.connectionId,
          instanceId: nativeInstance,
        },
      },
    ]);
    expect(config.enabledCapabilityIds).toEqual(["greppy"]);
  });
  it("does not treat an unbound, disabled or incorrectly pinned source as connected", () => {
    expect(workerSourceIsBound(config, connection)).toBe(false);
    const next = withWorkerSourceConnection(config, selected, connection)!;
    expect(workerSourceIsBound({ ...next, enabledCapabilityIds: [] }, connection)).toBe(false);
    expect(workerSourceIsBound(next, { ...connection, instanceId: "foreign-native-pin" })).toBe(
      false,
    );
  });
  it("rejects offline and foreign sources before changing the supervisor", () => {
    expect(
      withWorkerSourceConnection(config, selected, { ...connection, status: "offline" }),
    ).toBeNull();
    expect(withWorkerSourceConnection(config, "managed:foreign", connection)).toBeNull();
  });
  it("normalizes legacy settings and binds repeated saves only once", () => {
    const legacy: WorkjetThreadConfig = {
      schemaVersion: 1,
      role: "orchestrator",
      parent: null,
      managedInstructions: "Legacy instructions",
      enabledCapabilityIds: ["greppy"],
    };
    const first = withWorkerSourceConnection(legacy, selected, connection)!;
    const second = withWorkerSourceConnection(first, selected, connection)!;
    expect(second).toEqual(first);
    expect(workerSourceIsBound(second, connection)).toBe(true);
  });
});
