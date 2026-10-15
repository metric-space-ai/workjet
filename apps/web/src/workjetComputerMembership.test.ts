import {
  EnvironmentId,
  WorkjetComputerId,
  type CtoxWorkjetComputerControlResult,
  type CtoxWorkjetComputerProjection,
  type DesktopCtoxBridge,
  type WorkjetComputer,
} from "@workjet/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createComputerMembershipStore } from "./workjetComputerMembership";
import type { OperationalComputerEnrollment } from "./computerCapabilityEnrollment";
import { createKernel } from "./ctox/kernel/kernel.mjs";
import { KernelTransport } from "./ctox/kernel/transport.mjs";
import { bindKernelCtoxClient } from "./ctox/kernelClient";
import type { Kernel } from "./ctox/ctoxClient";

let fixtureSequence = 0;
const hosts = new Map<string, Kernel>();
const releases: (() => void)[] = [];
const stores: ReturnType<typeof createComputerMembershipStore>[] = [];
afterEach(async () => {
  stores.splice(0).forEach((store) => store.dispose());
  releases.splice(0).forEach((release) => release());
  await Promise.all([...hosts.values()].map((kernel) => kernel.close()));
  hosts.clear();
});
async function readyStore(
  instanceId: string,
  computers: readonly CtoxWorkjetComputerProjection[] = [],
) {
  const kernel = createKernel({
    instanceId,
    userId: "fixture-owner",
    storage: "memory",
    dbName: `p11b-membership-${++fixtureSequence}`,
    multiTab: false,
    transport: new KernelTransport(),
  });
  hosts.set(instanceId, kernel);
  await kernel.ready;
  releases.push(bindKernelCtoxClient(kernel, "p11-b"));
  await kernel.receivePage({
    epoch: "1",
    collection: "workjet_computers",
    scope_hash: "local",
    gen: 1,
    cursor_to: "1",
    complete: true,
    docs: computers.map((row) => ({
      id: row.id,
      seq: "1",
      rev: "1",
      data: {
        id: row.id,
        display_name: row.displayName,
        hosting_mode: row.hostingMode,
        status: row.status,
        capabilities: row.capabilities,
        self_hosted_colocation: row.selfHostedColocation,
        owner_user_id: "fixture-owner",
        device_binding_id: "fixture-device",
        actor_epoch: 1,
        last_seen_at_ms: 0,
        replication_up: false,
        created_at_ms: 0,
        updated_at_ms: 0,
        is_deleted: false,
      },
    })),
  });
  const store = createComputerMembershipStore();
  stores.push(store);
  await store.refresh(instanceId, undefined);
  return store;
}

function deferredResult() {
  let resolve!: (value: CtoxWorkjetComputerControlResult) => void;
  const promise = new Promise<CtoxWorkjetComputerControlResult>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const computer: WorkjetComputer = {
  id: WorkjetComputerId.make("computer-gpu"),
  label: "GPU",
  environmentId: EnvironmentId.make("ssh-gpu"),
  presentationKind: "tailscale",
  harnesses: [],
};
const projection: CtoxWorkjetComputerProjection = {
  id: computer.id,
  displayName: computer.label,
  hostingMode: "workstation",
  status: "assigned",
  capabilities: [],
  selfHostedColocation: false,
};
const port = () => vi.fn<NonNullable<DesktopCtoxBridge["requestComputerControl"]>>();
const bridge = (requestComputerControl: NonNullable<DesktopCtoxBridge["requestComputerControl"]>) =>
  ({ requestComputerControl }) as DesktopCtoxBridge;

describe("instance computer membership", () => {
  const nas: OperationalComputerEnrollment = {
    computerId: "nas-native",
    displayName: "NAS",
    hostingMode: "self_hosted",
    agentless: true,
    agentCapabilities: [],
    capabilityConfig: [
      {
        kind: "storage",
        endpoint_ref: "nas-access",
        protocol: "ssh",
        root: "/volume1/artifacts",
        quota_gib: null,
        purposes: ["artifacts"],
      },
    ],
    endpoint: {
      ref: "nas-access",
      connection: {
        protocol: "ssh",
        host: "nas.example.test",
        port: 22,
        username: "admin",
        root: "/volume1/artifacts",
        host_key_sha256: "SHA256:pin",
        private_key: { scope: "access", name: "nas" },
        passphrase: null,
      },
    },
  };
  const nasProjection = {
    ...projection,
    id: nas.computerId,
    displayName: "NAS",
    hostingMode: "self_hosted" as const,
    capabilities: ["storage"],
  };

  it("removes a native-only NAS without creating a coding connection", async () => {
    const store = await readyStore("selected", [nasProjection]);
    const request = port();
    request.mockResolvedValueOnce({
      _tag: "completed",
      response: {
        action: "computer.unassign",
        computer: { ...nasProjection, status: "unassigned" },
      },
    });
    expect(await store.unassign("selected", nas.computerId, bridge(request))).toBe(true);
    expect(store.getSnapshot().computers).toEqual([]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      action: "computer.unassign",
      computerId: nas.computerId,
    });
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("environmentId");
  });

  it("serializes enrollment and publishes only after both native confirmations", async () => {
    const store = await readyStore("selected");
    const request = port();
    const pending = deferredResult();
    request
      .mockResolvedValueOnce({
        _tag: "completed",
        response: {
          action: "computer.assign",
          computer: nasProjection,
        },
      })
      .mockReturnValueOnce(pending.promise);
    const enrollment = store.enroll("selected", nas, bridge(request));
    await Promise.resolve();
    expect(store.getSnapshot().pendingComputerId).toBe(nas.computerId);
    expect(store.getSnapshot().computers).toEqual([]);
    await expect(store.enroll("selected", nas, bridge(request))).rejects.toThrow(
      "prüft ihre Rechner",
    );
    pending.resolve({
      _tag: "completed",
      response: {
        action: "computer.endpoint.upsert",
        computerId: nas.computerId,
        endpointRef: "nas-access",
        enabled: true,
      },
    });
    await enrollment;
    expect(store.getSnapshot().computers).toEqual([nasProjection]);
    expect(store.getSnapshot().pendingComputerId).toBeNull();
  });

  it("does not publish old enrollment or configure its endpoint after switching instances", async () => {
    const store = await readyStore("selected");
    const request = port();
    const pending = deferredResult();
    request.mockReturnValueOnce(pending.promise);
    const enrollment = store.enroll("selected", nas, bridge(request));
    store.select("other");
    pending.resolve({
      _tag: "completed",
      response: {
        action: "computer.assign",
        computer: nasProjection,
      },
    });
    await expect(enrollment).rejects.toThrow("Instanz gewechselt");
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ instanceId: "other", computers: [] });
  });
  it("keeps confirmed computers offline without a desktop read and adopts local updates", async () => {
    const store = await readyStore("fixture:a", [projection]);
    const request = port();
    await store.refresh("fixture:a", bridge(request));
    expect(store.getSnapshot()).toMatchObject({ phase: "ready", computers: [projection] });
    expect(request).not.toHaveBeenCalled();
    const kernel = hosts.get("fixture:a")!;
    await kernel.receivePage({
      epoch: "1",
      collection: "workjet_computers",
      scope_hash: "local",
      gen: 1,
      cursor_to: "2",
      complete: true,
      docs: [
        {
          id: projection.id,
          seq: "2",
          rev: "2",
          data: {
            id: projection.id,
            display_name: projection.displayName,
            hosting_mode: "workstation",
            status: "assigned",
            capabilities: [],
            self_hosted_colocation: false,
            is_deleted: true,
          },
        },
      ],
    });
    expect(store.getSnapshot().computers).toEqual([]);
  });

  it("waits for native confirmation, then adds and removes the exact computer", async () => {
    const store = await readyStore("fixture:a");
    const request = port();
    const pending = deferredResult();
    request.mockReturnValueOnce(pending.promise);
    const assignment = store.setAssigned("fixture:a", computer, true, bridge(request));
    expect(store.getSnapshot().pendingComputerId).toBe(computer.id);
    expect(store.getSnapshot().computers).toEqual([]);
    pending.resolve({
      _tag: "completed",
      response: { action: "computer.assign", computer: projection },
    });
    expect(await assignment).toBe(true);
    expect(store.getSnapshot().computers).toEqual([projection]);
    const sent = request.mock.calls[0];
    expect(sent?.[0]).toBe("fixture:a");
    expect(sent?.[1]).toMatchObject({
      action: "computer.assign",
      computerId: computer.id,
      selfHostedColocation: false,
    });
    expect(sent?.[1]).not.toHaveProperty("environmentId");
    request.mockResolvedValueOnce({
      _tag: "completed",
      response: { action: "computer.unassign", computer: { ...projection, status: "unassigned" } },
    });
    expect(await store.setAssigned("fixture:a", computer, false, bridge(request))).toBe(true);
    expect(store.getSnapshot().computers).toEqual([]);
  });

  it("discards updates from the former instance after switching", async () => {
    const store = await readyStore("fixture:a", [projection]);
    store.select("fixture:b");
    await hosts.get("fixture:a")!.receivePage({
      epoch: "1",
      collection: "workjet_computers",
      scope_hash: "local",
      gen: 1,
      cursor_to: "2",
      complete: true,
      docs: [
        {
          id: "late",
          seq: "2",
          rev: "2",
          data: {
            id: "late",
            display_name: "Late",
            hosting_mode: "workstation",
            status: "assigned",
            capabilities: [],
            self_hosted_colocation: false,
          },
        },
      ],
    });
    expect(store.getSnapshot()).toMatchObject({
      instanceId: "fixture:b",
      computers: [],
      phase: "loading",
    });
  });

  it("does not apply an assignment to a newly selected instance", async () => {
    const store = await readyStore("fixture:a");
    const request = port();
    const pending = deferredResult();
    request.mockReturnValueOnce(pending.promise);
    const mutation = store.setAssigned("fixture:a", computer, true, bridge(request));
    store.select("fixture:b");
    pending.resolve({
      _tag: "completed",
      response: { action: "computer.assign", computer: projection },
    });
    expect(await mutation).toBe(false);
    expect(store.getSnapshot().computers).toEqual([]);
  });

  it("rejects a confirmation for a different computer and retains a retryable error", async () => {
    const store = await readyStore("fixture:a");
    const request = port();
    request.mockResolvedValueOnce({
      _tag: "completed",
      response: { action: "computer.assign", computer: { ...projection, id: "other-computer" } },
    });
    expect(await store.setAssigned("fixture:a", computer, true, bridge(request))).toBe(false);
    expect(store.getSnapshot().computers).toEqual([]);
    expect(store.getSnapshot().error).toContain("nicht bestätigt werden");
    expect(store.getSnapshot().pendingComputerId).toBeNull();
  });

  it("does not invent membership or call a legacy host while no App API is bound", async () => {
    const store = createComputerMembershipStore();
    stores.push(store);
    const request = port();
    await store.refresh("unbound-fixture", bridge(request));
    expect(store.getSnapshot()).toMatchObject({ phase: "loading", computers: [], error: null });
    expect(request).not.toHaveBeenCalled();
  });

  it("serializes visible mutations and excludes duplicate submits", async () => {
    const store = await readyStore("fixture:a");
    const request = port();
    const pending = deferredResult();
    request.mockReturnValueOnce(pending.promise);
    const first = store.setAssigned("fixture:a", computer, true, bridge(request));
    expect(await store.setAssigned("fixture:a", computer, true, bridge(request))).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    pending.resolve({ _tag: "failed", code: "timeout" });
    expect(await first).toBe(false);
    expect(store.getSnapshot().error).toContain("noch nicht bestätigt");
  });
});
