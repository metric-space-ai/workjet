import type { CtoxBusinessOsInviteV1, WorkjetDeviceInviteRefV1 } from "@t3tools/contracts";
import { QrCode } from "@t3tools/shared/qrCode";
import { describe, expect, it } from "vite-plus/test";

import {
  encodeWorkjetBusinessOsPairingLink,
  encodeWorkjetDevicePairingLink,
  formatMobileInviteExpiry,
} from "./businessOsPairing";

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
  it("encodes only a compact one-time reference in the canonical Workjet link", () => {
    const reference: WorkjetDeviceInviteRefV1 = {
      type: "workjet-device-invite-ref",
      version: 1,
      endpoint: "https://workjet.example.test",
      code: "a".repeat(43),
      expires_at: "2026-08-25T17:05:00Z",
    };
    const link = encodeWorkjetDevicePairingLink(reference);
    expect(link.startsWith("workjet://pair?payload=")).toBe(true);
    expect(decodePayload(link)).toEqual(reference);
    expect(link).not.toContain("business-os/pair");
    expect(link).not.toContain("ctox-mobile");
    expect(link).not.toContain("synthetic-bootstrap");
    expect(new TextEncoder().encode(link).byteLength).toBeLessThanOrEqual(320);
    const qr = QrCode.encodeText(link, QrCode.Ecc.MEDIUM);
    expect((qr.size - 17) / 4).toBeLessThanOrEqual(15);
  });

  it("encodes the backend invite as the compact canonical Workjet link", () => {
    const link = encodeWorkjetBusinessOsPairingLink(invite);
    expect(link.startsWith("workjet://pair?payload=")).toBe(true);
    expect(link.length).toBeLessThan(1_000);
    expect(decodePayload(link)).toEqual([
      "w1",
      invite.display_name,
      invite.instance_id,
      invite.sync_room,
      invite.native_peer_id,
      invite.signaling_urls,
      invite.signaling_room_password,
      invite.expires_at,
      invite.session.capability_token,
      invite.session.capability_expires_at_ms,
      invite.session.user.id,
      invite.session.user.display_name,
      invite.session.user.role,
      invite.session.source,
    ]);
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
