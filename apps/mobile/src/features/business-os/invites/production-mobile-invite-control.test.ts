import { describe, expect, it, vi } from "vite-plus/test";

import type { SavedRemoteConnection } from "../../../lib/connection";
import type { BusinessOsInstance } from "../registry/business-os-registry";
import {
  makeBusinessOsMobileInviteControl,
  resolveBusinessOsControlConnection,
} from "./production-mobile-invite-control-core";

const NOW = Date.parse("2026-08-25T12:00:00Z");
const connection = (label: string): SavedRemoteConnection => ({
  environmentId: `env-${label}` as never,
  environmentLabel: label,
  pairingUrl: "https://backend.example.test",
  displayUrl: "https://backend.example.test",
  httpBaseUrl: "https://backend.example.test",
  wsBaseUrl: "wss://backend.example.test",
  bearerToken: "synthetic-access-token",
  authenticationMethod: "bearer",
});
const backend = { displayName: "Operations" } as BusinessOsInstance;
const invite = {
  type: "ctox-business-os-invite" as const,
  version: 1 as const,
  display_name: "Operations",
  instance_id: "instance-a",
  sync_room: "ctox-business-os:instance-a",
  native_peer_id: "native-a",
  signaling_urls: ["wss://signal.example.test/socket"],
  signaling_room_password: "room-secret",
  transport: "webrtc" as const,
  expires_at: "2026-08-25T12:05:00Z",
  data_plane: "rxdb-webrtc" as const,
  http_bridge_available: false as const,
  secret_value_in_payload: true as const,
  session: {
    authenticated: true as const,
    source: "mobile_invite" as const,
    capability_token: "capability-secret",
    capability_expires_at_ms: Date.parse("2026-08-25T12:05:00Z"),
    user: {
      id: "user-a",
      display_name: "Operator",
      role: "user" as const,
      is_admin: false as const,
    },
  },
};

describe("production Business OS invite control", () => {
  it("calls the typed create/revoke contract without retaining the credential", async () => {
    const create = vi.fn(async () => ({
      inviteId: "invite-a",
      invite,
      expiresAt: invite.expires_at,
    }));
    const revoke = vi.fn(async () => ({ revoked: true as const }));
    const control = makeBusinessOsMobileInviteControl(
      { create, revoke },
      {
        now: () => NOW,
      },
    );
    const created = await control.create({ backend, ttlSeconds: 300 });
    expect(create).toHaveBeenCalledWith({ ttlSeconds: 300 });
    expect(created.link.startsWith("workjet://business-os/pair?payload=")).toBe(true);
    await control.revoke({ backend, inviteId: created.inviteId });
    expect(revoke).toHaveBeenCalledWith({ inviteId: "invite-a" });
  });

  it("matches an unambiguous authenticated environment and otherwise fails closed", () => {
    expect(
      resolveBusinessOsControlConnection(backend, [connection("Operations"), connection("Other")])
        ?.environmentLabel,
    ).toBe("Operations");
    expect(
      resolveBusinessOsControlConnection(backend, [connection("Only")])?.environmentLabel,
    ).toBe("Only");
    expect(
      resolveBusinessOsControlConnection(backend, [connection("One"), connection("Two")]),
    ).toBeNull();
  });
});
