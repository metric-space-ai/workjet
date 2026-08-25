import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
  type CtoxMobileInviteCreateResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpApiTest } from "effect/unstable/httpapi";
import { describe, expect, it } from "vite-plus/test";

import { CtoxMobileInviteService } from "./CtoxMobileInviteService.ts";
import { businessOsHttpApiLayer, MOBILE_INVITE_RESPONSE_HEADERS } from "./http.ts";

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
        businessOsHttpApiLayer.pipe(Layer.provide(mobileInviteLayer)),
      ]),
      Effect.provideService(EnvironmentAuthenticatedAuth, auth),
      Effect.scoped,
    ),
  );
}

describe("Business OS mobile invite HTTP safety", () => {
  it("disables caches and referrers for create and revoke responses", () => {
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
});
