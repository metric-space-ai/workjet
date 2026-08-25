import type { CtoxBusinessOsInviteV1 } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { encodeWorkjetBusinessOsPairingLink, formatMobileInviteExpiry } from "./businessOsPairing";

const invite: CtoxBusinessOsInviteV1 = {
  type: "ctox-business-os-invite",
  version: 1,
  display_name: "Operations",
  instance_id: "instance-a",
  sync_room: "ctox-business-os:instance-a",
  native_peer_id: "native-a",
  signaling_urls: ["wss://signal.example.test/socket"],
  signaling_room_password: "synthetic-room-secret",
  transport: "webrtc",
  expires_at: "2026-08-25T17:05:00Z",
  data_plane: "rxdb-webrtc",
  http_bridge_available: false,
  session: {
    authenticated: true,
    source: "mobile_invite",
    capability_token: "synthetic-capability-token",
    capability_expires_at_ms: Date.parse("2026-08-25T17:05:00Z"),
    user: {
      id: "mobile-a",
      display_name: "Mobile pairing",
      role: "user",
      is_admin: false,
    },
  },
};

function decodePayload(link: string): unknown {
  const encoded = new URL(link).searchParams.get("payload");
  if (encoded === null) throw new Error("missing payload");
  const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as unknown;
}

describe("Business OS mobile pairing", () => {
  it("encodes the exact backend invite into the canonical Workjet link", () => {
    const link = encodeWorkjetBusinessOsPairingLink(invite);
    expect(link.startsWith("workjet://business-os/pair?payload=")).toBe(true);
    expect(decodePayload(link)).toEqual(invite);
    expect(link).not.toContain("ctox-desktop://");
  });

  it("rejects payloads too large for a reliable QR code", () => {
    expect(() =>
      encodeWorkjetBusinessOsPairingLink({
        ...invite,
        signaling_room_password: "x".repeat(3_000),
      }),
    ).toThrowError("too large");
  });

  it("formats a valid expiry and fails closed to an unknown label", () => {
    expect(formatMobileInviteExpiry("invalid", "en-US")).toBe("Unknown");
    expect(formatMobileInviteExpiry("2026-08-25T17:05:00Z", "en-US")).toMatch(/:05:00/);
  });
});
