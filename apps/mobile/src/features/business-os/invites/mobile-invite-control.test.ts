import { describe, expect, it } from "vite-plus/test";

import { parseWorkjetBusinessOsPairLink } from "../pairing/invite";
import {
  decodeCreatedBusinessOsMobileInvite,
  unavailableBusinessOsMobileInviteControl,
} from "./mobile-invite-control";

const NOW = Date.parse("2026-08-25T12:00:00Z");
const invite = {
  type: "ctox-business-os-invite",
  version: 1,
  display_name: "Operations",
  instance_id: "instance-a",
  sync_room: "ctox-business-os:instance-a",
  native_peer_id: "native-a",
  signaling_urls: ["wss://signal.example.test/socket"],
  signaling_room_password: "room-secret",
  transport: "webrtc",
  expires_at: "2026-08-25T12:05:00Z",
  data_plane: "rxdb-webrtc",
  http_bridge_available: false,
  session: {
    authenticated: true,
    capability_token: "capability-secret",
    capability_expires_at_ms: Date.parse("2026-08-25T12:05:00Z"),
    user: { id: "user-a", display_name: "Operator", role: "admin" },
  },
};

describe("Business OS mobile invite control", () => {
  it("validates backend output and emits only a canonical Workjet link", () => {
    const created = decodeCreatedBusinessOsMobileInvite(
      { inviteId: "invite-a", invite, expiresAt: "2026-08-25T12:05:00Z" },
      { now: NOW },
    );
    expect(created.link.startsWith("workjet://business-os/pair?payload=")).toBe(true);
    expect(parseWorkjetBusinessOsPairLink(created.link, { now: NOW }).instanceId).toBe(
      "instance-a",
    );
  });

  it("rejects mismatched expiry and keeps production fail-closed", async () => {
    expect(() =>
      decodeCreatedBusinessOsMobileInvite(
        { inviteId: "invite-a", invite, expiresAt: "2026-08-25T12:06:00Z" },
        { now: NOW },
      ),
    ).toThrowError("expiry");
    await expect(
      unavailableBusinessOsMobileInviteControl.create({ backend: {} as never }),
    ).rejects.toMatchObject({ name: "BusinessOsInviteControlUnavailableError" });
  });
});
