import type {
  BusinessOsInstanceId,
  WorkjetInstallationId,
  WorkjetManagedBackendControlConnectionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  WorkjetManagedBackendControlClient,
  createManagedWorkjetDeviceInvite,
  listManagedWorkjetDeviceBindings,
  resolveManagedBusinessOsBackendControl,
  revokeManagedWorkjetDeviceInvite,
} from "./businessOsManagedBackendControl.ts";

const businessOsInstanceId = "biz_welsch" as BusinessOsInstanceId;
const backendControlConnectionId = "a".repeat(43) as WorkjetManagedBackendControlConnectionId;

describe("managed Business OS backend control client runtime", () => {
  it("delegates only instance-scoped operations to the platform control port", async () => {
    const resolve = vi.fn(() =>
      Effect.succeed({
        backendControlConnectionId,
        businessOsInstanceId,
        expiresAt: "2026-08-27T04:00:00Z",
      }),
    );
    const listDeviceBindings = vi.fn(() =>
      Effect.succeed({
        devices: [],
      }),
    );
    const createDeviceInvite = vi.fn(() =>
      Effect.succeed({
        inviteId: "invite-1",
        reference: {
          type: "workjet-device-invite-ref" as const,
          version: 1 as const,
          endpoint: "https://ctox.dev",
          code: "b".repeat(43),
          expires_at: "2026-08-27T04:00:00Z",
        },
        expiresAt: "2026-08-27T04:00:00Z",
      }),
    );
    const revokeDeviceInvite = vi.fn(() => Effect.succeed({ revoked: true as const }));
    const client = WorkjetManagedBackendControlClient.of({
      resolve,
      listDeviceBindings,
      createDeviceInvite,
      revokeDeviceInvite,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* resolveManagedBusinessOsBackendControl({
          businessOsInstanceId,
          workjetInstallationId: "desktop-michael" as WorkjetInstallationId,
        });
        yield* listManagedWorkjetDeviceBindings({
          backendControlConnectionId,
          businessOsInstanceId,
        });
        yield* createManagedWorkjetDeviceInvite({
          backendControlConnectionId,
          businessOsInstanceId,
          ttlSeconds: 300,
        });
        yield* revokeManagedWorkjetDeviceInvite({
          backendControlConnectionId,
          businessOsInstanceId,
          inviteId: "invite-1",
        });

        expect(resolve).toHaveBeenCalledWith({
          businessOsInstanceId,
          workjetInstallationId: "desktop-michael",
        });
        expect(listDeviceBindings).toHaveBeenCalledWith({
          backendControlConnectionId,
          businessOsInstanceId,
        });
        expect(createDeviceInvite).toHaveBeenCalledWith({
          backendControlConnectionId,
          businessOsInstanceId,
          ttlSeconds: 300,
        });
        expect(revokeDeviceInvite).toHaveBeenCalledWith({
          backendControlConnectionId,
          businessOsInstanceId,
          inviteId: "invite-1",
        });
      }).pipe(Effect.provideService(WorkjetManagedBackendControlClient, client)),
    );
  });
});
