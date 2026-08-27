// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CtoxDiscoveryResult,
  CtoxDecisionHubProvisionInput,
  CtoxGuestBounds,
  CtoxInstanceApp,
  CtoxManagedActivationInput,
  CtoxManagedDiscoveryResult,
  CtoxManagedGuestResult,
  CtoxManagedInstance,
  CtoxManagedInstanceHealth,
  CtoxManualPairingImportInput,
  CtoxPairedInstanceImportResult,
  CtoxPairedInstanceMutationFailureCode,
  CtoxPairedInstanceRemoveInput,
  CtoxPairingInviteImportInput,
  WorkjetDeviceWebRtcRequestV1,
  WorkjetDeviceWebRtcResponseV1,
} from "./ctox.ts";

const decodeInstance = Schema.decodeUnknownSync(CtoxManagedInstance);
const decodeHealth = Schema.decodeUnknownSync(CtoxManagedInstanceHealth);
const decodeManagedDiscovery = Schema.decodeUnknownSync(CtoxManagedDiscoveryResult);
const decodeDiscovery = Schema.decodeUnknownSync(CtoxDiscoveryResult);
const control = String.fromCharCode(0);

const validInstance = {
  id: "managed:tenant_skf",
  source: "ctox_dev",
  displayName: "SKF",
  status: "available",
  domain: "acme.ctox.dev",
  role: "admin",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: true,
    httpDataProxy: false,
    nativePeerObserved: true,
  },
} as const;

const validManualPairing = {
  displayName: "Office Business OS",
  instanceId: "office-1",
  syncRoom: "ctox-business-os:office-1",
  signalingUrls: ["wss://signal.example.com/room"],
  roomSecret: "room-secret",
  capabilityToken: "capability-token",
  capabilityExpiresAtMs: 1_900_000_000_000,
  role: "admin",
  userId: "user-1",
} as const;

describe("CTOX renderer contracts", () => {
  it("routes Decision Hub provisioning by redacted managed or local identity", () => {
    const decode = Schema.decodeUnknownSync(CtoxDecisionHubProvisionInput, {
      onExcessProperty: "error",
    });
    expect(
      decode({
        environmentId: "environment-1",
        target: { _tag: "ctox_dev", tenantId: "tenant-1" },
      }).target._tag,
    ).toBe("ctox_dev");
    expect(
      decode({
        environmentId: "environment-1",
        target: { _tag: "local_ctox", instanceId: "local:abcdefghijklmnopqrstuv" },
      }).target._tag,
    ).toBe("local_ctox");
    expect(() =>
      decode({
        environmentId: "environment-1",
        target: { _tag: "ssh", instanceId: "ssh:host" },
      }),
    ).toThrow();
  });

  it("decodes renderer-safe managed and paired descriptors", () => {
    expect(decodeInstance(validInstance)).toEqual(validInstance);
    const paired = decodeInstance({
      ...validInstance,
      id: "paired:manual_pairing:stable",
      source: "manual_pairing",
      status: "paired",
      healthSummary: {
        dataPlane: "rxdb-webrtc",
        dataPlaneReady: false,
        httpDataProxy: false,
        nativePeerObserved: false,
      },
    });
    expect(paired.source).toBe("manual_pairing");
    expect(paired.status).toBe("paired");
  });

  it.each(["ctox_dev", "local_daemon", "ssh_managed", "pairing_invite", "manual_pairing"])(
    "accepts source %s",
    (source) => expect(decodeInstance({ ...validInstance, source }).source).toBe(source),
  );

  it.each([
    "available",
    "offline",
    "needs_auth",
    "pairing_expired",
    "paired",
    "installing",
    "error",
  ])("accepts status %s", (status) => {
    expect(decodeInstance({ ...validInstance, status }).status).toBe(status);
  });

  it("rejects unsupported source and status values", () => {
    expect(() => decodeInstance({ ...validInstance, source: "remote_harness" })).toThrow();
    expect(() => decodeInstance({ ...validInstance, status: "connected" })).toThrow();
  });

  it("fixes the data plane to RxDB/WebRTC and forbids an HTTP data proxy", () => {
    expect(() => decodeHealth({ ...validInstance.healthSummary, dataPlane: "http" })).toThrow();
    expect(() => decodeHealth({ ...validInstance.healthSummary, httpDataProxy: true })).toThrow();
  });

  it("rejects unbounded, control-bearing, and unsafe optional renderer text", () => {
    expect(() => decodeInstance({ ...validInstance, id: "a".repeat(513) })).toThrow();
    expect(() => decodeInstance({ ...validInstance, id: `bad${control}id` })).toThrow();
    expect(() => decodeInstance({ ...validInstance, displayName: `bad${control}name` })).toThrow();
    expect(() => decodeInstance({ ...validInstance, displayName: "a".repeat(257) })).toThrow();
    expect(() => decodeInstance({ ...validInstance, role: "a".repeat(129) })).toThrow();
    expect(() =>
      decodeInstance({ ...validInstance, domain: "https://user:secret@ctox.dev" }),
    ).toThrow();
  });

  it("strips all non-public pairing and launch metadata", () => {
    const decoded = decodeInstance({
      ...validInstance,
      userDisplayName: "Private User",
      pairingConfig: { syncRoom: "secret-room" },
      sessionPartition: "persist:server-controlled",
      tenantId: "tenant_skf",
      token: "secret",
      launchUrl: "https://ctox.dev/?token=secret",
      ciphertext: "encrypted-secret",
    });

    expect(decoded).toEqual(validInstance);
    expect(JSON.stringify(decoded)).not.toContain("secret");
    expect(JSON.stringify(decoded)).not.toContain("partition");
    expect(JSON.stringify(decoded)).not.toContain("Private User");
  });

  it("keeps raw managed discovery separate from unified merged discovery", () => {
    expect(decodeManagedDiscovery({ _tag: "ready", instances: [validInstance] })).toEqual({
      _tag: "ready",
      instances: [validInstance],
    });
    expect(
      decodeDiscovery({
        _tag: "ready",
        instances: [validInstance],
        managedState: "failed",
        managedFailureCode: "network_error",
      }),
    ).toEqual({
      _tag: "ready",
      instances: [validInstance],
      managedState: "failed",
      managedFailureCode: "network_error",
    });
    expect(decodeDiscovery({ _tag: "signed_out" })).toEqual({ _tag: "signed_out" });
    expect(decodeDiscovery({ _tag: "failed", code: "http_error", httpStatus: 503 })).toEqual({
      _tag: "failed",
      code: "http_error",
      httpStatus: 503,
    });
  });

  it("bounds the renderer-facing instance collection", () => {
    expect(() =>
      decodeDiscovery({
        _tag: "ready",
        instances: Array.from({ length: 1_001 }, () => validInstance),
      }),
    ).toThrow();
  });

  it("bounds invite and manual pairing inputs and rejects controls or invalid rooms", () => {
    const decodeInvite = Schema.decodeUnknownSync(CtoxPairingInviteImportInput);
    const decodeManual = Schema.decodeUnknownSync(CtoxManualPairingImportInput);
    expect(decodeInvite({ invite: "{}" })).toEqual({ invite: "{}" });
    expect(() => decodeInvite({ invite: "x".repeat(65_537) })).toThrow();
    expect(decodeManual(validManualPairing)).toEqual(validManualPairing);
    expect(() =>
      decodeManual({ ...validManualPairing, displayName: `bad${control}name` }),
    ).toThrow();
    expect(() => decodeManual({ ...validManualPairing, syncRoom: "other:office-1" })).toThrow();
    expect(() =>
      decodeManual({ ...validManualPairing, signalingUrls: Array(17).fill("wss://signal.test") }),
    ).toThrow();
    expect(() => decodeManual({ ...validManualPairing, capabilityExpiresAtMs: 1.5 })).toThrow();
  });

  it("defines exact mutation failure codes and strips secrets from IPC results", () => {
    const decodeCode = Schema.decodeUnknownSync(CtoxPairedInstanceMutationFailureCode);
    for (const code of [
      "invalid_input",
      "invalid_invite",
      "unsafe_secret_storage",
      "persistence_failed",
      "not_found",
      "managed_not_removable",
    ] as const) {
      expect(decodeCode(code)).toBe(code);
    }
    expect(() => decodeCode("invalid_pairing")).toThrow();

    const decoded = Schema.decodeUnknownSync(CtoxPairedInstanceImportResult)({
      _tag: "completed",
      instance: { ...validInstance, roomSecret: "secret", signalingUrls: ["wss://secret"] },
      capabilityToken: "secret",
    });
    expect(decoded).toEqual({ _tag: "completed", instance: validInstance });
    expect(JSON.stringify(decoded)).not.toContain("secret");
    expect(
      Schema.decodeUnknownSync(CtoxPairedInstanceRemoveInput)({
        instanceId: "paired:manual_pairing:stable",
      }),
    ).toEqual({ instanceId: "paired:manual_pairing:stable" });
  });

  it("accepts only finite nonnegative integer guest bounds and stable-id activation", () => {
    const decodeBounds = Schema.decodeUnknownSync(CtoxGuestBounds);
    const decodeActivation = Schema.decodeUnknownSync(CtoxManagedActivationInput);
    const bounds = { x: 1, y: 2, width: 800, height: 600 };
    expect(decodeBounds(bounds)).toEqual(bounds);
    expect(decodeActivation({ instanceId: validInstance.id, bounds })).toEqual({
      instanceId: validInstance.id,
      bounds,
    });
    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => decodeBounds({ ...bounds, width: invalid })).toThrow();
    }
  });

  it("carries an optional bounded app category and stays decodable without it", () => {
    const decodeApp = Schema.decodeUnknownSync(CtoxInstanceApp);
    expect(decodeApp({ id: "tickets", title: "Tickets", docked: true, open: false })).toEqual({
      id: "tickets",
      title: "Tickets",
      docked: true,
      open: false,
    });
    expect(
      decodeApp({
        id: "tickets",
        title: "Tickets",
        category: "Operations",
        docked: true,
        open: false,
      }),
    ).toEqual({
      id: "tickets",
      title: "Tickets",
      category: "Operations",
      docked: true,
      open: false,
    });
    for (const invalid of ["", " ", "a".repeat(65), `bad${control}category`]) {
      expect(() =>
        decodeApp({ id: "tickets", category: invalid, docked: false, open: false }),
      ).toThrow();
    }
  });

  it("keeps guest activation results free of launch data", () => {
    expect(
      Schema.decodeUnknownSync(CtoxManagedGuestResult)({
        _tag: "ready",
        instanceId: validInstance.id,
        launchUrl: "https://ctox.dev/?ctox_config=secret",
        token: "secret",
      }),
    ).toEqual({ _tag: "ready", instanceId: validInstance.id });
  });

  it("accepts only the exact CTOX WebRTC device-control actions", () => {
    const decode = Schema.decodeUnknownSync(WorkjetDeviceWebRtcRequestV1, {
      onExcessProperty: "error",
    });
    expect(
      decode({ action: "invite.create", ttlSeconds: 300, displayName: "Galaxy Fold" }),
    ).toEqual({ action: "invite.create", ttlSeconds: 300, displayName: "Galaxy Fold" });
    expect(decode({ action: "binding.list" })).toEqual({ action: "binding.list" });
    expect(() => decode({ action: "invite.create", ttlSeconds: 59 })).toThrow();
    expect(() => decode({ action: "binding.list", environmentId: "primary" })).toThrow();
    expect(() => decode({ action: "connect", url: "https://relay.t3.codes" })).toThrow();
  });

  it("decodes the transient invite and binding responses without transport fallbacks", () => {
    const decode = Schema.decodeUnknownSync(WorkjetDeviceWebRtcResponseV1, {
      onExcessProperty: "error",
    });
    const invite = {
      type: "ctox-business-os-invite",
      version: 1,
      display_name: "Welsch",
      instance_id: "welsch",
      sync_room: "ctox-business-os:welsch",
      native_peer_id: "native-welsch",
      signaling_urls: ["wss://signal.example.test"],
      signaling_room_password: "transient-secret",
      transport: "webrtc",
      expires_at: "2026-08-27T14:00:00Z",
      data_plane: "rxdb-webrtc",
      http_bridge_available: false,
      session: {
        authenticated: true,
        source: "mobile_invite",
        capability_token: "transient-capability",
        capability_expires_at_ms: 1_788_000_000_000,
        user: {
          id: "device-bootstrap",
          display_name: "Workjet device",
          role: "user",
          is_admin: false,
        },
      },
    } as const;
    expect(
      decode({
        businessOsInstanceId: "welsch",
        deviceId: null,
        proofKeyThumbprint: null,
        grantId: "grant-1",
        inviteId: "invite-1",
        invite,
        expiresAt: invite.expires_at,
      }),
    ).toMatchObject({ inviteId: "invite-1", invite });
    expect(decode({ schema: "ctox.workjet-device-bindings.v1", bindings: [] })).toEqual({
      schema: "ctox.workjet-device-bindings.v1",
      bindings: [],
    });
    expect(decode({ revoked: true })).toEqual({ revoked: true });
    expect(() => decode({ revoked: true, accessToken: "forbidden" })).toThrow();
  });
});
