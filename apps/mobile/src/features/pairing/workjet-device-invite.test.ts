import { describe, expect, it } from "vite-plus/test";

import {
  encodeWorkjetDevicePairLink,
  parseWorkjetDevicePairLink,
  WorkjetDeviceInviteValidationError,
} from "./workjet-device-invite";

const NOW = Date.parse("2026-08-25T12:00:00Z");

function businessOsInvite(overrides: Record<string, unknown> = {}) {
  return {
    type: "ctox-business-os-invite",
    version: 1,
    display_name: "Operations",
    instance_id: "instance-a",
    sync_room: "ctox-business-os:instance-a",
    native_peer_id: "native-a",
    signaling_urls: ["wss://signal.example.test/socket"],
    signaling_room_password: "synthetic-room-secret",
    transport: "webrtc",
    expires_at: "2026-08-25T13:00:00Z",
    data_plane: "rxdb-webrtc",
    http_bridge_available: false,
    session: {
      authenticated: true,
      source: "mobile_invite",
      capability_token: "synthetic-capability-token",
      capability_expires_at_ms: Date.parse("2026-08-25T12:30:00Z"),
      user: { id: "user-a", display_name: "Operator", role: "user", is_admin: false },
    },
    ...overrides,
  };
}

function encodePayload(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function link(overrides: Record<string, unknown> = {}): string {
  const payload = {
    type: "workjet-device-invite",
    version: 1,
    device_pairing_id: "device-a",
    environment: {
      base_url: "https://workjet.example.test",
      bootstrap_credential: "synthetic-bootstrap-credential",
      expires_at: "2026-08-25T12:45:00Z",
    },
    business_os: businessOsInvite(),
    ...overrides,
  };
  return `workjet://pair?payload=${encodePayload(payload)}`;
}

describe("Workjet device invite v1", () => {
  it("prepares one Code and Business OS pairing without exposing manual fields", () => {
    const parsed = parseWorkjetDevicePairLink(link(), { now: NOW });
    expect(parsed.devicePairingId).toBe("device-a");
    expect(parsed.environment).toMatchObject({
      baseUrl: "https://workjet.example.test",
      pairingUrl: "https://workjet.example.test/#token=synthetic-bootstrap-credential",
    });
    expect(parsed.businessOs).toMatchObject({
      instanceId: "instance-a",
      syncRoom: "ctox-business-os:instance-a",
    });
    expect(parsed.confirmation).toEqual({
      displayName: "Operations",
      expiresAt: "2026-08-25T12:45:00.000Z",
      signalingHosts: ["signal.example.test"],
    });
  });

  it("encodes only the canonical outgoing Workjet device route", () => {
    const parsed = parseWorkjetDevicePairLink(link(), { now: NOW });
    const rawInvite = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(
            new URL(link()).searchParams.get("payload")!.replace(/-/gu, "+").replace(/_/gu, "/"),
          ),
          (character) => character.charCodeAt(0),
        ),
      ),
    );
    const encoded = encodeWorkjetDevicePairLink(rawInvite);
    expect(encoded).toMatch(/^workjet:\/\/pair\?payload=/u);
    expect(parseWorkjetDevicePairLink(encoded, { now: NOW }).devicePairingId).toBe(
      parsed.devicePairingId,
    );
  });

  it("accepts inbound legacy Workjet product schemes while keeping one route", () => {
    const canonical = link();
    const payload = new URL(canonical).searchParams.get("payload");
    expect(
      parseWorkjetDevicePairLink(`ctox-mobile://pair?payload=${payload}`, { now: NOW })
        .devicePairingId,
    ).toBe("device-a");
  });

  it("fails closed for expired credentials, unsafe environment URLs and extra parameters", () => {
    expect(() =>
      parseWorkjetDevicePairLink(link(), { now: Date.parse("2026-08-25T14:00:00Z") }),
    ).toThrowError(expect.objectContaining({ code: "expired" }));
    expect(() =>
      parseWorkjetDevicePairLink(
        link({
          environment: {
            base_url: "https://user:secret@workjet.example.test",
            bootstrap_credential: "synthetic-bootstrap-credential",
            expires_at: "2026-08-25T12:45:00Z",
          },
        }),
        { now: NOW },
      ),
    ).toThrowError(expect.objectContaining({ code: "environment_url" }));
    expect(() => parseWorkjetDevicePairLink(`${link()}&debug=true`, { now: NOW })).toThrowError(
      expect.objectContaining({ code: "query" }),
    );
  });

  it("never echoes either embedded secret in validation errors", () => {
    try {
      parseWorkjetDevicePairLink(link({ version: 2 }), { now: NOW });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkjetDeviceInviteValidationError);
      expect(String(error)).not.toContain("synthetic-bootstrap-credential");
      expect(String(error)).not.toContain("synthetic-room-secret");
      expect(String(error)).not.toContain("synthetic-capability-token");
    }
  });
});
