// Scheibe C bootstrap: the host mounts the Workjet kernel client only for an instance whose
// launch context reports V4 (E41 `v4` member); V3 instances get no mount, and V4 -> V3 unmounts.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createKernel } from "./kernel/kernel.mjs";
import { MemoryCoreTransport } from "./kernel/fake-core.mjs";
import { getCtoxClient } from "./ctoxClient";
import {
  createWorkjetV4Host,
  detectWorkjetCoreGeneration,
  type WorkjetLaunchContextReader,
  type WorkjetV4Session,
} from "./v4HostBootstrap";
import { commitActiveWorkjetSelection, readActiveWorkjetScope } from "../activeWorkjetScope";

const b64 = (length: number) => "A".repeat(length);
/** Structurally valid E41 launch context (the fake core does not verify the device proof). */
function v4LaunchContext(coreInstanceId: string) {
  return {
    session: { legacy: true },
    v4: {
      instanceId: coreInstanceId,
      userId: "bootstrap-owner",
      actor: { id: "bootstrap-owner", role: "owner" },
      signaling: {
        urls: ["wss://signal.example.test/ws"],
        room: "room-1",
        peerId: "browser-1",
        nativePeerId: "native-1",
        token: "join-token",
        iceServers: [{ urls: "stun:stun.example.test:3478" }],
      },
      hello: {
        offer: {
          type: "hello",
          protocol_ver: 4,
          bootstrap_ver: 1,
          app_api_ver: { min: "4.0", max: "4.0" },
          instance_id: coreInstanceId,
          capabilities: [],
          device_proof: {
            device_id: "device-1",
            public_key: b64(43),
            nonce: b64(43),
            signature: b64(86),
          },
          scopes_wanted: ["workjet_projects"],
          transport: { codecs: ["gzip"], max_frame_bytes: 16384, fragmentation: true, reassembly: true },
        },
      },
      packageKeys: [{ keyId: "key-1", alg: "Ed25519", publicKey: b64(43) }],
    },
  };
}
const v3LaunchContext = { session: { legacy: true }, config: {} };

let sequence = 0;
const hosts: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  commitActiveWorkjetSelection(null);
});

/** Memory kernel on the vendored fake core; stands in for bootV4's authenticated WebRTC kernel. */
function memorySessions() {
  const opened: { coreInstanceId: string; closed: boolean }[] = [];
  const openSession = vi.fn(async (_instanceId: string, payload: unknown) => {
    const coreInstanceId = (payload as ReturnType<typeof v4LaunchContext>).v4.instanceId;
    const kernel = createKernel({
      instanceId: coreInstanceId,
      userId: "bootstrap-owner",
      storage: "memory",
      dbName: `${coreInstanceId}-${++sequence}-db`,
      multiTab: false,
      transport: new MemoryCoreTransport({ namespace: coreInstanceId, latencyMs: 0 }),
    });
    await kernel.ready;
    const entry = { coreInstanceId, closed: false };
    opened.push(entry);
    const session: WorkjetV4Session = {
      kernel,
      close: async () => {
        entry.closed = true;
        await kernel.close();
      },
    };
    return session;
  });
  return { opened, openSession };
}

function host(reader: WorkjetLaunchContextReader, sessions = memorySessions()) {
  const created = createWorkjetV4Host({
    appVersion: "bootstrap-test",
    readLaunchContext: reader,
    openSession: sessions.openSession,
  });
  hosts.push(created);
  return { host: created, sessions };
}

describe("V4 bootstrap: launch-context generation (E41)", () => {
  it("is V4 only with a valid v4 member", () => {
    expect(detectWorkjetCoreGeneration(v4LaunchContext("core-a"))).toBe("v4");
    expect(detectWorkjetCoreGeneration(v3LaunchContext)).toBe("v3");
    expect(detectWorkjetCoreGeneration({ v4: null })).toBe("v3");
    expect(detectWorkjetCoreGeneration(null)).toBe("v3");
    const noKey = v4LaunchContext("core-a");
    noKey.v4.packageKeys = [];
    expect(detectWorkjetCoreGeneration(noKey)).toBe("v3");
  });
});

describe("V4 bootstrap: mount only on a V4 instance", () => {
  it("V3 instance: no mount, no kernel opened", async () => {
    const instanceId = `wj-v3-${++sequence}`;
    const { host: controller, sessions } = host(async () => v3LaunchContext);
    expect(await controller.sync(instanceId)).toEqual({ instanceId, generation: "v3" });
    expect(sessions.openSession).not.toHaveBeenCalled();
    expect(getCtoxClient(instanceId)).toBeNull();
  });

  it("V4 instance: mounts the kernel client under the Workjet instance id", async () => {
    const instanceId = `wj-v4-${++sequence}`;
    commitActiveWorkjetSelection(instanceId);
    const { host: controller, sessions } = host(async () => v4LaunchContext(`core-${sequence}`));
    expect(await controller.sync(instanceId)).toEqual({ instanceId, generation: "v4" });
    expect(sessions.openSession).toHaveBeenCalledTimes(1);
    const api = getCtoxClient(instanceId);
    expect(api?.app.id).toBe("workjet");
    // The selection stays on the Workjet id even though the core names itself differently.
    expect(readActiveWorkjetScope().selectedInstanceId).toBe(instanceId);
    // A reconnect that still reports V4 keeps the same mount.
    await controller.sync(instanceId);
    expect(sessions.openSession).toHaveBeenCalledTimes(1);
    expect(getCtoxClient(instanceId)).toBe(api);
  });

  it("V4 -> V3 on reconnect unmounts and closes the kernel", async () => {
    const instanceId = `wj-switch-${++sequence}`;
    let payload: unknown = v4LaunchContext(`core-${sequence}`);
    const { host: controller, sessions } = host(async () => payload);
    await controller.sync(instanceId);
    expect(getCtoxClient(instanceId)).not.toBeNull();
    payload = v3LaunchContext;
    expect(await controller.sync(instanceId)).toEqual({ instanceId, generation: "v3" });
    expect(getCtoxClient(instanceId)).toBeNull();
    expect(sessions.opened.every((entry) => entry.closed)).toBe(true);
  });

  it("instance switch unmounts the previous V4 instance", async () => {
    const first = `wj-a-${++sequence}`;
    const second = `wj-b-${sequence}`;
    const { host: controller, sessions } = host(async (instanceId) =>
      instanceId === first ? v4LaunchContext(`core-a-${sequence}`) : v3LaunchContext,
    );
    await controller.sync(first);
    expect(getCtoxClient(first)).not.toBeNull();
    await controller.sync(second);
    expect(getCtoxClient(first)).toBeNull();
    expect(getCtoxClient(second)).toBeNull();
    expect(sessions.opened[0]?.closed).toBe(true);
  });

  it("an unreachable control plane keeps a live V4 mount and never mounts a new instance", async () => {
    const instanceId = `wj-offline-${++sequence}`;
    let reachable = true;
    const { host: controller, sessions } = host(async (id) => {
      if (!reachable) throw new Error("guest_failed");
      return v4LaunchContext(`core-${id}`);
    });
    await controller.sync(instanceId);
    reachable = false;
    await controller.sync(instanceId);
    expect(getCtoxClient(instanceId)).not.toBeNull();
    const other = `wj-offline-other-${sequence}`;
    expect(await controller.sync(other)).toEqual({ instanceId: other, generation: null });
    expect(getCtoxClient(other)).toBeNull();
    expect(getCtoxClient(instanceId)).toBeNull();
    expect(sessions.openSession).toHaveBeenCalledTimes(1);
  });

  it("a failed V4 boot leaves the instance unmounted", async () => {
    const instanceId = `wj-boot-fail-${++sequence}`;
    const controller = createWorkjetV4Host({
      appVersion: "bootstrap-test",
      readLaunchContext: async () => v4LaunchContext("core-fail"),
      openSession: async () => {
        throw new Error("transport_unavailable");
      },
    });
    hosts.push(controller);
    await expect(controller.sync(instanceId)).rejects.toThrow("transport_unavailable");
    expect(controller.getState()).toEqual({ instanceId, generation: null });
    expect(getCtoxClient(instanceId)).toBeNull();
  });

  it("dispose unmounts", async () => {
    const instanceId = `wj-dispose-${++sequence}`;
    const { host: controller } = host(async () => v4LaunchContext(`core-${sequence}`));
    await controller.sync(instanceId);
    await controller.dispose();
    expect(getCtoxClient(instanceId)).toBeNull();
  });
});
