import { RelayClientPrincipal, RelayDpopClientAuth } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import * as CtoxServiceAuth from "../auth/CtoxServiceAuth.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as BusinessOsMemberships from "../workjet/BusinessOsMemberships.ts";
import * as ControlIdentityAssertions from "../workjet/ControlIdentityAssertions.ts";
import * as DeviceSessions from "../workjet/DeviceSessions.ts";
import { appendRelayCredentialResponseHeaders, requireDpopThumbprint } from "./Api.ts";

const BoundedId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((value) =>
    /^[^\u0000-\u001f\u007f]+$/u.test(value) ? true : "ASCII control characters are forbidden.",
  ),
);
const InstallationId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
);
const OpaqueCredential = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);
const ProofThumbprint = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);
const AccessToken = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(8_192),
  Schema.isPattern(/^[A-Za-z0-9._~-]+$/u),
);
const Rfc3339 = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) =>
    DateTime.make(value)._tag === "Some" ? true : "Invalid timestamp.",
  ),
);
const DpopHeaders = Schema.Struct({ dpop: Schema.String.check(Schema.isMaxLength(8_192)) });
const DpopAuthorizationHeaders = Schema.Struct({
  authorization: Schema.String.check(Schema.isMaxLength(8_192), Schema.isPattern(/^DPoP [^\s]+$/u)),
  dpop: Schema.String.check(Schema.isMaxLength(8_192)),
});
const ServiceHeaders = Schema.Struct({
  authorization: Schema.String.check(Schema.isMaxLength(8_192)),
});

export class WorkjetRelayRejectedError extends Schema.TaggedErrorClass<WorkjetRelayRejectedError>()(
  "WorkjetRelayRejectedError",
  { code: Schema.Literal("workjet_relay_rejected") },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetRelayRejectedError)(this, { status: 401 });
  }
}

export class WorkjetRelayConflictError extends Schema.TaggedErrorClass<WorkjetRelayConflictError>()(
  "WorkjetRelayConflictError",
  { code: Schema.Literal("workjet_relay_conflict") },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetRelayConflictError)(this, { status: 409 });
  }
}

export class WorkjetRelayUnavailableError extends Schema.TaggedErrorClass<WorkjetRelayUnavailableError>()(
  "WorkjetRelayUnavailableError",
  { code: Schema.Literal("workjet_relay_unavailable") },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetRelayUnavailableError)(this, { status: 503 });
  }
}

const Errors = [
  WorkjetRelayRejectedError,
  WorkjetRelayConflictError,
  WorkjetRelayUnavailableError,
] as const;

const IssueInput = Schema.Struct({
  businessOsInstanceId: BoundedId,
  devicePairingId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  deviceId: BoundedId,
  proofKeyThumbprint: ProofThumbprint,
  relayUserId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(191)),
  ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 3_600 })),
});
const IssueResult = Schema.Struct({
  grantId: OpaqueCredential,
  issuer: Schema.String,
  bootstrapCredential: OpaqueCredential,
  expiresAt: Rfc3339,
});
const RevokeInput = Schema.Struct({ businessOsInstanceId: BoundedId, grantId: OpaqueCredential });
const OkResult = Schema.Struct({ ok: Schema.Boolean });
const MembershipResult = Schema.Struct({
  businessOsInstanceId: BoundedId,
  membershipVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  environmentIds: Schema.Array(BoundedId).check(Schema.isMaxLength(1_000)),
});
const MembershipReplaceInput = Schema.Struct({
  businessOsInstanceId: BoundedId,
  relayUserId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(191)),
  membershipVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  environmentIds: Schema.Array(BoundedId).check(
    Schema.isMaxLength(1_000),
    Schema.makeFilter((values) =>
      new Set(values).size === values.length ? true : "Environment IDs must be unique.",
    ),
  ),
});
const ExchangeInput = Schema.Struct({
  bootstrapCredential: OpaqueCredential,
  deviceId: BoundedId,
  businessOsInstanceId: BoundedId,
});
const RenewInput = Schema.Struct({
  refreshGrant: OpaqueCredential,
  deviceId: BoundedId,
  businessOsInstanceId: BoundedId,
});
const AuthorizationResult = Schema.Struct({
  tokenType: Schema.Literal("DPoP"),
  accessToken: AccessToken,
  refreshGrant: OpaqueCredential,
  relayIssuer: Schema.String,
  relayScopes: Schema.Array(Schema.Literals(["environment:connect", "environment:status"])).check(
    Schema.makeFilter((values) =>
      values.length === 2 &&
      values.includes("environment:connect") &&
      values.includes("environment:status")
        ? true
        : "Both environment scopes are required.",
    ),
  ),
  businessOsInstanceId: BoundedId,
  deviceId: BoundedId,
  expiresAt: Rfc3339,
  refreshExpiresAt: Rfc3339,
});
const MembershipReadInput = Schema.Struct({ businessOsInstanceId: BoundedId });
const IdentityIssueInput = Schema.Struct({
  audience: Schema.Literal("ctox.dev"),
  workjetInstallationId: InstallationId,
  businessOsInstanceId: BoundedId,
});
const IdentityIssueResult = Schema.Struct({ assertion: AccessToken, expiresAt: Rfc3339 });
const IdentityConsumeInput = Schema.Struct({ assertion: AccessToken });
const IdentityClaimsResult = Schema.Struct({
  relayUserId: Schema.String,
  workjetInstallationId: InstallationId,
  businessOsInstanceId: BoundedId,
  proofKeyThumbprint: ProofThumbprint,
  expiresAt: Rfc3339,
});
const JwksResult = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.Literal("OKP"),
      crv: Schema.Literal("Ed25519"),
      x: Schema.String,
      use: Schema.Literal("sig"),
      alg: Schema.Literal("EdDSA"),
      kid: Schema.String,
    }),
  ),
});

const privateGroup = HttpApiGroup.make("workjetPrivate")
  .add(
    HttpApiEndpoint.post("issueDeviceSession", "/v1/private/workjet/device-session-grants", {
      headers: ServiceHeaders,
      payload: IssueInput,
      success: IssueResult,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "revokeDeviceSession",
      "/v1/private/workjet/device-session-grants/revoke",
      { headers: ServiceHeaders, payload: RevokeInput, success: OkResult, error: Errors },
    ),
  )
  .add(
    HttpApiEndpoint.put(
      "replaceMembership",
      "/v1/private/workjet/business-os-instances/:businessOsInstanceId/environments",
      {
        headers: ServiceHeaders,
        params: Schema.Struct({ businessOsInstanceId: BoundedId }),
        payload: MembershipReplaceInput,
        success: MembershipResult,
        error: Errors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "consumeIdentityAssertion",
      "/v1/private/workjet/control-identity-assertions/consume",
      {
        headers: ServiceHeaders,
        payload: IdentityConsumeInput,
        success: IdentityClaimsResult,
        error: Errors,
      },
    ),
  );

const sessionGroup = HttpApiGroup.make("workjetSessions")
  .add(
    HttpApiEndpoint.post("exchange", "/api/workjet/device-session/exchange", {
      headers: DpopHeaders,
      payload: ExchangeInput,
      success: AuthorizationResult,
      error: Errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("renew", "/api/workjet/device-session/renew", {
      headers: DpopHeaders,
      payload: RenewInput,
      success: AuthorizationResult,
      error: Errors,
    }),
  );

const authenticatedGroup = HttpApiGroup.make("workjetAuthenticated")
  .add(
    HttpApiEndpoint.post(
      "issueIdentityAssertion",
      "/api/workjet/device-session/control-assertion",
      {
        headers: DpopAuthorizationHeaders,
        payload: IdentityIssueInput,
        success: IdentityIssueResult,
        error: Errors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("readMembership", "/api/workjet/device-session/business-os/computers", {
      headers: DpopAuthorizationHeaders,
      payload: MembershipReadInput,
      success: MembershipResult,
      error: Errors,
    }),
  )
  .middleware(RelayDpopClientAuth);

const metadataGroup = HttpApiGroup.make("workjetMetadata").add(
  HttpApiEndpoint.get("jwks", "/.well-known/jwks.json", { success: JwksResult, error: Errors }),
);

export class WorkjetRelayApi extends HttpApi.make("WorkjetRelayApi")
  .add(privateGroup)
  .add(sessionGroup)
  .add(authenticatedGroup)
  .add(metadataGroup) {}

const rejected = () => new WorkjetRelayRejectedError({ code: "workjet_relay_rejected" });
const unavailable = () => new WorkjetRelayUnavailableError({ code: "workjet_relay_unavailable" });
const conflict = () => new WorkjetRelayConflictError({ code: "workjet_relay_conflict" });

const requireService = Effect.fn("relay.workjet.require_service")(function* (
  authorization: string | undefined,
) {
  const auth = yield* CtoxServiceAuth.CtoxServiceAuth;
  if (!(yield* auth.isAuthorized(authorization))) return yield* rejected();
});

function authorizationResponse(
  config: RelayConfiguration.RelayConfiguration["Service"],
  authorization: DeviceSessions.DeviceSessionAuthorization,
) {
  return {
    tokenType: "DPoP" as const,
    accessToken: authorization.accessToken,
    refreshGrant: authorization.refreshGrant,
    relayIssuer: config.relayIssuer,
    relayScopes: ["environment:connect", "environment:status"] as const,
    businessOsInstanceId: authorization.businessOsInstanceId,
    deviceId: authorization.deviceId,
    expiresAt: authorization.accessExpiresAt,
    refreshExpiresAt: authorization.refreshExpiresAt,
  };
}

export function resolveControlIdentityAssertionAuthority(input: {
  readonly relayPrincipal: {
    readonly userId: string;
    readonly proofKeyThumbprint?: string;
  };
  readonly devicePrincipal: DeviceSessions.DeviceSessionGrantCandidate | null;
  readonly workjetInstallationId: string;
  readonly businessOsInstanceId: string;
}): { readonly relayUserId: string; readonly proofKeyThumbprint: string } | null {
  const currentJkt = input.relayPrincipal.proofKeyThumbprint;
  if (!currentJkt) return null;
  if (!input.devicePrincipal) {
    return { relayUserId: input.relayPrincipal.userId, proofKeyThumbprint: currentJkt };
  }
  const device = input.devicePrincipal;
  if (
    device.relayUserId !== input.relayPrincipal.userId ||
    device.businessOsInstanceId !== input.businessOsInstanceId ||
    device.deviceId !== input.workjetInstallationId ||
    device.proofKeyThumbprint !== currentJkt
  ) {
    return null;
  }
  return { relayUserId: device.relayUserId, proofKeyThumbprint: device.proofKeyThumbprint };
}

export const workjetPrivateApi = HttpApiBuilder.group(
  WorkjetRelayApi,
  "workjetPrivate",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const sessions = yield* DeviceSessions.DeviceSessions;
    const memberships = yield* BusinessOsMemberships.BusinessOsMemberships;
    const assertions = yield* ControlIdentityAssertions.ControlIdentityAssertions;
    return handlers
      .handle("issueDeviceSession", ({ headers, payload }) =>
        Effect.gen(function* () {
          yield* appendRelayCredentialResponseHeaders;
          yield* requireService(headers.authorization);
          const issued = yield* sessions.issue(payload).pipe(
            Effect.catchTags({
              DeviceSessionRejected: (error) =>
                error.reason === "idempotency-conflict" || error.reason === "owner-mismatch"
                  ? Effect.fail(conflict())
                  : Effect.fail(rejected()),
              DeviceSessionPersistenceError: () => Effect.fail(unavailable()),
              DeviceSessionConfigurationError: () => Effect.fail(unavailable()),
            }),
          );
          return { ...issued, issuer: config.relayIssuer };
        }),
      )
      .handle("revokeDeviceSession", ({ headers, payload }) =>
        Effect.gen(function* () {
          yield* appendRelayCredentialResponseHeaders;
          yield* requireService(headers.authorization);
          yield* sessions.revoke(payload).pipe(Effect.mapError(() => unavailable()));
          return { ok: true };
        }),
      )
      .handle("replaceMembership", ({ headers, params, payload }) =>
        Effect.gen(function* () {
          yield* appendRelayCredentialResponseHeaders;
          yield* requireService(headers.authorization);
          if (params.businessOsInstanceId !== payload.businessOsInstanceId) {
            return yield* conflict();
          }
          const result = yield* memberships
            .replace(payload)
            .pipe(
              Effect.mapError((error) =>
                error._tag === "BusinessOsMembershipConflict" ? conflict() : unavailable(),
              ),
            );
          return {
            businessOsInstanceId: result.businessOsInstanceId,
            membershipVersion: result.membershipVersion,
            environmentIds: [...result.environmentIds],
          };
        }),
      )
      .handle("consumeIdentityAssertion", ({ headers, payload }) =>
        Effect.gen(function* () {
          yield* appendRelayCredentialResponseHeaders;
          yield* requireService(headers.authorization);
          const claims = yield* assertions
            .consume(payload.assertion)
            .pipe(Effect.mapError(() => unavailable()));
          if (!claims) return yield* rejected();
          return {
            relayUserId: claims.sub,
            workjetInstallationId: claims.workjetInstallationId,
            businessOsInstanceId: claims.businessOsInstanceId,
            proofKeyThumbprint: claims.cnf.jkt,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(claims.exp * 1_000)),
          };
        }),
      );
  }),
);

export const workjetSessionApi = HttpApiBuilder.group(
  WorkjetRelayApi,
  "workjetSessions",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const sessions = yield* DeviceSessions.DeviceSessions;
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    return handlers
      .handle("exchange", ({ payload }) =>
        Effect.gen(function* () {
          yield* appendRelayCredentialResponseHeaders;
          const candidate = yield* sessions
            .findBootstrap(payload.bootstrapCredential)
            .pipe(Effect.mapError(() => unavailable()));
          if (
            !candidate ||
            candidate.businessOsInstanceId !== payload.businessOsInstanceId ||
            candidate.deviceId !== payload.deviceId
          ) {
            return yield* rejected();
          }
          yield* requireDpopThumbprint(candidate.proofKeyThumbprint).pipe(
            Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs),
            Effect.mapError(() => rejected()),
          );
          const authorization = yield* sessions
            .exchangeBootstrap(payload)
            .pipe(
              Effect.mapError((error) =>
                error._tag === "DeviceSessionRejected" ? rejected() : unavailable(),
              ),
            );
          return authorizationResponse(config, authorization);
        }),
      )
      .handle("renew", ({ payload }) =>
        Effect.gen(function* () {
          yield* appendRelayCredentialResponseHeaders;
          const candidate = yield* sessions
            .findRefresh(payload.refreshGrant)
            .pipe(Effect.mapError(() => unavailable()));
          if (
            !candidate ||
            candidate.businessOsInstanceId !== payload.businessOsInstanceId ||
            candidate.deviceId !== payload.deviceId
          ) {
            return yield* rejected();
          }
          yield* requireDpopThumbprint(candidate.proofKeyThumbprint).pipe(
            Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs),
            Effect.mapError(() => rejected()),
          );
          const authorization = yield* sessions
            .renew(payload)
            .pipe(
              Effect.mapError((error) =>
                error._tag === "DeviceSessionRejected" ? rejected() : unavailable(),
              ),
            );
          return authorizationResponse(config, authorization);
        }),
      );
  }),
);

export const workjetAuthenticatedApi = HttpApiBuilder.group(
  WorkjetRelayApi,
  "workjetAuthenticated",
  Effect.fnUntraced(function* (handlers) {
    const assertions = yield* ControlIdentityAssertions.ControlIdentityAssertions;
    const memberships = yield* BusinessOsMemberships.BusinessOsMemberships;
    return handlers
      .handle("issueIdentityAssertion", ({ payload }) =>
        Effect.gen(function* () {
          yield* appendRelayCredentialResponseHeaders;
          const principal = yield* RelayClientPrincipal;
          const devicePrincipal = yield* Effect.serviceOption(
            DeviceSessions.WorkjetDeviceSessionPrincipal,
          );
          const authority = resolveControlIdentityAssertionAuthority({
            relayPrincipal: principal,
            devicePrincipal: Option.getOrNull(devicePrincipal),
            workjetInstallationId: payload.workjetInstallationId,
            businessOsInstanceId: payload.businessOsInstanceId,
          });
          if (!authority) return yield* rejected();
          yield* requireDpopThumbprint(authority.proofKeyThumbprint, {
            expectedAccessToken: principal.token,
          }).pipe(Effect.mapError(() => rejected()));
          return yield* assertions
            .issue({
              relayUserId: authority.relayUserId,
              proofKeyThumbprint: authority.proofKeyThumbprint,
              workjetInstallationId: payload.workjetInstallationId,
              businessOsInstanceId: payload.businessOsInstanceId,
            })
            .pipe(Effect.mapError(() => unavailable()));
        }),
      )
      .handle("readMembership", ({ payload }) =>
        Effect.gen(function* () {
          yield* appendRelayCredentialResponseHeaders;
          const principal = yield* Effect.serviceOption(
            DeviceSessions.WorkjetDeviceSessionPrincipal,
          );
          const relayPrincipal = yield* RelayClientPrincipal;
          if (
            Option.isNone(principal) ||
            principal.value.businessOsInstanceId !== payload.businessOsInstanceId
          ) {
            return yield* rejected();
          }
          yield* requireDpopThumbprint(principal.value.proofKeyThumbprint, {
            expectedAccessToken: relayPrincipal.token,
          }).pipe(Effect.mapError(() => rejected()));
          const membership = yield* memberships
            .read({
              businessOsInstanceId: principal.value.businessOsInstanceId,
              relayUserId: principal.value.relayUserId,
            })
            .pipe(Effect.mapError(() => unavailable()));
          if (!membership) return yield* rejected();
          return {
            businessOsInstanceId: membership.businessOsInstanceId,
            membershipVersion: membership.membershipVersion,
            environmentIds: [...membership.environmentIds],
          };
        }),
      );
  }),
);

export const workjetMetadataApi = HttpApiBuilder.group(
  WorkjetRelayApi,
  "workjetMetadata",
  Effect.fnUntraced(function* (handlers) {
    const assertions = yield* ControlIdentityAssertions.ControlIdentityAssertions;
    return handlers.handle("jwks", () =>
      assertions.jwks.pipe(Effect.mapError(() => unavailable())),
    );
  }),
);
