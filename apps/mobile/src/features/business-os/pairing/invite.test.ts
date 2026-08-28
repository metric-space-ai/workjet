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
    signaling_auth_version: "ctox-role-bound-v1",
    signaling_browser_token: "synthetic-browser-token",
    signaling_browser_token_hash:
      "1ef21ba2169d3a33ac0af0ff96d6698758b46ed2cb13409b9d50a5eafdd427fa",
    signaling_native_token_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    expect(link.startsWith("workjet://pair?payload=")).toBe(true);
    expect(link.length).toBeLessThan(1_000);
    const parsed = parseWorkjetBusinessOsPairLink(link, { now: NOW });
    expect(parsed).toMatchObject({
      displayName: "Operations",
      instanceId: "instance-a",
      signalingUrls: ["wss://signal.example.test/socket"],
    });
    expect(parsed.browserToken).toBe("synthetic-browser-token");
    expect(parsed.session.capabilityToken).toBe("synthetic-capability-token");
  });

  it("accepts the standalone donor scheme as an inbound migration alias", () => {
    const canonical = encodeWorkjetBusinessOsPairLink(invite(), { now: NOW });
    const payload = new URL(canonical).searchParams.get("payload");
    const legacy = `ctox-business-os-mobile://pair?payload=${payload}`;
    expect(parseWorkjetBusinessOsPairLink(legacy, { now: NOW }).instanceId).toBe("instance-a");
  });

  it("accepts the former Workjet Business OS route only as an inbound alias", () => {
    const canonical = encodeWorkjetBusinessOsPairLink(invite(), { now: NOW });
    const payload = new URL(canonical).searchParams.get("payload");
    const legacy = `workjet://business-os/pair?payload=${payload}`;
    expect(parseWorkjetBusinessOsPairLink(legacy, { now: NOW }).instanceId).toBe("instance-a");
    expect(encodeWorkjetBusinessOsPairLink(invite(), { now: NOW })).toMatch(
      /^workjet:\/\/pair\?payload=/u,
    );
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
      validateBusinessOsInviteV1(
        invite({
          session: {
            ...invite().session,
            capability_expires_at_ms: Date.parse("2026-08-25T11:59:00Z"),
          },
        }),
        { now: NOW },
      ),
    ).toThrowError(expect.objectContaining({ code: "capability_expired" }));
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

  it("bounds identifiers, credentials and signaling fan-out", () => {
    expect(() =>
      validateBusinessOsInviteV1(invite({ instance_id: `a${"b".repeat(256)}` }), { now: NOW }),
    ).toThrowError(expect.objectContaining({ code: "instance_id" }));
    expect(() =>
      validateBusinessOsInviteV1(invite({ native_peer_id: "native\npeer" }), { now: NOW }),
    ).toThrowError(expect.objectContaining({ code: "native_peer_id" }));
    expect(() =>
      validateBusinessOsInviteV1(
        invite({ signaling_urls: new Array(17).fill("wss://signal.example.test") }),
        { now: NOW },
      ),
    ).toThrowError(expect.objectContaining({ code: "signaling_urls" }));
    expect(() =>
      validateBusinessOsInviteV1(invite({ signaling_browser_token: "x".repeat(4_097) }), {
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "browser_token" }));
  });

  it("returns confirmation metadata without credentials", () => {
    expect(businessOsInviteConfirmationMetadata(invite(), { now: NOW })).toEqual({
      displayName: "Operations",
      expiresAt: "2026-08-25T13:00:00.000Z",
      signalingHosts: ["signal.example.test"],
    });
  });
});
