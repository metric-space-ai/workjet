// E54.5: device.launch.renew over the pairing peer (challenge first), the device instance
// directory, and the restart case (stored entry + renewal = bound V4 bootstrap).
import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { commitActiveWorkjetSelection } from "../activeWorkjetScope";
import { getCtoxClient } from "./ctoxClient";
import { renewWorkjetDeviceLaunch, redeemWorkjetDeviceInvite } from "./instanceAccess";
import { createKernel } from "./kernel/kernel.mjs";
import { MemoryCoreTransport } from "./kernelTestkit";
import { encodeV4DeviceInviteLink, type V4PairingControlRequest } from "./v4DeviceInvite";
import {
  createMemoryV4DeviceKeyStorage,
  createV4DeviceKeySource,
  type V4StoredDeviceKey,
} from "./v4DeviceKey";
import {
  V4_RENEW_REJECTIONS,
  renewV4DeviceLaunch,
  signV4RenewChallenge,
  v4RenewSignedBytes,
  type V4RenewRejection,
} from "./v4DeviceRenew";
import type { WorkjetV4Session } from "./v4HostBootstrap";
import { startWorkjetV4HostBootstrap, v4RenewBackoffMs } from "./v4HostWiring";
import {
  createMemoryV4InstanceDirectoryStorage,
  getV4InstanceDirectoryEntry,
  isV4DirectoryInstance,
  loadV4InstanceDirectory,
  readV4InstanceDirectory,
  resetV4InstanceDirectory,
  type V4InstanceDirectoryEntry,
} from "./v4InstanceDirectory";
import { resetPairedV4LaunchContexts } from "./v4PairedLaunchContexts";
import { V4_PAIRING_CONTROL_CHANNEL, createV4PairingChallengeExchange } from "./v4PairingPeer";
import { WORKJET_APP_ID, workjetAppManifest } from "./workjetAppManifest";

const NOW = 1_800_000_000_000;
const APP_VER = "renew-test";
const SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

async function seededKey(): Promise<V4StoredDeviceKey> {
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(SEED, 16);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, [
    "sign",
  ]);
  return { privateKey, publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg" };
}

function launchContext(instanceId: string, deviceId: string) {
  return {
    v4: {
      instanceId,
      userId: "u-1",
      actor: { id: "u-1", role: "user" },
      signaling: {
        urls: ["wss://signal.example/ws"],
        room: `room-${deviceId}`,
        peerId: "browser-1",
        nativePeerId: "native-1",
        token: `token-${deviceId}`,
        iceServers: [],
      },
      hello: {
        offer: {
          type: "hello",
          protocol_ver: 4,
          bootstrap_ver: 1,
          app_api_ver: { min: "4.0", max: "4.0" },
          instance_id: instanceId,
          capabilities: [],
          device_proof: {
            device_id: deviceId,
            public_key: "A".repeat(43),
            nonce: "B".repeat(43),
            signature: "C".repeat(86),
          },
          scopes_wanted: ["workjet_projects"],
          transport: {
            codecs: ["gzip"],
            max_frame_bytes: 16384,
            fragmentation: true,
            reassembly: true,
          },
        },
      },
      packageKeys: [{ keyId: "k1", alg: "Ed25519", publicKey: "A".repeat(43) }],
    },
  };
}

function entry(overrides: Partial<V4InstanceDirectoryEntry> = {}): V4InstanceDirectoryEntry {
  return {
    instanceId: "inst-1",
    displayName: "inst-1",
    userId: "u-1",
    role: "user",
    deviceId: "device-1",
    signaling: {
      urls: ["wss://signal.example/ws"],
      room: "room-device-1",
      nativePeerId: "native-1",
      token: "token-device-1",
      iceServers: [],
    },
    state: "paired",
    updatedAtMs: NOW - 1,
    ...overrides,
  };
}

/**
 * Fake Core behind the pairing port: sends the challenge first, verifies the Ed25519 signature
 * with Node crypto (independent of the code under test) and the device registry.
 */
function createFakeRenewCore(
  options: {
    publicKey?: string;
    device?: "known" | "unknown" | "revoked";
    forced?: V4RenewRejection;
    challengeExpiresAtMs?: number;
    rejectBeforeChallenge?: V4RenewRejection;
  } = {},
) {
  const received: V4PairingControlRequest[] = [];
  let renewals = 0;
  let nonce = "";
  return {
    received,
    challenge() {
      if (options.rejectBeforeChallenge)
        return {
          type: "pairing_response",
          id: null,
          error: { code: options.rejectBeforeChallenge },
        };
      nonce = Buffer.from(`nonce-${renewals}`).toString("base64url");
      return {
        type: "pairing_challenge",
        nonce,
        expires_at_ms: options.challengeExpiresAtMs ?? NOW + 30_000,
      };
    },
    handle(request: V4PairingControlRequest) {
      received.push(request);
      const reply = (body: object) => ({ type: "pairing_response", id: request.id, ...body });
      if (request.method !== "device.launch.renew" || request.params.length !== 1)
        return reply({ error: { code: "device_unknown" } });
      const params = request.params[0] as unknown as Record<string, string>;
      if (
        Object.keys(params).sort().join(",") !== "device_id,instance_id,nonce,signature" ||
        params.nonce !== nonce
      )
        return reply({ error: { code: "signature_invalid" } });
      if (options.forced) return reply({ error: { code: options.forced } });
      if (options.device === "unknown") return reply({ error: { code: "device_unknown" } });
      if (options.device === "revoked") return reply({ error: { code: "device_revoked" } });
      const publicKey = NodeCrypto.createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(options.publicKey ?? "", "base64url"),
        ]),
        format: "der",
        type: "spki",
      });
      const signed = Buffer.from(
        `ctox-v4-device-renew\n${params.instance_id}${params.device_id}${params.nonce}`,
      );
      if (
        !NodeCrypto.verify(
          null,
          signed,
          publicKey,
          Buffer.from(params.signature ?? "", "base64url"),
        )
      )
        return reply({ error: { code: "signature_invalid" } });
      renewals += 1;
      return reply({ result: launchContext(params.instance_id ?? "", `device-r${renewals}`) });
    },
  };
}

/** Fake signaling + native pairing peer that opens lane 0 and speaks first with the challenge. */
function createFakeSignaling(core: ReturnType<typeof createFakeRenewCore>) {
  const sockets: string[] = [];
  const channels: string[] = [];
  class FakeChannel {
    readyState = "connecting";
    listeners = new Map<string, Array<(event: { data: unknown }) => void>>();
    constructor(readonly label: string) {}
    addEventListener(name: string, listener: (event: { data: unknown }) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    emit(name: string, data?: unknown) {
      for (const listener of this.listeners.get(name) ?? []) listener({ data });
    }
    send(data: string) {
      const response = core.handle(JSON.parse(data) as V4PairingControlRequest);
      queueMicrotask(() => this.emit("message", JSON.stringify(response)));
    }
  }
  let channel: FakeChannel | null = null;
  class FakePeer {
    onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
    createDataChannel(label: string) {
      channels.push(label);
      channel = new FakeChannel(label);
      return channel;
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0 offer" };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {
      queueMicrotask(() => {
        const open = channel;
        if (!open) return;
        open.readyState = "open";
        open.emit("open");
        // The Core speaks first on a renewal connection.
        queueMicrotask(() => open.emit("message", JSON.stringify(core.challenge())));
      });
    }
    async addIceCandidate() {}
    close() {}
  }
  class FakeWebSocket {
    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(readonly url: string) {
      sockets.push(url);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.({});
      });
    }
    send(data: string) {
      const message = JSON.parse(data) as { type: string; data?: { type: string } };
      if (message.type === "join")
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "joined" }) }));
      if (message.type === "signal" && message.data?.type === "offer")
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify({
              type: "signal",
              senderPeerId: "native-1",
              data: { type: "answer", sdp: "v=0 answer" },
            }),
          }),
        );
    }
    close() {
      this.readyState = 3;
    }
  }
  const exchange = createV4PairingChallengeExchange({
    WebSocketImpl: FakeWebSocket,
    RTCPeerConnectionImpl: FakePeer,
    timeoutMs: 2_000,
    peerId: () => "pairing-peer-1",
  });
  return { exchange, sockets, channels };
}

async function keysWith(key?: V4StoredDeviceKey) {
  const storage = createMemoryV4DeviceKeyStorage();
  if (key) await storage.putIfAbsent("inst-1", key);
  return createV4DeviceKeySource(storage);
}

const hosts: Array<() => void> = [];
afterEach(() => {
  for (const stop of hosts.splice(0)) stop();
  commitActiveWorkjetSelection(null);
  resetV4InstanceDirectory();
  resetPairedV4LaunchContexts();
});

describe("E54.5 renew signature", () => {
  it("matches the independent Ed25519 vector", async () => {
    // Computed outside this code (Python `cryptography` and `openssl pkeyutl`, seed 00..1f).
    expect(
      new TextDecoder().decode(
        v4RenewSignedBytes({ instanceId: "inst-1", deviceId: "device-1", nonce: "bm9uY2UtMQ" }),
      ),
    ).toBe("ctox-v4-device-renew\ninst-1device-1bm9uY2UtMQ");
    await expect(
      signV4RenewChallenge((await seededKey()).privateKey, {
        instanceId: "inst-1",
        deviceId: "device-1",
        nonce: "bm9uY2UtMQ",
      }),
    ).resolves.toBe(
      "i9cO5j1_sH4UompVuzH64v2JaLVWRxRuVtE0_LAxo6JKt-rTonx6tAyEefg_EbH-X4F__dfGmD4JhA5hf0R7AA",
    );
  });
});

describe("E54.5 renew against a fake pairing peer with challenge", () => {
  it("answers the challenge and returns a fresh launch context", async () => {
    const key = await seededKey();
    const core = createFakeRenewCore({ publicKey: key.publicKey });
    const signaling = createFakeSignaling(core);
    const outcome = await renewV4DeviceLaunch({
      entry: entry(),
      deviceKeys: await keysWith(key),
      exchange: signaling.exchange,
      now: () => NOW,
    });
    if (!outcome.ok) throw new Error(outcome.code);
    expect(outcome.launchContext.hello.offer.device_proof.device_id).toBe("device-r1");
    expect(signaling.channels).toEqual([V4_PAIRING_CONTROL_CHANNEL]);
    const url = new URL(signaling.sockets[0] ?? "");
    expect(url.searchParams.get("role")).toBe("pairing");
    expect(url.searchParams.get("protocol")).toBe("ctox-v4-pairing");
    expect(url.searchParams.get("room")).toBe("room-device-1");
    expect(core.received).toHaveLength(1);
    expect(core.received[0]?.method).toBe("device.launch.renew");
  });

  it.each([
    ["device_unknown", { device: "unknown" as const }],
    ["device_revoked", { device: "revoked" as const }],
    ["signature_invalid", { publicKey: Buffer.alloc(32, 9).toString("base64url") }],
    ["challenge_expired", { forced: "challenge_expired" as const }],
    ["rate_limited", { rejectBeforeChallenge: "rate_limited" as const }],
  ])("maps %s", async (code, options) => {
    const key = await seededKey();
    const core = createFakeRenewCore({ publicKey: key.publicKey, ...options });
    const outcome = await renewV4DeviceLaunch({
      entry: entry(),
      deviceKeys: await keysWith(key),
      exchange: createFakeSignaling(core).exchange,
      now: () => NOW,
    });
    expect(outcome).toEqual({ ok: false, code });
    expect(V4_RENEW_REJECTIONS).toContain(code);
  });

  it("does not answer a locally expired challenge and never creates a device key", async () => {
    const key = await seededKey();
    const core = createFakeRenewCore({ publicKey: key.publicKey, challengeExpiresAtMs: NOW - 1 });
    await expect(
      renewV4DeviceLaunch({
        entry: entry(),
        deviceKeys: await keysWith(key),
        exchange: createFakeSignaling(core).exchange,
        now: () => NOW,
      }),
    ).resolves.toEqual({ ok: false, code: "challenge_expired" });
    expect(core.received).toEqual([]);
    const exchange = vi.fn();
    const keys = await keysWith();
    await expect(
      renewV4DeviceLaunch({ entry: entry(), deviceKeys: keys, exchange, now: () => NOW }),
    ).resolves.toEqual({ ok: false, code: "device_unknown" });
    expect(exchange).not.toHaveBeenCalled();
    await expect(keys.existingKeyFor("inst-1")).resolves.toBeUndefined();
  });

  it("backs off silently: 2 s, 4 s, … at most 60 s", () => {
    expect([1, 2, 3, 6, 10].map(v4RenewBackoffMs)).toEqual([2_000, 4_000, 8_000, 60_000, 60_000]);
  });
});

describe("E54.5 instance directory", () => {
  it("records the redeemed instance and refreshes it on renew; revocation unpairs it", async () => {
    const storage = createMemoryV4InstanceDirectoryStorage();
    resetV4InstanceDirectory(storage);
    await loadV4InstanceDirectory();
    const keyStorage = createMemoryV4DeviceKeyStorage();
    await keyStorage.putIfAbsent("inst-1", await seededKey());
    const deviceKeys = createV4DeviceKeySource(keyStorage);
    const link = encodeV4DeviceInviteLink({
      instanceId: "inst-1",
      signaling: {
        urls: ["wss://signal.example/ws"],
        room: "r",
        nativePeerId: "n",
        iceServers: [],
      },
      inviteId: "0b6f6f5e-3c1a-4d2e-9f00-123456789abc",
      oneTimeSecret: "A".repeat(43),
      expiresAtMs: NOW + 60_000,
    });
    const redeemed = await redeemWorkjetDeviceInvite(link, {
      deviceKeys,
      now: () => NOW,
      exchange: async (_target, request) => ({
        type: "pairing_response",
        id: request.id,
        result: launchContext("inst-1", "device-1"),
      }),
    });
    expect(redeemed.ok).toBe(true);
    expect(getV4InstanceDirectoryEntry("inst-1")).toMatchObject({
      instanceId: "inst-1",
      displayName: "inst-1",
      deviceId: "device-1",
      state: "paired",
      signaling: { room: "room-device-1", nativePeerId: "native-1", token: "token-device-1" },
    });
    expect(storage.saved()).toHaveLength(1);
    expect(isV4DirectoryInstance("inst-1")).toBe(true);

    const key = await seededKey();
    const renewed = await renewWorkjetDeviceLaunch("inst-1", {
      deviceKeys,
      now: () => NOW + 5,
      exchange: createFakeSignaling(createFakeRenewCore({ publicKey: key.publicKey })).exchange,
    });
    expect(renewed?.ok).toBe(true);
    expect(getV4InstanceDirectoryEntry("inst-1")).toMatchObject({
      deviceId: "device-r1",
      updatedAtMs: NOW + 5,
      state: "paired",
    });
    expect(storage.saved()[0]?.deviceId).toBe("device-r1");

    const revoked = await renewWorkjetDeviceLaunch("inst-1", {
      deviceKeys,
      now: () => NOW + 6,
      exchange: createFakeSignaling(
        createFakeRenewCore({ publicKey: key.publicKey, device: "revoked" }),
      ).exchange,
    });
    expect(revoked).toEqual({ ok: false, code: "device_revoked" });
    expect(storage.saved()[0]?.state).toBe("unpaired");
    // Unpaired stops renewal until a new invitation.
    const exchange = vi.fn();
    await expect(renewWorkjetDeviceLaunch("inst-1", { deviceKeys, exchange })).resolves.toEqual({
      ok: false,
      code: "device_revoked",
    });
    expect(exchange).not.toHaveBeenCalled();
    await expect(renewWorkjetDeviceLaunch("other", { deviceKeys })).resolves.toBeNull();
  });
});

/** Memory kernel on the fake core; stands in for bootV4's authenticated WebRTC kernel. */
function memorySession() {
  const payloads: unknown[] = [];
  let sequence = 0;
  const openSession = vi.fn(async (_instanceId: string, payload: unknown) => {
    payloads.push(payload);
    const coreInstanceId = (payload as ReturnType<typeof launchContext>).v4.instanceId;
    const transport = new MemoryCoreTransport({ namespace: coreInstanceId, latencyMs: 0 });
    await transport.push("business_app_versions", [
      {
        id: `${WORKJET_APP_ID}@${APP_VER}`,
        app_id: WORKJET_APP_ID,
        app_ver: APP_VER,
        manifest: workjetAppManifest(APP_VER),
      },
    ]);
    await transport.push("business_apps", [
      { id: WORKJET_APP_ID, title: "Workjet", active_ver: APP_VER },
      { id: "shell", title: "Shell", active_ver: "renew-shell" },
    ]);
    const kernel = createKernel({
      instanceId: coreInstanceId,
      userId: "u-1",
      storage: "memory",
      dbName: `${coreInstanceId}-renew-${++sequence}-${Date.now()}`,
      multiTab: false,
      transport,
    });
    await kernel.ready;
    const apps = kernel.appApi("fixture-probe", "0").query<{ id: string }>("business_apps", {});
    const off = apps.subscribe(() => {});
    try {
      await vi.waitFor(
        () => {
          if (!apps.get().some((row) => row.id === "shell")) throw new Error("shell not synced");
        },
        { timeout: 2_000, interval: 5 },
      );
    } finally {
      off();
    }
    const session: WorkjetV4Session = { kernel, close: () => kernel.close() };
    return session;
  });
  return { openSession, payloads };
}

describe("E54.5 restart: stored directory entry + renew = bound bootstrap", () => {
  it("renews the restored selection over the pairing peer and binds the V4 client", async () => {
    // Previous session: the directory was persisted; this process starts with an empty cache.
    const storage = createMemoryV4InstanceDirectoryStorage([entry({ instanceId: "inst-restart" })]);
    resetV4InstanceDirectory(storage);
    const key = await seededKey();
    const keyStorage = createMemoryV4DeviceKeyStorage();
    await keyStorage.putIfAbsent("inst-restart", key);
    const deviceKeys = createV4DeviceKeySource(keyStorage);
    const core = createFakeRenewCore({ publicKey: key.publicKey });
    const signaling = createFakeSignaling(core);
    commitActiveWorkjetSelection("inst-restart");
    const sessions = memorySession();
    const desktopRead = vi.fn();
    hosts.push(
      startWorkjetV4HostBootstrap(
        { readV4LaunchContext: desktopRead } as unknown as Parameters<
          typeof startWorkjetV4HostBootstrap
        >[0],
        APP_VER,
        {
          renew: (instanceId) =>
            renewWorkjetDeviceLaunch(instanceId, {
              deviceKeys,
              exchange: signaling.exchange,
              now: () => NOW,
            }),
          openSession: sessions.openSession,
        },
      ),
    );
    await vi.waitFor(
      () => {
        if (getCtoxClient("inst-restart") === null) throw new Error("not bound");
      },
      { timeout: 5_000, interval: 10 },
    );
    expect(core.received.map((request) => request.method)).toEqual(["device.launch.renew"]);
    expect(desktopRead).not.toHaveBeenCalled();
    expect(sessions.payloads).toEqual([launchContext("inst-restart", "device-r1")]);
    expect(readV4InstanceDirectory()).toHaveLength(1);
    expect(getV4InstanceDirectoryEntry("inst-restart")?.deviceId).toBe("device-r1");
  });

  it("retries a failed renewal silently with backoff and stops on device_revoked", async () => {
    resetV4InstanceDirectory(createMemoryV4InstanceDirectoryStorage([entry()]));
    commitActiveWorkjetSelection("inst-1");
    const timers: number[] = [];
    let attempts = 0;
    const renew = vi.fn(async () => {
      attempts += 1;
      return {
        ok: false as const,
        code: attempts < 3 ? ("unreachable" as const) : ("device_revoked" as const),
      };
    });
    let pending: (() => void) | null = null;
    hosts.push(
      startWorkjetV4HostBootstrap(undefined, APP_VER, {
        renew,
        setTimer: (run, ms) => {
          timers.push(ms);
          pending = run;
          return () => {
            pending = null;
          };
        },
      }),
    );
    for (let round = 0; round < 3; round += 1) {
      await vi.waitFor(() => {
        if (renew.mock.calls.length < round + 1) throw new Error("waiting");
      });
      await vi.waitFor(() => {
        if (round < 2 && pending === null) throw new Error("no retry yet");
      });
      const run: (() => void) | null = pending;
      pending = null;
      if (run !== null) (run as () => void)();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renew).toHaveBeenCalledTimes(3);
    expect(timers).toEqual([2_000, 4_000]);
    expect(pending).toBeNull();
  });
});
