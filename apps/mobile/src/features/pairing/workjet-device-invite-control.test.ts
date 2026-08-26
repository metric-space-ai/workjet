import { describe, expect, it } from "vite-plus/test";
import type {
  EnvironmentId,
  WorkjetDeviceInviteRefV1,
  WorkjetDeviceInviteV1,
} from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import {
  makeWorkjetDeviceInviteControl,
  resolveWorkjetDevicePairingConnection,
  WorkjetDeviceInviteControlUnavailableError,
} from "./workjet-device-invite-control";

const NOW = Date.parse("2026-08-25T12:00:00Z");

function connection(httpBaseUrl = "https://workjet.example.test"): SavedRemoteConnection {
  return {
    environmentId: "environment-a" as EnvironmentId,
    environmentLabel: "Operations",
    pairingUrl: httpBaseUrl,
    displayUrl: httpBaseUrl,
    httpBaseUrl,
    wsBaseUrl: "wss://workjet.example.test",
    bearerToken: null,
  };
}

const invite: WorkjetDeviceInviteV1 = {
  type: "workjet-device-invite" as const,
  version: 1 as const,
  device_pairing_id: "device-a",
  environment: {
    base_url: "https://workjet.example.test",
    bootstrap_credential: "synthetic-bootstrap-credential",
    expires_at: "2026-08-25T12:45:00Z",
  },
  business_os: {
    type: "ctox-business-os-invite" as const,
    version: 1 as const,
    display_name: "Operations",
    instance_id: "instance-a",
    sync_room: "ctox-business-os:instance-a",
    native_peer_id: "native-a",
    signaling_urls: ["wss://signal.example.test/socket"],
    signaling_room_password: "synthetic-room-secret",
    transport: "webrtc" as const,
    expires_at: "2026-08-25T12:45:00Z",
    data_plane: "rxdb-webrtc" as const,
    http_bridge_available: false as const,
    session: {
      authenticated: true as const,
      source: "mobile_invite" as const,
      capability_token: "synthetic-capability-token",
      capability_expires_at_ms: Date.parse("2026-08-25T12:45:00Z"),
      user: {
        id: "user-a",
        display_name: "Operator",
        role: "user" as const,
        is_admin: false as const,
      },
    },
  },
};

const reference: WorkjetDeviceInviteRefV1 = {
  type: "workjet-device-invite-ref",
  version: 1,
  endpoint: "https://workjet.example.test",
  code: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  expires_at: "2026-08-25T12:45:00Z",
};

describe("Workjet device invite control", () => {
  it("resolves the exact Code environment bound to the selected CTOX instance", () => {
    const selected = connection();
    const other = {
      ...connection("https://other.example.test"),
      environmentId: "environment-b" as EnvironmentId,
      environmentLabel: "Operations",
    };
    expect(resolveWorkjetDevicePairingConnection(selected.environmentId, [other, selected])).toBe(
      selected,
    );
    expect(resolveWorkjetDevicePairingConnection(null, [selected])).toBeNull();
    expect(
      resolveWorkjetDevicePairingConnection("missing" as EnvironmentId, [selected]),
    ).toBeNull();
  });

  it("creates and revokes one combined Code and Business OS invite", async () => {
    const createInputs: unknown[] = [];
    const revokeInputs: unknown[] = [];
    const control = makeWorkjetDeviceInviteControl(
      {
        async create(input) {
          createInputs.push(input);
          return {
            inviteId: "invite-a",
            reference,
            invite,
            expiresAt: "2026-08-25T12:45:00Z",
          };
        },
        async revoke(input) {
          revokeInputs.push(input);
          return { revoked: true };
        },
      },
      { now: () => NOW },
    );

    const created = await control.create({ connection: connection(), ttlSeconds: 300 });
    expect(createInputs).toEqual([
      { ttlSeconds: 300, connectionUrl: "https://workjet.example.test" },
    ]);
    expect(created.link).toMatch(/^workjet:\/\/pair\?payload=/u);
    expect(created.link).not.toContain("synthetic-bootstrap-credential");
    expect(created.link.length).toBeLessThanOrEqual(320);
    expect(created.displayName).toBe("Operations");
    await control.revoke({ connection: connection(), inviteId: created.inviteId });
    expect(revokeInputs).toEqual([{ inviteId: "invite-a" }]);
  });

  it("refuses to generate a QR code with a loopback connection URL", async () => {
    const control = makeWorkjetDeviceInviteControl({
      async create() {
        throw new Error("must not be called");
      },
      async revoke() {
        return { revoked: true };
      },
    });
    await expect(
      control.create({ connection: connection("http://127.0.0.1:13773"), ttlSeconds: 300 }),
    ).rejects.toBeInstanceOf(WorkjetDeviceInviteControlUnavailableError);
  });
});
