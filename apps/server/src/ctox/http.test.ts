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
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import {
  businessOsHttpApiLayer,
  decodeDeviceInviteId,
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

const mobileInviteLayer = Layer.succeed(
  CtoxMobileInviteService,
  CtoxMobileInviteService.of({
    create: () => Effect.succeed(created),
    revoke: () => Effect.succeed({ revoked: true as const }),
  }),
);

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

const environmentAuthLayer = Layer.succeed(
  EnvironmentAuth,
  EnvironmentAuth.of({
    createPairingLink: () =>
      Effect.succeed({
        id: "workjet-link-a",
        credential: "synthetic-workjet-bootstrap",
        scopes: ["access:read", "orchestration:read"],
        subject: "workjet-device:test",
        label: "Workjet mobile device",
        createdAt: Option.getOrThrow(DateTime.make("2099-08-25T12:00:00.000Z")),
        expiresAt: Option.getOrThrow(DateTime.make(expiresAt)),
      }),
    revokePairingLink: () => Effect.succeed(true),
  } as never),
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

async function clientFor(auth: typeof EnvironmentAuthenticatedAuth.Service) {
  return Effect.runPromise(
    HttpApiTest.groups(EnvironmentHttpApi, ["businessOs"]).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        businessOsHttpApiLayer.pipe(
          Layer.provide(mobileInviteLayer),
          Layer.provide(mobileShellPackLayer),
          Layer.provide(environmentAuthLayer),
        ),
      ]),
      Effect.provideService(EnvironmentAuthenticatedAuth, auth),
      Effect.scoped,
    ),
  );
}

describe("Business OS mobile control-plane HTTP safety", () => {
  it("normalizes safe pairing targets and rejects credential-bearing URLs", () => {
    expect(normalizeDeviceConnectionUrl("https://workjet.example.test/")).toBe(
      "https://workjet.example.test",
    );
    expect(normalizeDeviceConnectionUrl("https://user:secret@example.test")).toBeNull();
    expect(normalizeDeviceConnectionUrl("workjet://pair")).toBeNull();
  });

  it("creates and jointly revokes one Workjet device pairing", async () => {
    const writable = await clientFor(authenticatedAuth(new Set(["access:write"])));
    const result = await Effect.runPromise(
      writable.businessOs.createDeviceInvite({
        headers: {},
        payload: { ttlSeconds: 300, connectionUrl: "https://workjet.example.test/" },
      }),
    );
    expect(result.invite.type).toBe("workjet-device-invite");
    expect(result.invite.environment).toMatchObject({
      base_url: "https://workjet.example.test",
      bootstrap_credential: "synthetic-workjet-bootstrap",
    });
    expect(result.invite.business_os).toEqual(created.invite);
    expect(decodeDeviceInviteId(result.inviteId)).toEqual({
      version: 1,
      workjetPairingId: "workjet-link-a",
      ctoxInviteId: "opaque-id",
    });
    await expect(
      Effect.runPromise(
        writable.businessOs.revokeDeviceInvite({
          headers: {},
          payload: { inviteId: result.inviteId },
        }),
      ),
    ).resolves.toEqual({ revoked: true });
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
