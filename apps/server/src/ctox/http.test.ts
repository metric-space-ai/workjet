import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
  type CtoxMobileInviteCreateResult,
  type CtoxMobileShellPackResolveResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpApiTest } from "effect/unstable/httpapi";
import { describe, expect, it } from "vite-plus/test";

import { CtoxMobileInviteService } from "./CtoxMobileInviteService.ts";
import { CtoxMobileShellPackService } from "./CtoxMobileShellPackService.ts";
import * as WorkjetDeviceInviteReferences from "./WorkjetDeviceInviteReferenceService.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import {
  businessOsHttpApiLayer,
  MOBILE_INVITE_RESPONSE_HEADERS,
  normalizeDeviceConnectionUrl,
} from "./http.ts";

const expiresAt = "2099-08-25T12:05:00.000Z";
const created: CtoxMobileInviteCreateResult = {
  inviteId: "opaque-id",
  expiresAt,
  invite: {
    type: "ctox-business-os-invite",
    version: 1,
    display_name: "Operations",
    instance_id: "instance-a",
    sync_room: "ctox-business-os:instance-a",
    native_peer_id: "native-a",
    signaling_urls: ["wss://signaling.ctox.dev/v2"],
    signaling_room_password: "room-secret-canary",
    transport: "webrtc",
    expires_at: expiresAt,
    data_plane: "rxdb-webrtc",
    http_bridge_available: false,
    session: {
      authenticated: true,
      source: "mobile_invite",
      capability_token: "capability-secret-canary",
      capability_expires_at_ms: Date.parse(expiresAt),
      user: {
        id: "workjet-mobile-invite-a",
        display_name: "Workjet Mobile",
        role: "user",
        is_admin: false,
      },
    },
  },
};

const resolvedShellPack: CtoxMobileShellPackResolveResult = {
  type: "ctox.mobile.shell-pack-distribution.v1",
  manifest: {
    type: "ctox.mobile.shell-pack.v1",
    packId: "pack-a",
    businessOsRevision: "revision-a",
    appVersion: "1.0.0",
    totalSize: 1,
    files: [{ path: "index.html", size: 1, sha256: "a".repeat(64) }],
    signingKeyId: "key-current",
    signature: "b".repeat(128),
  },
  artifact: {
    url: "https://releases.example.test/pack.tar.zst",
    size: 1,
    sha256: "c".repeat(64),
    contentType: "application/zstd",
    expiresAt: "2099-08-25T12:05:00.000Z",
  },
};

const mobileShellPackLayer = Layer.succeed(
  CtoxMobileShellPackService,
  CtoxMobileShellPackService.of({ resolve: () => Effect.succeed(resolvedShellPack) }),
);

const authenticatedAuth = (scopes: ReadonlySet<AuthEnvironmentScope>) =>
  EnvironmentAuthenticatedAuth.of((httpEffect) =>
    httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("test-session"),
        subject: "test-client",
        method: "browser-session-cookie",
        scopes,
      }),
    ),
  );

const unauthenticatedAuth = EnvironmentAuthenticatedAuth.of(() =>
  Effect.fail(
    new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "missing_credential",
      traceId: "test-trace",
    }),
  ),
);

async function fixtureFor(
  auth: typeof EnvironmentAuthenticatedAuth.Service,
  options: { readonly failFirstOldPairingRevoke?: boolean } = {},
) {
  const pairingInputs: Array<unknown> = [];
  const revokedPairingLinks: Array<string> = [];
  const revokedCtoxInvites: Array<string> = [];
  let referenceSequence = 0;
  let pairingSequence = 0;
  let ctoxSequence = 0;
  let oldPairingRevokeFailed = false;
  const mobileInviteLayer = Layer.succeed(
    CtoxMobileInviteService,
    CtoxMobileInviteService.of({
      create: () => {
        ctoxSequence += 1;
        return Effect.succeed({
          ...created,
          inviteId: ctoxSequence === 1 ? "opaque-id" : `opaque-id-${ctoxSequence}`,
        });
      },
      revoke: (inviteId) => {
        revokedCtoxInvites.push(inviteId);
        return Effect.succeed({ revoked: true as const });
      },
    }),
  );
  const environmentAuthLayer = Layer.succeed(
    EnvironmentAuth,
    EnvironmentAuth.of({
      createPairingLink: (input: unknown) => {
        pairingInputs.push(input);
        pairingSequence += 1;
        return Effect.succeed({
          id: pairingSequence === 1 ? "workjet-link-a" : `workjet-link-${pairingSequence}`,
          credential: `synthetic-workjet-bootstrap-${pairingSequence}`,
          scopes: ["access:read", "orchestration:read"],
          subject: "workjet-device:test",
          label: "Workjet device",
          createdAt: Option.getOrThrow(DateTime.make("2099-08-25T12:00:00.000Z")),
          expiresAt: Option.getOrThrow(DateTime.make(expiresAt)),
        });
      },
      revokePairingLink: (pairingLinkId: string) => {
        revokedPairingLinks.push(pairingLinkId);
        if (
          options.failFirstOldPairingRevoke === true &&
          pairingLinkId === "workjet-link-a" &&
          !oldPairingRevokeFailed
        ) {
          oldPairingRevokeFailed = true;
          return Effect.fail(
            new WorkjetDeviceInviteReferences.WorkjetDeviceInviteReferenceServiceError({
              reason: "internal",
            }),
          );
        }
        return Effect.succeed(true);
      },
    } as never),
  );
  let pendingIntent: WorkjetDeviceInviteReferences.WorkjetDeviceInviteIntent | null = null;
  let binding: WorkjetDeviceInviteReferences.WorkjetDeviceBindingRecord | null = null;
  const deviceInviteReferenceLayer = Layer.succeed(
    WorkjetDeviceInviteReferences.WorkjetDeviceInviteReferenceService,
    WorkjetDeviceInviteReferences.WorkjetDeviceInviteReferenceService.of({
      issue: (input) => {
        referenceSequence += 1;
        const inviteId = referenceSequence === 1 ? "reference-a" : `reference-${referenceSequence}`;
        pendingIntent = {
          inviteId,
          endpoint: input.endpoint,
          businessOsInstanceId: input.businessOsInstanceId,
          expiresAtMs: Date.parse(input.expiresAt),
        };
        return Effect.succeed({
          inviteId,
          reference: {
            type: "workjet-device-invite-ref" as const,
            version: 1 as const,
            endpoint: input.endpoint,
            code: String.fromCharCode(98 + referenceSequence).repeat(43),
            expires_at: input.expiresAt,
          },
        });
      },
      consume: () => {
        if (pendingIntent === null) {
          return Effect.fail(
            new WorkjetDeviceInviteReferences.WorkjetDeviceInviteReferenceServiceError({
              reason: "rejected",
            }),
          );
        }
        const intent = pendingIntent;
        pendingIntent = null;
        return Effect.succeed(intent);
      },
      complete: (next) => {
        const previous = binding;
        binding = next;
        return Effect.succeed(previous);
      },
      beginRevocation: (identifier) => {
        if (pendingIntent?.inviteId === identifier) {
          pendingIntent = null;
          return Effect.succeed({ _tag: "pending" as const });
        }
        if (binding?.devicePairingId === identifier) {
          const current = binding;
          return Effect.succeed({ _tag: "binding" as const, binding: current });
        }
        return Effect.succeed({ _tag: "missing" as const });
      },
      finalizeBindingRevocation: (identifier) => {
        if (binding?.devicePairingId !== identifier) return Effect.succeed(false);
        binding = null;
        return Effect.succeed(true);
      },
      listBindings: () => Effect.succeed(binding === null ? [] : [binding]),
    }),
  );
  const client = await Effect.runPromise(
    HttpApiTest.groups(EnvironmentHttpApi, ["businessOs"]).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        businessOsHttpApiLayer.pipe(
          Layer.provide(mobileInviteLayer),
          Layer.provide(mobileShellPackLayer),
          Layer.provide(environmentAuthLayer),
          Layer.provide(deviceInviteReferenceLayer),
        ),
      ]),
      Effect.provideService(EnvironmentAuthenticatedAuth, auth),
      Effect.scoped,
    ),
  );
  return { client, pairingInputs, revokedPairingLinks, revokedCtoxInvites };
}

async function clientFor(auth: typeof EnvironmentAuthenticatedAuth.Service) {
  return (await fixtureFor(auth)).client;
}

describe("Business OS mobile control-plane HTTP safety", () => {
  it("normalizes safe pairing targets and rejects credential-bearing URLs", () => {
    expect(normalizeDeviceConnectionUrl("https://workjet.example.test/")).toBe(
      "https://workjet.example.test",
    );
    expect(normalizeDeviceConnectionUrl("https://user:secret@example.test")).toBeNull();
    expect(normalizeDeviceConnectionUrl("workjet://pair")).toBeNull();
    expect(normalizeDeviceConnectionUrl("http://192.168.1.20:13773")).toBeNull();
    expect(normalizeDeviceConnectionUrl("http://127.0.0.1:13773/")).toBe("http://127.0.0.1:13773");
  });

  it("creates a scoped secret-free reference, binds DPoP on redemption, and revokes that edge", async () => {
    const fixture = await fixtureFor(authenticatedAuth(new Set(["access:write"])));
    const writable = fixture.client;
    const result = await Effect.runPromise(
      writable.businessOs.createDeviceInvite({
        headers: {},
        payload: {
          ttlSeconds: 300,
          connectionUrl: "https://workjet.example.test/",
          businessOsInstanceId: "instance-a",
        },
      }),
    );
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "inviteId", "reference"]);
    expect(JSON.stringify(result)).not.toMatch(
      /bootstrap|capability|signaling|room.secret|synthetic-workjet-bootstrap|room-secret-canary/iu,
    );
    expect(result.reference).toMatchObject({
      type: "workjet-device-invite-ref",
      version: 1,
      endpoint: "https://workjet.example.test",
    });
    expect(result.reference.code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const redeemed = await Effect.runPromise(
      writable.businessOs.redeemDeviceInvite({
        payload: {
          code: result.reference.code,
          deviceId: "galaxy-fold-8",
          proofKeyThumbprint: "a".repeat(43),
        },
      }),
    );
    expect(redeemed).toMatchObject({
      type: "workjet-device-invite",
      device_pairing_id: result.inviteId,
      environment: { bootstrap_credential: "synthetic-workjet-bootstrap-1" },
      business_os: { instance_id: "instance-a" },
    });
    expect(fixture.pairingInputs).toEqual([
      expect.objectContaining({
        subject: "workjet-device:galaxy-fold-8",
        proofKeyThumbprint: "a".repeat(43),
      }),
    ]);
    await expect(
      Effect.runPromise(
        writable.businessOs.revokeDeviceInvite({
          headers: {},
          payload: { inviteId: result.inviteId },
        }),
      ),
    ).resolves.toEqual({ revoked: true });
    expect(fixture.revokedPairingLinks).toContain("workjet-link-a");
    expect(fixture.revokedCtoxInvites).toContain("opaque-id");
  });

  it("redeems once and rejects a replay with another device or thumbprint", async () => {
    const writable = await clientFor(authenticatedAuth(new Set(["access:write"])));
    const result = await Effect.runPromise(
      writable.businessOs.createDeviceInvite({
        headers: {},
        payload: {
          ttlSeconds: 300,
          connectionUrl: "https://workjet.example.test",
          businessOsInstanceId: "instance-a",
        },
      }),
    );
    await expect(
      Effect.runPromise(
        writable.businessOs.redeemDeviceInvite({
          payload: {
            code: result.reference.code,
            deviceId: "device-a",
            proofKeyThumbprint: "a".repeat(43),
          },
        }),
      ),
    ).resolves.toMatchObject({ business_os: { instance_id: "instance-a" } });
    await expect(
      Effect.runPromise(
        writable.businessOs.redeemDeviceInvite({
          payload: {
            code: result.reference.code,
            deviceId: "device-b",
            proofKeyThumbprint: "b".repeat(43),
          },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "WorkjetDeviceInviteRedeemRejectedError" });
  });

  it("rejects a redemption when the CTOX invite does not match the selected instance", async () => {
    const fixture = await fixtureFor(authenticatedAuth(new Set(["access:write"])));
    const result = await Effect.runPromise(
      fixture.client.businessOs.createDeviceInvite({
        headers: {},
        payload: {
          ttlSeconds: 300,
          connectionUrl: "https://workjet.example.test",
          businessOsInstanceId: "instance-b",
        },
      }),
    );
    await expect(
      Effect.runPromise(
        fixture.client.businessOs.redeemDeviceInvite({
          payload: {
            code: result.reference.code,
            deviceId: "device-a",
            proofKeyThumbprint: "a".repeat(43),
          },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "WorkjetDeviceInviteRedeemRejectedError" });
    expect(fixture.revokedPairingLinks).toContain("workjet-link-a");
    expect(fixture.revokedCtoxInvites).toContain("opaque-id");
  });

  it("keeps an old edge retryable when replacement credential revocation fails", async () => {
    const fixture = await fixtureFor(authenticatedAuth(new Set(["access:write"])), {
      failFirstOldPairingRevoke: true,
    });
    const create = () =>
      Effect.runPromise(
        fixture.client.businessOs.createDeviceInvite({
          headers: {},
          payload: {
            ttlSeconds: 300,
            connectionUrl: "https://workjet.example.test",
            businessOsInstanceId: "instance-a",
          },
        }),
      );
    const redeem = (code: string) =>
      Effect.runPromise(
        fixture.client.businessOs.redeemDeviceInvite({
          payload: {
            code,
            deviceId: "device-a",
            proofKeyThumbprint: "a".repeat(43),
          },
        }),
      );

    const first = await create();
    await expect(redeem(first.reference.code)).resolves.toMatchObject({
      device_pairing_id: first.inviteId,
    });

    const failedReplacement = await create();
    await expect(redeem(failedReplacement.reference.code)).rejects.toMatchObject({
      _tag: "EnvironmentInternalError",
      reason: "device_invite_issuance_failed",
    });

    const retry = await create();
    await expect(redeem(retry.reference.code)).resolves.toMatchObject({
      device_pairing_id: retry.inviteId,
    });
    expect(
      fixture.revokedPairingLinks.filter((identifier) => identifier === "workjet-link-a"),
    ).toHaveLength(2);
    expect(fixture.revokedCtoxInvites).toContain("opaque-id");
  });

  it("retries an exact-edge revoke after a downstream failure", async () => {
    const fixture = await fixtureFor(authenticatedAuth(new Set(["access:write"])), {
      failFirstOldPairingRevoke: true,
    });
    const createdReference = await Effect.runPromise(
      fixture.client.businessOs.createDeviceInvite({
        headers: {},
        payload: {
          ttlSeconds: 300,
          connectionUrl: "https://workjet.example.test",
          businessOsInstanceId: "instance-a",
        },
      }),
    );
    await Effect.runPromise(
      fixture.client.businessOs.redeemDeviceInvite({
        payload: {
          code: createdReference.reference.code,
          deviceId: "device-a",
          proofKeyThumbprint: "a".repeat(43),
        },
      }),
    );
    const revoke = () =>
      Effect.runPromise(
        fixture.client.businessOs.revokeDeviceInvite({
          headers: {},
          payload: { inviteId: createdReference.inviteId },
        }),
      );
    await expect(revoke()).rejects.toMatchObject({
      _tag: "EnvironmentInternalError",
      reason: "device_invite_revoke_failed",
    });
    await expect(revoke()).resolves.toEqual({ revoked: true });
    expect(
      fixture.revokedPairingLinks.filter((identifier) => identifier === "workjet-link-a"),
    ).toHaveLength(2);
  });

  it("disables caches and referrers for invite and shell-pack responses", () => {
    expect(MOBILE_INVITE_RESPONSE_HEADERS).toEqual({
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
    });
  });

  it("rejects unauthenticated and non-write clients, then creates and revokes", async () => {
    const unauthenticated = await clientFor(unauthenticatedAuth);
    await expect(
      Effect.runPromise(
        unauthenticated.businessOs.createMobileInvite({
          headers: {},
          payload: { ttlSeconds: 300 },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "EnvironmentAuthInvalidError" });

    const readOnly = await clientFor(authenticatedAuth(new Set(["access:read"])));
    await expect(
      Effect.runPromise(
        readOnly.businessOs.createMobileInvite({
          headers: {},
          payload: { ttlSeconds: 300 },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "EnvironmentScopeRequiredError" });

    const writable = await clientFor(authenticatedAuth(new Set(["access:write"])));
    await expect(
      Effect.runPromise(
        writable.businessOs.createMobileInvite({
          headers: {},
          payload: { ttlSeconds: 300 },
        }),
      ),
    ).resolves.toEqual(created);
    await expect(
      Effect.runPromise(
        writable.businessOs.revokeMobileInvite({
          headers: {},
          payload: { inviteId: created.inviteId },
        }),
      ),
    ).resolves.toEqual({ revoked: true });
  });

  it("requires read access and resolves the exact shell-pack distribution", async () => {
    const unauthenticated = await clientFor(unauthenticatedAuth);
    await expect(
      Effect.runPromise(
        unauthenticated.businessOs.resolveMobileShellPack({
          headers: {},
          payload: { businessOsRevision: "revision-a", appVersion: "1.0.0" },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "EnvironmentAuthInvalidError" });

    const readOnly = await clientFor(authenticatedAuth(new Set(["access:read"])));
    await expect(
      Effect.runPromise(
        readOnly.businessOs.resolveMobileShellPack({
          headers: {},
          payload: { businessOsRevision: "revision-a", appVersion: "1.0.0" },
        }),
      ),
    ).resolves.toEqual(resolvedShellPack);
  });
});
