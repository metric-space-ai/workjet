import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, WorkjetConnectionId, type WorkjetConnectionSummary } from "@workjet/contracts";
import {
  workerSourceConnectionForInstance,
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
    expect(workerSourceConnectionForInstance([
      { ...connection, connectionId: WorkjetConnectionId.make(`ctox-dev:${tenant}`) },
    ], selected)).toBeUndefined();
  });
  it("does not expose a different tenant or an invalid source connection identity", () => {
    expect(workerSourceConnectionForInstance([connection], "managed:foreign")).toBeUndefined();
    expect(workerSourceConnectionForInstance([
      { ...connection, connectionId: WorkjetConnectionId.make(`ctox-dev-worker-source:${tenant}:invalid`) },
    ], selected)).toBeUndefined();
  });
  it("prefers a ready source over an unavailable older connection", () => {
    const unavailable: WorkjetConnectionSummary = { ...connection, status: "unavailable" };
    expect(workerSourceConnectionForInstance([unavailable, connection], selected)).toBe(connection);
    expect(workerSourceConnectionForInstance([unavailable], selected)).toBe(unavailable);
  });
});
