import { describe, expect, it } from "vite-plus/test";

import {
  businessOsInviteConfirmationMetadata,
  BusinessOsInviteValidationError,
  encodeWorkjetBusinessOsPairLink,
  parseWorkjetBusinessOsPairLink,
  validateBusinessOsInviteV1,
} from "./invite";

const NOW = Date.parse("2026-08-25T12:00:00Z");

function invite(overrides: Record<string, unknown> = {}) {
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
      source: "desktop_invite",
      capability_token: "synthetic-capability-token",
      capability_expires_at_ms: Date.parse("2026-08-25T12:30:00Z"),
      user: { id: "user-a", display_name: "Operator", role: "admin" },
    },
    ...overrides,
  };
}

describe("Business OS invite v1", () => {
  it("round-trips through the canonical Workjet link", () => {
    const link = encodeWorkjetBusinessOsPairLink(invite(), { now: NOW });
    expect(link.startsWith("workjet://business-os/pair?payload=")).toBe(true);
    const parsed = parseWorkjetBusinessOsPairLink(link, { now: NOW });
    expect(parsed).toMatchObject({
      displayName: "Operations",
      instanceId: "instance-a",
      signalingUrls: ["wss://signal.example.test/socket"],
    });
    expect(parsed.password).toBe("synthetic-room-secret");
    expect(parsed.session.capabilityToken).toBe("synthetic-capability-token");
  });

  it("accepts the standalone donor scheme as an inbound migration alias", () => {
    const canonical = encodeWorkjetBusinessOsPairLink(invite(), { now: NOW });
    const payload = new URL(canonical).searchParams.get("payload");
    const legacy = `ctox-business-os-mobile://pair?payload=${payload}`;
    expect(parseWorkjetBusinessOsPairLink(legacy, { now: NOW }).instanceId).toBe("instance-a");
  });

  it("fails closed for expired invites, capability TTL and non-wss signaling", () => {
    expect(() =>
      validateBusinessOsInviteV1(invite(), { now: Date.parse("2026-08-25T14:00:00Z") }),
    ).toThrowError(expect.objectContaining({ code: "expired" }));
    expect(() =>
      validateBusinessOsInviteV1(
        invite({
          session: {
            ...invite().session,
            capability_expires_at_ms: Date.parse("2026-08-25T14:00:00Z"),
          },
        }),
        { now: NOW },
      ),
    ).toThrowError(expect.objectContaining({ code: "capability_expiry" }));
    expect(() =>
      validateBusinessOsInviteV1(invite({ signaling_urls: ["ws://signal.example.test"] }), {
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "signaling_url" }));
  });

  it("rejects wrong schemas and extra link parameters without echoing secrets", () => {
    expect(() => validateBusinessOsInviteV1(invite({ type: "wrong" }), { now: NOW })).toThrowError(
      expect.objectContaining({ code: "type" }),
    );
    const link = `${encodeWorkjetBusinessOsPairLink(invite(), { now: NOW })}&debug=true`;
    try {
      parseWorkjetBusinessOsPairLink(link, { now: NOW });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessOsInviteValidationError);
      expect(String(error)).not.toContain("synthetic-room-secret");
      expect(String(error)).not.toContain("synthetic-capability-token");
    }
  });

  it("returns confirmation metadata without credentials", () => {
    expect(businessOsInviteConfirmationMetadata(invite(), { now: NOW })).toEqual({
      displayName: "Operations",
      expiresAt: "2026-08-25T13:00:00.000Z",
      signalingHosts: ["signal.example.test"],
    });
  });
});
