import { describe, expect, it, vi } from "vite-plus/test";
import type {
  BusinessOsInstanceId,
  WorkjetDeviceInviteRefV1,
  WorkjetManagedBackendControlConnectionId,
} from "@t3tools/contracts";

import {
  makeManagedWorkjetDeviceInviteControl,
  type WorkjetManagedBackendControlTransportPort,
} from "./workjet-managed-device-invite-control";

const NOW = Date.parse("2026-08-25T12:00:00Z");
const INSTANCE_ID = "instance-a" as BusinessOsInstanceId;
const CONTROL_ID = "a".repeat(43) as WorkjetManagedBackendControlConnectionId;
const reference: WorkjetDeviceInviteRefV1 = {
  type: "workjet-device-invite-ref",
  version: 1,
  endpoint: "https://ctox.dev",
  code: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  expires_at: "2026-08-25T12:05:00Z",
};

function transport() {
  const resolve = vi.fn(async () => ({
    backendControlConnectionId: CONTROL_ID,
    businessOsInstanceId: INSTANCE_ID,
    expiresAt: "2026-08-25T12:05:00Z",
  }));
  const createDeviceInvite = vi.fn(async () => ({
    inviteId: "invite-a",
    reference,
    expiresAt: reference.expires_at,
  }));
  const revokeDeviceInvite = vi.fn(async () => ({ revoked: true as const }));
  return {
    port: {
      resolve,
      createDeviceInvite,
      revokeDeviceInvite,
    } satisfies WorkjetManagedBackendControlTransportPort,
    resolve,
    createDeviceInvite,
    revokeDeviceInvite,
  };
}

describe("managed Workjet device invite control", () => {
  it("creates and revokes against the exact Business OS without an Environment fallback", async () => {
    const client = transport();
    const control = makeManagedWorkjetDeviceInviteControl(client.port, {
      loadInstallationId: async () => "mobile-device-1",
      now: () => NOW,
    });

    const created = await control.create({
      businessOsInstanceId: INSTANCE_ID,
      displayName: "WELSCH",
      ttlSeconds: 300,
    });
    expect(client.resolve).toHaveBeenNthCalledWith(1, {
      businessOsInstanceId: INSTANCE_ID,
      workjetInstallationId: "mobile-device-1",
    });
    expect(client.createDeviceInvite).toHaveBeenCalledWith({
      backendControlConnectionId: CONTROL_ID,
      businessOsInstanceId: INSTANCE_ID,
      ttlSeconds: 300,
    });
    expect(JSON.stringify(client.createDeviceInvite.mock.calls)).not.toMatch(
      /environment|connectionUrl|password|secret/iu,
    );
    expect(created.link).toMatch(/^workjet:\/\/pair\?payload=/u);
    expect(created.displayName).toBe("WELSCH");

    await control.revoke({ inviteId: created.inviteId });
    expect(client.resolve).toHaveBeenNthCalledWith(2, {
      businessOsInstanceId: INSTANCE_ID,
      workjetInstallationId: "mobile-device-1",
    });
    expect(client.revokeDeviceInvite).toHaveBeenCalledWith({
      backendControlConnectionId: CONTROL_ID,
      businessOsInstanceId: INSTANCE_ID,
      inviteId: "invite-a",
    });
  });

  it("rejects mismatched, expired or overlong control handles", async () => {
    const cases = [
      { businessOsInstanceId: "instance-b", expiresAt: "2026-08-25T12:05:00Z" },
      { businessOsInstanceId: INSTANCE_ID, expiresAt: "2026-08-25T11:59:59Z" },
      { businessOsInstanceId: INSTANCE_ID, expiresAt: "2026-08-25T12:10:01Z" },
    ] as const;
    for (const controlResult of cases) {
      const client = transport();
      client.resolve.mockResolvedValueOnce({
        backendControlConnectionId: CONTROL_ID,
        ...controlResult,
      } as never);
      const control = makeManagedWorkjetDeviceInviteControl(client.port, {
        loadInstallationId: async () => "mobile-device-1",
        now: () => NOW,
      });
      await expect(
        control.create({
          businessOsInstanceId: INSTANCE_ID,
          displayName: "WELSCH",
          ttlSeconds: 300,
        }),
      ).rejects.toMatchObject({ name: "WorkjetDeviceInviteControlUnavailableError" });
      expect(client.createDeviceInvite).not.toHaveBeenCalled();
    }
  });

  it("never revokes an invite outside this in-memory instance scope", async () => {
    const client = transport();
    const control = makeManagedWorkjetDeviceInviteControl(client.port, {
      loadInstallationId: async () => "mobile-device-1",
      now: () => NOW,
    });
    await expect(control.revoke({ inviteId: "unknown" })).rejects.toMatchObject({
      name: "WorkjetDeviceInviteControlUnavailableError",
    });
    expect(client.resolve).not.toHaveBeenCalled();
    expect(client.revokeDeviceInvite).not.toHaveBeenCalled();
  });
});
