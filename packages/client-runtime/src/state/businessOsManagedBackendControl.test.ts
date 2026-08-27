import type {
  BusinessOsInstanceId,
  EnvironmentId,
  WorkjetDeviceInviteV2,
  WorkjetDeviceSessionAccessToken,
  WorkjetDeviceSessionBootstrapCredential,
  WorkjetDeviceSessionRefreshGrant,
  WorkjetInstallationId,
  WorkjetManagedBackendControlConnectionId,
  WorkjetManagedIssuerOrigin,
  WorkjetRelayControlIdentityAssertion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  WorkjetManagedBackendControlClient,
  WorkjetManagedDeviceSessionClient,
  WorkjetManagedDeviceSessionClientError,
  WorkjetManagedDeviceSessionAuthorizationProvider,
  createManagedWorkjetDeviceInvite,
  exchangeManagedWorkjetDeviceSessionBootstrap,
  issueManagedRelayControlIdentityAssertion,
  listManagedWorkjetDeviceBindings,
  readManagedBusinessOsDeviceSessionMembership,
  readManagedWorkjetDeviceSessionAuthorization,
  redeemManagedWorkjetDeviceInviteReference,
  renewManagedWorkjetDeviceSession,
  resolveManagedBusinessOsBackendControl,
  revokeManagedWorkjetDeviceInvite,
  revokeManagedWorkjetDeviceBinding,
  toManagedWorkjetDeviceSessionAuthorization,
  toManagedRelayDeviceSessionAuthorization,
} from "./businessOsManagedBackendControl.ts";

const businessOsInstanceId = "biz_welsch" as BusinessOsInstanceId;
const backendControlConnectionId = "a".repeat(43) as WorkjetManagedBackendControlConnectionId;
const relayIdentityAssertion =
  `${"a".repeat(43)}.${"b".repeat(43)}.${"c".repeat(43)}` as WorkjetRelayControlIdentityAssertion;

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
    const revokeDeviceBinding = vi.fn(() => Effect.succeed({ revoked: true as const }));
    const client = WorkjetManagedBackendControlClient.of({
      resolve,
      listDeviceBindings,
      createDeviceInvite,
      revokeDeviceInvite,
      revokeDeviceBinding,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* resolveManagedBusinessOsBackendControl({
          businessOsInstanceId,
          workjetInstallationId: "desktop-michael" as WorkjetInstallationId,
          relayIdentityAssertion,
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
        yield* revokeManagedWorkjetDeviceBinding({
          backendControlConnectionId,
          businessOsInstanceId,
          devicePairingId: "pairing-1",
        });

        expect(resolve).toHaveBeenCalledWith({
          businessOsInstanceId,
          workjetInstallationId: "desktop-michael",
          relayIdentityAssertion,
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
        expect(revokeDeviceBinding).toHaveBeenCalledWith({
          backendControlConnectionId,
          businessOsInstanceId,
          devicePairingId: "pairing-1",
        });
      }).pipe(Effect.provideService(WorkjetManagedBackendControlClient, client)),
    );
  });

  it("targets the exact DPoP-bound redeem, exchange, and membership endpoints", async () => {
    const issueControlIdentityAssertion = vi.fn(() =>
      Effect.succeed({
        assertion: relayIdentityAssertion,
        expiresAt: "2026-08-27T04:00:00Z",
      }),
    );
    const redeemResult = {
      type: "workjet-device-invite",
      version: 2,
    } as unknown as WorkjetDeviceInviteV2;
    const redeemDeviceInvite = vi.fn(() => Effect.succeed(redeemResult));
    const exchangeDeviceSessionBootstrap = vi.fn(() =>
      Effect.succeed({
        tokenType: "DPoP" as const,
        accessToken: "s".repeat(43) as WorkjetDeviceSessionAccessToken,
        relayIssuer: "https://relay.ctox.dev" as WorkjetManagedIssuerOrigin,
        relayScopes: ["environment:connect" as const, "environment:status" as const],
        refreshGrant: "g".repeat(43) as WorkjetDeviceSessionRefreshGrant,
        businessOsInstanceId,
        deviceId: "galaxy-fold-8",
        expiresAt: "2026-08-27T04:00:00Z",
        refreshExpiresAt: "2026-09-27T04:00:00Z",
      }),
    );
    const renewDeviceSession = vi.fn(() =>
      Effect.succeed({
        tokenType: "DPoP" as const,
        accessToken: "t".repeat(43) as WorkjetDeviceSessionAccessToken,
        relayIssuer: "https://relay.ctox.dev" as WorkjetManagedIssuerOrigin,
        relayScopes: ["environment:connect" as const, "environment:status" as const],
        refreshGrant: "h".repeat(43) as WorkjetDeviceSessionRefreshGrant,
        businessOsInstanceId,
        deviceId: "galaxy-fold-8",
        expiresAt: "2026-08-27T05:00:00Z",
        refreshExpiresAt: "2026-09-27T05:00:00Z",
      }),
    );
    const readDeviceSessionMembership = vi.fn(() =>
      Effect.succeed({
        businessOsInstanceId,
        membershipVersion: 7,
        environmentIds: ["environment-gpu3" as EnvironmentId],
      }),
    );
    const client = WorkjetManagedDeviceSessionClient.of({
      issueControlIdentityAssertion,
      redeemDeviceInvite,
      exchangeDeviceSessionBootstrap,
      renewDeviceSession,
      readDeviceSessionMembership,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* issueManagedRelayControlIdentityAssertion({
          relayIssuer: "https://relay.ctox.dev" as WorkjetManagedIssuerOrigin,
          payload: {
            audience: "ctox.dev",
            workjetInstallationId: "desktop-michael" as WorkjetInstallationId,
            businessOsInstanceId,
          },
        });
        const redeemed = yield* redeemManagedWorkjetDeviceInviteReference({
          reference: {
            type: "workjet-device-invite-ref",
            version: 1,
            endpoint: "https://managed.ctox.dev",
            code: "r".repeat(43),
            expires_at: "2026-08-27T04:00:00Z",
          },
          deviceId: "galaxy-fold-8",
          proofKeyThumbprint: "p".repeat(43),
        });
        expect(redeemed).toBe(redeemResult);

        const exchanged = yield* exchangeManagedWorkjetDeviceSessionBootstrap({
          issuer: "https://managed.ctox.dev" as WorkjetManagedIssuerOrigin,
          bootstrapCredential: "b".repeat(43) as WorkjetDeviceSessionBootstrapCredential,
          deviceId: "galaxy-fold-8",
          businessOsInstanceId,
        });

        const authorization = toManagedWorkjetDeviceSessionAuthorization(
          "https://managed.ctox.dev" as WorkjetManagedIssuerOrigin,
          exchanged,
        );
        yield* readManagedBusinessOsDeviceSessionMembership({ authorization });
        const renewed = yield* renewManagedWorkjetDeviceSession({ authorization });
        expect(renewed.accessToken).toBe("t".repeat(43));

        expect(redeemDeviceInvite).toHaveBeenCalledWith({
          target: {
            method: "POST",
            url: "https://managed.ctox.dev/api/workjet/device-invites/redeem",
          },
          payload: {
            code: "r".repeat(43),
            deviceId: "galaxy-fold-8",
            proofKeyThumbprint: "p".repeat(43),
          },
        });
        expect(issueControlIdentityAssertion).toHaveBeenCalledWith({
          target: {
            method: "POST",
            url: "https://relay.ctox.dev/api/workjet/device-session/control-assertion",
          },
          payload: {
            audience: "ctox.dev",
            workjetInstallationId: "desktop-michael",
            businessOsInstanceId,
          },
        });
        expect(exchangeDeviceSessionBootstrap).toHaveBeenCalledWith({
          target: {
            method: "POST",
            url: "https://managed.ctox.dev/api/workjet/device-session/exchange",
          },
          payload: {
            bootstrapCredential: "b".repeat(43),
            deviceId: "galaxy-fold-8",
            businessOsInstanceId,
          },
        });
        expect(readDeviceSessionMembership).toHaveBeenCalledWith({
          target: {
            method: "POST",
            url: "https://managed.ctox.dev/api/workjet/device-session/business-os/computers",
          },
          accessToken: "s".repeat(43),
          payload: { businessOsInstanceId },
        });
        expect(renewDeviceSession).toHaveBeenCalledWith({
          target: {
            method: "POST",
            url: "https://managed.ctox.dev/api/workjet/device-session/renew",
          },
          payload: {
            refreshGrant: "g".repeat(43),
            deviceId: "galaxy-fold-8",
            businessOsInstanceId,
          },
        });
      }).pipe(Effect.provideService(WorkjetManagedDeviceSessionClient, client)),
    );
  });

  it("provides an instance-scoped DPoP session without an account or environment fallback", async () => {
    const authorization = {
      sessionIssuer: "https://managed.ctox.dev" as WorkjetManagedIssuerOrigin,
      relayIssuer: "https://relay.ctox.dev" as WorkjetManagedIssuerOrigin,
      relayScopes: ["environment:connect" as const, "environment:status" as const],
      tokenType: "DPoP" as const,
      accessToken: "s".repeat(43) as WorkjetDeviceSessionAccessToken,
      refreshGrant: "g".repeat(43) as WorkjetDeviceSessionRefreshGrant,
      expiresAt: "2026-08-27T04:00:00Z",
      refreshExpiresAt: "2026-09-27T04:00:00Z",
      businessOsInstanceId,
      deviceId: "galaxy-fold-8",
    };
    const read = vi.fn(() => Effect.succeed(authorization));
    const provider = WorkjetManagedDeviceSessionAuthorizationProvider.of({ read });

    const result = await Effect.runPromise(
      readManagedWorkjetDeviceSessionAuthorization({ businessOsInstanceId }).pipe(
        Effect.provideService(WorkjetManagedDeviceSessionAuthorizationProvider, provider),
      ),
    );

    expect(result).toEqual(authorization);
    expect(read).toHaveBeenCalledExactlyOnceWith({ businessOsInstanceId });
    expect(result).not.toHaveProperty("clerkToken");
    expect(result).not.toHaveProperty("environmentId");
    expect(result).not.toHaveProperty("environmentCredentials");
    expect(toManagedRelayDeviceSessionAuthorization(result)).toEqual({
      issuer: "https://relay.ctox.dev",
      tokenType: "DPoP",
      accessToken: "s".repeat(43),
      scopes: ["environment:connect", "environment:status"],
      expiresAt: "2026-08-27T04:00:00Z",
      businessOsInstanceId,
      deviceId: "galaxy-fold-8",
    });
  });

  it("fails closed on unsafe origins without exposing bootstrap or session secrets", async () => {
    const unused = vi.fn(() =>
      Effect.fail(
        new WorkjetManagedDeviceSessionClientError({
          operation: "exchange",
          code: "request_failed",
        }),
      ),
    );
    const client = WorkjetManagedDeviceSessionClient.of({
      issueControlIdentityAssertion: unused,
      redeemDeviceInvite: unused,
      exchangeDeviceSessionBootstrap: unused,
      renewDeviceSession: unused,
      readDeviceSessionMembership: unused,
    });
    const bootstrapCredential = "x".repeat(43) as WorkjetDeviceSessionBootstrapCredential;

    const result = await Effect.runPromise(
      Effect.flip(
        exchangeManagedWorkjetDeviceSessionBootstrap({
          issuer: "https://user:pass@managed.ctox.dev" as WorkjetManagedIssuerOrigin,
          bootstrapCredential,
          deviceId: "galaxy-fold-8",
          businessOsInstanceId,
        }),
      ).pipe(Effect.provideService(WorkjetManagedDeviceSessionClient, client)),
    );

    const refreshGrant = "y".repeat(43) as WorkjetDeviceSessionRefreshGrant;
    const renewResult = await Effect.runPromise(
      Effect.flip(
        renewManagedWorkjetDeviceSession({
          authorization: {
            sessionIssuer: "https://managed.ctox.dev/path" as WorkjetManagedIssuerOrigin,
            relayIssuer: "https://relay.ctox.dev" as WorkjetManagedIssuerOrigin,
            relayScopes: ["environment:connect", "environment:status"],
            tokenType: "DPoP",
            accessToken: "s".repeat(43) as WorkjetDeviceSessionAccessToken,
            refreshGrant,
            expiresAt: "2026-08-27T04:00:00Z",
            refreshExpiresAt: "2026-09-27T04:00:00Z",
            businessOsInstanceId,
            deviceId: "galaxy-fold-8",
          },
        }),
      ).pipe(Effect.provideService(WorkjetManagedDeviceSessionClient, client)),
    );

    expect(JSON.stringify(result)).not.toContain(bootstrapCredential);
    expect(JSON.stringify(renewResult)).not.toContain(refreshGrant);
    expect(unused).not.toHaveBeenCalled();
  });
});
