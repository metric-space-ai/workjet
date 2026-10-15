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
  workerSourceConnectionForEnrollment,
  workerSourceIsBound,
  workerSourceProvisionRequest,
  workerSourceBindingFailure,
} from "./workjetWorkerSourceConnection";
import {
  bindWorkjetSupervisor,
  readWorkjetSupervisorTurnCapabilities,
} from "./workjetSupervisorControl";

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
  it("keeps project-control timeouts separate from token-specific worker-source bindings", async () => {
    const calls: string[] = [];
    const port = async (instanceId: string) => {
      calls.push(instanceId);
      return { _tag: "failed" as const, code: "timeout" as const };
    };
    const scope = {
      instanceId: selected,
      projectId: ProjectId.make("molecularity"),
      threadId: ThreadId.make("existing-supervisor"),
    };
    const before = withWorkerSourceConnection(DEFAULT_WORKJET_THREAD_CONFIG, selected, connection)!;
    const rotated = withWorkerSourceConnection(before, selected, {
      ...connection,
      connectionId: WorkjetConnectionId.make(
        `ctox-dev-worker-source:${tenant}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
      ),
    })!;
    expect(rotated).not.toEqual(before);
    expect(await bindWorkjetSupervisor(scope, CommandId.make("bind-after-rotation"), port)).toEqual(
      { _tag: "failed", code: "timeout" },
    );
    expect(
      await readWorkjetSupervisorTurnCapabilities(
        scope,
        CommandId.make("capabilities-after-rotation"),
        port,
      ),
    ).toEqual({ _tag: "failed", code: "timeout" });
    expect(calls).toEqual([selected, selected]);
  });

  it("preserves typed config-save rejections and offers retries only for transient failures", () => {
    expect(
      workerSourceBindingFailure({
        _tag: "OrchestrationDispatchCommandError",
        cause: {
          _tag: "OrchestrationCommandInvariantError",
          detail: "Keep the original Supervisor receipt when retaining a previous task.",
        },
      }),
    ).toEqual({
      message: "Keep the original Supervisor receipt when retaining a previous task.",
      retryable: false,
    });
    expect(workerSourceBindingFailure(new Error("server disconnected")).retryable).toBe(true);
  });

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

describe("remote computer enrollment source", () => {
  it("uses the ready source's native pin and exact grant, excluding a decision-hub-only grant", () => {
    const source = { ...connection, instanceId: "native-source.example" };
    const decisionHub = {
      ...source,
      connectionId: WorkjetConnectionId.make(`ctox-dev:${tenant}`),
    };
    expect(workerSourceConnectionForEnrollment([decisionHub, source], selected)).toBe(source);
    expect(source.instanceId).not.toBe(selected);
  });

  it("rejects missing, offline, foreign and multiple ready worker grants", () => {
    const second = {
      ...connection,
      connectionId: WorkjetConnectionId.make(
        `ctox-dev-worker-source:${tenant}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
      ),
    };
    for (const entries of [
      [],
      [{ ...connection, status: "offline" as const }],
      [connection, second],
    ]) {
      expect(workerSourceConnectionForEnrollment(entries, selected)).toBeUndefined();
    }
    expect(workerSourceConnectionForEnrollment([connection], "managed:foreign")).toBeUndefined();
    expect(workerSourceConnectionForEnrollment([connection], null)).toBeUndefined();
  });

  it("ignores an offline prior source and preserves an explicitly selected native instance", () => {
    expect(
      workerSourceConnectionForEnrollment(
        [{ ...connection, status: "offline" }, connection],
        selected,
      ),
    ).toBe(connection);
    expect(workerSourceConnectionForEnrollment([connection], nativeInstance)).toBe(connection);
    expect(workerSourceConnectionForEnrollment([connection], "other-native")).toBeUndefined();
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
