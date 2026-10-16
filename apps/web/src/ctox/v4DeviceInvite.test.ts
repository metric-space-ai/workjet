import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { instanceAddRequestFromSearch } from "../instanceSetup";
import { redeemWorkjetDeviceInvite } from "./instanceAccess";
import {
  V4_INVITE_FAILURE_TEXT,
  V4_INVITE_REJECTIONS,
  deriveV4InviteProof,
  encodeV4DeviceInviteLink,
  isV4DeviceInviteLink,
  normalizeV4DeviceLabel,
  parseV4DeviceInviteLink,
  redeemV4DeviceInvite,
  type V4DeviceInvite,
  type V4InviteRejection,
  type V4PairingControlRequest,
} from "./v4DeviceInvite";
import { createMemoryV4DeviceKeyStorage, createV4DeviceKeySource } from "./v4DeviceKey";
import { pairedFirstLaunchContextReader } from "./v4HostWiring";
import {
  hasPairedV4LaunchContext,
  resetPairedV4LaunchContexts,
  subscribePairedV4LaunchContexts,
  takePairedV4LaunchContext,
} from "./v4PairedLaunchContexts";
import { V4_PAIRING_CONTROL_CHANNEL, createV4PairingControlExchange } from "./v4PairingPeer";

const NOW = 1_800_000_000_000;
const INVITE_ID = "0b6f6f5e-3c1a-4d2e-9f00-123456789abc";
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const SECRET = b64(Uint8Array.from({ length: 32 }, (_, index) => index));
const DEVICE_7 = b64(new Uint8Array(32).fill(7));

function invite(overrides: Partial<V4DeviceInvite> = {}): V4DeviceInvite {
  return {
    instanceId: "inst-1",
    signaling: {
      urls: ["wss://signal.example/ws"],
      room: "ctox-pair-room",
      nativePeerId: "native-1",
      token: "pairing-signal-token",
      iceServers: [],
    },
    inviteId: INVITE_ID,
    oneTimeSecret: SECRET,
    expiresAtMs: NOW + 60_000,
    ...overrides,
  };
}

const launchContext = (instanceId = "inst-1") => ({
  v4: {
    instanceId,
    userId: "u-1",
    actor: { id: "u-1", role: "user" },
    signaling: {
      urls: ["wss://signal.example/ws"],
      room: "room",
      peerId: "peer",
      nativePeerId: "native",
      token: "t",
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
          device_id: "device-1",
          public_key: "A".repeat(43),
          nonce: "B".repeat(43),
          signature: "C".repeat(86),
        },
        scopes_wanted: [],
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
});

/** Independent reference of the #927 proof (Node crypto, not the code under test). */
function referenceProof(secret: string, inviteId: string, devicePubkey: string) {
  const key = NodeCrypto.createHash("sha256")
    .update(
      Buffer.concat([Buffer.from("ctox.device.invite.key.v1\0"), Buffer.from(secret, "base64url")]),
    )
    .digest();
  const id = Buffer.from(inviteId, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(id.length);
  return NodeCrypto.createHmac("sha256", key)
    .update(
      Buffer.concat([
        Buffer.from("ctox.device.invite.redeem.v1\0"),
        length,
        id,
        Buffer.from(devicePubkey, "base64url"),
      ]),
    )
    .digest("base64url");
}

/**
 * Fake Core behind the pairing port: single use, expiry, HMAC proof (ctox #927 semantics) and a
 * forced rejection code for the remaining cases.
 */
function createFakeCore(options: { forced?: V4InviteRejection; expiresAtMs?: number } = {}) {
  const used = new Set<string>();
  const received: V4PairingControlRequest[] = [];
  return {
    received,
    handle(request: V4PairingControlRequest, now: number) {
      received.push(request);
      const reply = (body: object) => ({ type: "pairing_response", id: request.id, ...body });
      if (request.method !== "device.invite.redeem" || request.params.length !== 1)
        return reply({ error: { code: "device_rejected" } });
      const [redeem] = request.params;
      if (Object.keys(redeem).sort().join(",") !== "device_label,device_pubkey,invite_id,proof")
        return reply({ error: { code: "device_rejected" } });
      if (options.forced) return reply({ error: { code: options.forced } });
      if (redeem.invite_id !== INVITE_ID) return reply({ error: { code: "invite_unknown" } });
      if (used.has(redeem.invite_id)) return reply({ error: { code: "invite_used" } });
      if ((options.expiresAtMs ?? NOW + 60_000) <= now)
        return reply({ error: { code: "invite_expired" } });
      if (redeem.proof !== referenceProof(SECRET, redeem.invite_id, redeem.device_pubkey))
        return reply({ error: { code: "proof_invalid" } });
      used.add(redeem.invite_id);
      return reply({ result: launchContext() });
    },
  };
}

/** Fake signaling server + native pairing peer, wired to the WebSocket/RTCPeerConnection seams. */
function createFakeSignaling(
  core: ReturnType<typeof createFakeCore>,
  options: { failUrls?: ReadonlyArray<string>; dropAfterRequest?: boolean } = {},
) {
  const sockets: string[] = [];
  const channels: string[] = [];
  const signals: unknown[] = [];
  let peerOnChannel: ((data: string) => void) | null = null;
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
      peerOnChannel?.(data);
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
      // The native pairing peer accepts the connection: open lane 0 and serve one request.
      queueMicrotask(() => {
        const open = channel;
        if (!open) return;
        peerOnChannel = (data) => {
          const response = core.handle(JSON.parse(data) as V4PairingControlRequest, NOW);
          queueMicrotask(() =>
            options.dropAfterRequest
              ? open.emit("close")
              : open.emit("message", JSON.stringify(response)),
          );
        };
        open.readyState = "open";
        open.emit("open");
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
      const failing = options.failUrls?.some((prefix) => url.startsWith(prefix)) ?? false;
      queueMicrotask(() => {
        if (failing) return this.onerror?.({});
        this.readyState = 1;
        this.onopen?.({});
      });
    }
    send(data: string) {
      const message = JSON.parse(data) as { type: string; data?: { type: string } };
      signals.push(message);
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
  const exchange = createV4PairingControlExchange({
    WebSocketImpl: FakeWebSocket,
    RTCPeerConnectionImpl: FakePeer,
    timeoutMs: 2_000,
    peerId: () => "pairing-peer-1",
  });
  return { exchange, sockets, channels, signals };
}

const deviceKeys = () => createV4DeviceKeySource(createMemoryV4DeviceKeyStorage());

afterEach(() => resetPairedV4LaunchContexts());

describe("E54.4 proof derivation (ctox #927 contract)", () => {
  it("matches the independent reference vectors", async () => {
    // Fixed vector computed outside this code (Python hashlib/hmac) for the #927 formula.
    await expect(
      deriveV4InviteProof({ oneTimeSecret: SECRET, inviteId: INVITE_ID, devicePubkey: DEVICE_7 }),
    ).resolves.toBe("o7CVwRHD3c7qpy0Jdm9TYcNJLtqSKmAkrncPh5cdVTQ");
    const device8 = b64(new Uint8Array(32).fill(8));
    await expect(
      deriveV4InviteProof({ oneTimeSecret: SECRET, inviteId: INVITE_ID, devicePubkey: device8 }),
    ).resolves.toBe("M6LQyzG7EqbxYwbHa9bLGvpDJwD_S5ql-9bTg7_QRJQ");
    expect(referenceProof(SECRET, INVITE_ID, DEVICE_7)).toBe(
      "o7CVwRHD3c7qpy0Jdm9TYcNJLtqSKmAkrncPh5cdVTQ",
    );
  });

  it("refuses non-canonical secret or device key", async () => {
    await expect(
      deriveV4InviteProof({
        oneTimeSecret: `${SECRET}=`,
        inviteId: INVITE_ID,
        devicePubkey: DEVICE_7,
      }),
    ).rejects.toThrow();
    await expect(
      deriveV4InviteProof({
        oneTimeSecret: SECRET,
        inviteId: INVITE_ID,
        devicePubkey: b64(new Uint8Array(31)),
      }),
    ).rejects.toThrow();
  });

  it("keeps the device label display-only within the Core bounds", () => {
    expect(normalizeV4DeviceLabel("Workjet\n(macOS)")).toBe("Workjet (macOS)");
    expect(normalizeV4DeviceLabel("  ")).toBe("Workjet");
    expect(
      new TextEncoder().encode(normalizeV4DeviceLabel("ä".repeat(200))).length,
    ).toBeLessThanOrEqual(128);
  });
});

describe("E54.4 invitation link", () => {
  it("round-trips the payload and leaves V3 pairing links to their import path", () => {
    const parsed = parseV4DeviceInviteLink(encodeV4DeviceInviteLink(invite()), NOW);
    expect(parsed).toEqual({ ok: true, invite: invite() });
    const v3 = `workjet://pair?payload=${b64(new TextEncoder().encode(JSON.stringify(["w2", "x"])))}`;
    expect(parseV4DeviceInviteLink(v3, NOW)).toBeNull();
    expect(parseV4DeviceInviteLink("https://evil.example/pair?payload=abc", NOW)).toBeNull();
  });

  it("arrives unchanged through the workjet://pair deep link route", () => {
    const link = encodeV4DeviceInviteLink(invite());
    const payload = new URL(link.replace(/^workjet:/u, "https:")).searchParams.get("payload");
    const request = instanceAddRequestFromSearch({ add: "link", payload });
    expect(request?.option).toBe("link");
    expect(request?.invite).toBe(link);
    expect(isV4DeviceInviteLink(request?.invite ?? "")).toBe(true);
    expect(isV4DeviceInviteLink(encodeV4DeviceInviteLink(invite({ expiresAtMs: 1 })))).toBe(true);
  });

  it("rejects malformed invitations and claims beyond 24 h", () => {
    for (const bad of [
      invite({ inviteId: "not-a-uuid" }),
      invite({ inviteId: INVITE_ID.toUpperCase() }),
      invite({ oneTimeSecret: "short" }),
      invite({ signaling: { ...invite().signaling, urls: ["https://signal.example"] } }),
      invite({ expiresAtMs: NOW + 86_400_001 }),
    ])
      expect(parseV4DeviceInviteLink(encodeV4DeviceInviteLink(bad), NOW)).toEqual({
        ok: false,
        code: "invite_invalid",
      });
  });
});

describe("E54.4 redeem against a fake signaling + pairing peer", () => {
  it("redeems over the control lane only, stores the launch context and triggers the bootstrap", async () => {
    const core = createFakeCore();
    const signaling = createFakeSignaling(core);
    const keys = deviceKeys();
    const triggered: string[] = [];
    const off = subscribePairedV4LaunchContexts((id) => triggered.push(id));
    const outcome = await redeemWorkjetDeviceInvite(encodeV4DeviceInviteLink(invite()), {
      exchange: signaling.exchange,
      deviceKeys: keys,
      deviceLabel: "Workjet (macOS)",
      now: () => NOW,
    });
    off();
    if (!outcome.ok) throw new Error(outcome.code);
    expect(outcome.launchContext.instanceId).toBe("inst-1");
    // Exactly one data channel, the V4 control lane; signaling as pairing peer.
    expect(signaling.channels).toEqual([V4_PAIRING_CONTROL_CHANNEL]);
    const url = new URL(signaling.sockets[0] ?? "");
    expect(url.searchParams.get("role")).toBe("pairing");
    expect(url.searchParams.get("room")).toBe("ctox-pair-room");
    expect(url.searchParams.get("token")).toBe("pairing-signal-token");
    // Request: exactly the four contract fields, proof bound to this device key.
    const [request] = core.received;
    expect(request?.method).toBe("device.invite.redeem");
    const devicePubkey = await keys.publicKeyFor("inst-1");
    expect(request?.params).toEqual([
      {
        invite_id: INVITE_ID,
        proof: referenceProof(SECRET, INVITE_ID, devicePubkey),
        device_pubkey: devicePubkey,
        device_label: "Workjet (macOS)",
      },
    ]);
    // Stored once for the bootstrap (single-use E50 ticket), which was notified.
    expect(triggered).toEqual(["inst-1"]);
    expect(hasPairedV4LaunchContext("inst-1")).toBe(true);
    const fallback = vi.fn(async () => ({ v4: "fallback" }));
    const reader = pairedFirstLaunchContextReader(fallback);
    await expect(reader("inst-1")).resolves.toEqual(launchContext());
    await expect(reader("inst-1")).resolves.toEqual({ v4: "fallback" });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("maps a second use and a wrong secret to the Core codes", async () => {
    const core = createFakeCore();
    const signaling = createFakeSignaling(core);
    const options = { exchange: signaling.exchange, deviceKeys: deviceKeys(), now: () => NOW };
    const link = encodeV4DeviceInviteLink(invite());
    expect((await redeemV4DeviceInvite({ ...options, link, deviceLabel: "W" })).ok).toBe(true);
    expect(await redeemV4DeviceInvite({ ...options, link, deviceLabel: "W" })).toEqual({
      ok: false,
      code: "invite_used",
    });
    const wrong = encodeV4DeviceInviteLink(
      invite({ oneTimeSecret: b64(new Uint8Array(32).fill(1)) }),
    );
    expect(
      await redeemV4DeviceInvite({
        ...options,
        exchange: createFakeSignaling(createFakeCore()).exchange,
        link: wrong,
        deviceLabel: "W",
      }),
    ).toEqual({ ok: false, code: "proof_invalid" });
  });

  it.each(V4_INVITE_REJECTIONS)(
    "passes the Core rejection %s through with a short text",
    async (code) => {
      const signaling = createFakeSignaling(createFakeCore({ forced: code }));
      const outcome = await redeemWorkjetDeviceInvite(encodeV4DeviceInviteLink(invite()), {
        exchange: signaling.exchange,
        deviceKeys: deviceKeys(),
        now: () => NOW,
      });
      expect(outcome).toEqual({ ok: false, code });
      expect(hasPairedV4LaunchContext("inst-1")).toBe(false);
      expect(V4_INVITE_FAILURE_TEXT[code].text.length).toBeGreaterThan(0);
    },
  );

  it("never sends a link that is locally recognisable as expired", async () => {
    const core = createFakeCore();
    const signaling = createFakeSignaling(core);
    const exchange = vi.fn(signaling.exchange);
    const outcome = await redeemV4DeviceInvite({
      link: encodeV4DeviceInviteLink(invite({ expiresAtMs: NOW - 1 })),
      exchange,
      deviceKeys: deviceKeys(),
      deviceLabel: "W",
      now: () => NOW,
    });
    expect(outcome).toEqual({ ok: false, code: "invite_expired" });
    expect(exchange).not.toHaveBeenCalled();
    expect(signaling.sockets).toEqual([]);
    expect(core.received).toEqual([]);
  });

  it("tries the next signaling URL only before the request left", async () => {
    const core = createFakeCore();
    const signaling = createFakeSignaling(core, { failUrls: ["wss://down.example"] });
    const outcome = await redeemV4DeviceInvite({
      link: encodeV4DeviceInviteLink(
        invite({
          signaling: {
            ...invite().signaling,
            urls: ["wss://down.example/ws", "wss://signal.example/ws"],
          },
        }),
      ),
      exchange: signaling.exchange,
      deviceKeys: deviceKeys(),
      deviceLabel: "W",
      now: () => NOW,
    });
    expect(outcome.ok).toBe(true);
    expect(signaling.sockets).toHaveLength(2);

    const dropping = createFakeSignaling(createFakeCore(), { dropAfterRequest: true });
    const lost = await redeemV4DeviceInvite({
      link: encodeV4DeviceInviteLink(
        invite({
          signaling: {
            ...invite().signaling,
            urls: ["wss://signal.example/a", "wss://signal.example/b"],
          },
        }),
      ),
      exchange: dropping.exchange,
      deviceKeys: deviceKeys(),
      deviceLabel: "W",
      now: () => NOW,
    });
    expect(lost).toEqual({ ok: false, code: "unreachable" });
    expect(dropping.sockets).toHaveLength(1);
  });

  it("rejects an answer for another instance or without a valid launch context", async () => {
    const link = encodeV4DeviceInviteLink(invite());
    const base = { link, deviceKeys: deviceKeys(), deviceLabel: "W", now: () => NOW };
    const answer =
      (body: object) => async (_target: unknown, request: V4PairingControlRequest) => ({
        type: "pairing_response",
        id: request.id,
        ...body,
      });
    await expect(
      redeemV4DeviceInvite({ ...base, exchange: answer({ result: launchContext("other") }) }),
    ).resolves.toEqual({ ok: false, code: "launch_context_invalid" });
    await expect(
      redeemV4DeviceInvite({ ...base, exchange: answer({ result: { v4: {} } }) }),
    ).resolves.toEqual({ ok: false, code: "launch_context_invalid" });
    await expect(
      redeemV4DeviceInvite({ ...base, exchange: answer({ error: { code: "teapot" } }) }),
    ).resolves.toEqual({ ok: false, code: "launch_context_invalid" });
    expect(takePairedV4LaunchContext("inst-1")).toBeUndefined();
  });
});

describe("E54.4 device key", () => {
  it("creates one Ed25519 key per instance and reuses it", async () => {
    const keys = deviceKeys();
    const [first, again] = await Promise.all([keys.keyFor("inst-1"), keys.keyFor("inst-1")]);
    expect(again).toBe(first);
    expect(Buffer.from(first.publicKey, "base64url")).toHaveLength(32);
    expect(first.privateKey.extractable).toBe(false);
    expect((await keys.keyFor("inst-2")).publicKey).not.toBe(first.publicKey);
    const message = new TextEncoder().encode("probe");
    const signature = await crypto.subtle.sign("Ed25519", first.privateKey, message);
    const publicKey = await crypto.subtle.importKey(
      "raw",
      Buffer.from(first.publicKey, "base64url"),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    await expect(crypto.subtle.verify("Ed25519", publicKey, signature, message)).resolves.toBe(
      true,
    );
  });
});
