import { assert, it } from "@effect/vitest";
import { EnvironmentId, WorkjetConnectionId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { makeCtoxRemoteWorkerTargets } from "./CtoxRemoteWorkerTargets.ts";
const source = EnvironmentId.make("source");
const target = EnvironmentId.make("worker-environment");
const scope = {
  connectionId: WorkjetConnectionId.make("selected-business-os-grant"),
  instanceId: "selected-bo",
};
const assignment = { targetConnectionId: scope.connectionId, targetInstanceId: scope.instanceId };
const computer = {
  displayName: "Build worker",
  hostingMode: "self_hosted" as const,
  buildCapability: {
    kind: "build" as const,
    ssh_endpoint_ref: "ssh-ref",
    slots: 3,
    jobs: 6,
    lane_root: "/lane",
    disk_floor_gib: 32,
    toolchains: ["rust"],
  },
};
const receipt = {
  contract: "ctox.workjet.remote-worker-target.v1",
  bindingId: "native-binding",
  revision: 1,
  ownerUserId: "owner",
  sourceInstanceId: scope.instanceId,
  target: {
    sourceEnvironmentId: source,
    targetEnvironmentId: target,
    ...assignment,
    targetComputerId: "native-id",
  },
  state: "active",
  capabilityEpoch: 1,
  buildCapability: computer.buildCapability,
};
it.effect(
  "uses the exact BO tuple and explicit build values, strips only the input discriminator",
  () =>
    Effect.gen(function* () {
      const service = makeCtoxRemoteWorkerTargets({
        connections: {
          resolveReadyTarget: (connectionId, instanceId) => {
            assert.equal(connectionId, scope.connectionId);
            assert.equal(instanceId, scope.instanceId);
            return Effect.succeed({
              endpoint: "http://127.0.0.1:8080/mcp",
              token: "fixture-token",
            });
          },
        },
        transport: {
          probe: () => Effect.succeed(undefined),
          callTool: (_source, tool, args) => {
            assert.equal(tool, "business_os.remote_worker_admission");
            assert.deepEqual(args, {
              action: "enroll_target",
              target: { sourceEnvironmentId: source, targetEnvironmentId: target, ...assignment },
              computer: {
                displayName: computer.displayName,
                hostingMode: computer.hostingMode,
                buildCapability: {
                  ssh_endpoint_ref: "ssh-ref",
                  slots: 3,
                  jobs: 6,
                  lane_root: "/lane",
                  disk_floor_gib: 32,
                  toolchains: ["rust"],
                },
              },
            });
            return Effect.succeed({ structuredContent: receipt });
          },
        },
      });
      assert.equal(
        (yield* service.enroll(scope, source, target, assignment, computer)).target
          .targetComputerId,
        "native-id",
      );
    }),
);
it.effect("rejects altered native build capacity and foreign target identity", () =>
  Effect.gen(function* () {
    for (const changed of [
      { ...receipt, buildCapability: { ...computer.buildCapability, slots: 9 } },
      { ...receipt, target: { ...receipt.target, targetConnectionId: "desktop-ssh-profile" } },
    ]) {
      const service = makeCtoxRemoteWorkerTargets({
        connections: {
          resolveReadyTarget: () =>
            Effect.succeed({ endpoint: "http://127.0.0.1:8080/mcp", token: "fixture-token" }),
        },
        transport: {
          probe: () => Effect.succeed(undefined),
          callTool: () => Effect.succeed({ structuredContent: changed }),
        },
      });
      yield* Effect.flip(service.enroll(scope, source, target, assignment, computer));
    }
  }),
);
it.effect("accepts revoked receipts without positive admission fields", () =>
  Effect.gen(function* () {
    const {
      capabilityEpoch: _epoch,
      buildCapability: _build,
      ...revoked
    } = { ...receipt, state: "revoked" };
    const service = makeCtoxRemoteWorkerTargets({
      connections: {
        resolveReadyTarget: () =>
          Effect.succeed({ endpoint: "http://127.0.0.1:8080/mcp", token: "fixture-token" }),
      },
      transport: {
        probe: () => Effect.succeed(undefined),
        callTool: () => Effect.succeed({ structuredContent: revoked }),
      },
    });
    assert.equal((yield* service.revoke(scope, source, target, 1)).state, "revoked");
  }),
);
