import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, WorkjetDeviceInviteRefV1 } from "@t3tools/contracts";

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

    const created = await control.create({
      connection: connection(),
      businessOsInstanceId: "instance-a",
      displayName: "Operations",
      ttlSeconds: 300,
    });
    expect(createInputs).toEqual([
      {
        ttlSeconds: 300,
        connectionUrl: "https://workjet.example.test",
        businessOsInstanceId: "instance-a",
      },
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
      control.create({
        connection: connection("http://127.0.0.1:13773"),
        businessOsInstanceId: "instance-a",
        displayName: "Operations",
        ttlSeconds: 300,
      }),
    ).rejects.toBeInstanceOf(WorkjetDeviceInviteControlUnavailableError);
  });
});
