// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CtoxBusinessOsInviteV1,
  WorkjetDeviceBindingListResult,
  WorkjetDeviceInviteCreateResult,
  WorkjetDeviceInviteRedeemInput,
  WorkjetDeviceInviteRevokeResult,
} from "./ctox.ts";
import {
  WorkjetDeviceInviteRedeemRateLimitedError,
  WorkjetDeviceInviteRedeemRejectedError,
} from "./environmentHttp.ts";
import { BusinessOsInstanceId } from "./workjetBusinessOsComputers.ts";
import {
  RelayDpopAccessTokenScope,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "./relay.ts";

const OpaqueBase64Url = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);

const Rfc3339Timestamp = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "[::1]" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

export const WorkjetManagedIssuerOrigin = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value: string) => {
    try {
      const url = new URL(value);
      if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
        return "Issuer origin must not contain credentials, query parameters, or a fragment.";
      }
      if (url.pathname !== "/") return "Issuer must be an origin without a path.";
      if (url.protocol === "https:") return true;
      return url.protocol === "http:" && isLoopbackHostname(url.hostname)
        ? true
        : "Issuer must use HTTPS, except for an exact loopback origin.";
    } catch {
      return "Issuer must be an absolute URL origin.";
    }
  }),
);
export type WorkjetManagedIssuerOrigin = typeof WorkjetManagedIssuerOrigin.Type;

/**
 * Short-lived, possession-bound handle into one managed Business OS control plane.
 *
 * The producer generates at least 256 random bits. The value is scoped server-side
 * to the authenticated Workjet user session, installation identity, DPoP key and
 * canonical Business OS authority identity. It is never an Environment/Computer id.
 */
export const WorkjetManagedBackendControlConnectionId = OpaqueBase64Url.pipe(
  Schema.brand("WorkjetManagedBackendControlConnectionId"),
);
export type WorkjetManagedBackendControlConnectionId =
  typeof WorkjetManagedBackendControlConnectionId.Type;

export const WorkjetInstallationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
).pipe(Schema.brand("WorkjetInstallationId"));
export type WorkjetInstallationId = typeof WorkjetInstallationId.Type;

/**
 * Relay-signed compact assertion. ctox.dev validates issuer, audience, expiry,
 * JTI, installation identity and `cnf.jkt`; it never correlates accounts by
 * email or accepts client-asserted Relay user ids.
 */
export const WorkjetRelayControlIdentityAssertion = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(8_192),
  Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
).pipe(Schema.brand("WorkjetRelayControlIdentityAssertion"));
export type WorkjetRelayControlIdentityAssertion = typeof WorkjetRelayControlIdentityAssertion.Type;

export const WorkjetRelayControlIdentityAssertionIssueInput = Schema.Struct({
  audience: Schema.Literal("ctox.dev"),
  workjetInstallationId: WorkjetInstallationId,
  businessOsInstanceId: BusinessOsInstanceId,
});
export type WorkjetRelayControlIdentityAssertionIssueInput =
  typeof WorkjetRelayControlIdentityAssertionIssueInput.Type;

export const WorkjetRelayControlIdentityAssertionIssueResult = Schema.Struct({
  assertion: WorkjetRelayControlIdentityAssertion,
  expiresAt: Rfc3339Timestamp,
});
export type WorkjetRelayControlIdentityAssertionIssueResult =
  typeof WorkjetRelayControlIdentityAssertionIssueResult.Type;

/** Maximum lifetime of a managed control handle. Producers may issue shorter handles. */
export const WORKJET_MANAGED_BACKEND_CONTROL_MAX_TTL_SECONDS = 600;

/** Mandatory producer response headers for every resolve/list/create/revoke response. */
export const WORKJET_MANAGED_BACKEND_CONTROL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
} as const;

export const WorkjetManagedBackendControlResolveInput = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  workjetInstallationId: WorkjetInstallationId,
  relayIdentityAssertion: WorkjetRelayControlIdentityAssertion,
});
export type WorkjetManagedBackendControlResolveInput =
  typeof WorkjetManagedBackendControlResolveInput.Type;

/** Cookie-free resolve used only by an already paired, DPoP-bound installation. */
export const WorkjetManagedDeviceControlResolveInput = WorkjetManagedBackendControlResolveInput;
export type WorkjetManagedDeviceControlResolveInput =
  typeof WorkjetManagedDeviceControlResolveInput.Type;

export const WorkjetManagedDeviceControlResolveHeaders = Schema.Struct({
  dpop: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
});
export type WorkjetManagedDeviceControlResolveHeaders =
  typeof WorkjetManagedDeviceControlResolveHeaders.Type;

export const WorkjetManagedBackendControlResolveResult = Schema.Struct({
  backendControlConnectionId: WorkjetManagedBackendControlConnectionId,
  businessOsInstanceId: BusinessOsInstanceId,
  expiresAt: Rfc3339Timestamp,
});
export type WorkjetManagedBackendControlResolveResult =
  typeof WorkjetManagedBackendControlResolveResult.Type;

const WorkjetManagedBackendControlScope = {
  backendControlConnectionId: WorkjetManagedBackendControlConnectionId,
  businessOsInstanceId: BusinessOsInstanceId,
} as const;

export const WorkjetManagedDeviceBindingListInput = Schema.Struct({
  ...WorkjetManagedBackendControlScope,
});
export type WorkjetManagedDeviceBindingListInput = typeof WorkjetManagedDeviceBindingListInput.Type;

export const WorkjetManagedDeviceControlCsrfInput = Schema.Struct({
  ...WorkjetManagedBackendControlScope,
});
export type WorkjetManagedDeviceControlCsrfInput = typeof WorkjetManagedDeviceControlCsrfInput.Type;

export const WorkjetManagedDeviceControlCsrfHeaders = WorkjetManagedDeviceControlResolveHeaders;
export type WorkjetManagedDeviceControlCsrfHeaders =
  typeof WorkjetManagedDeviceControlCsrfHeaders.Type;

export const WorkjetManagedControlCsrfResult = Schema.Struct({
  ok: Schema.Literal(true),
  csrfToken: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  expiresAt: Rfc3339Timestamp,
});
export type WorkjetManagedControlCsrfResult = typeof WorkjetManagedControlCsrfResult.Type;

/**
 * Managed invite creation deliberately omits `connectionUrl`: the producer
 * chooses its own trusted redemption origin and the selected backend instance.
 */
export const WorkjetManagedDeviceInviteCreateInput = Schema.Struct({
  ...WorkjetManagedBackendControlScope,
  ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 3_600 })),
});
export type WorkjetManagedDeviceInviteCreateInput =
  typeof WorkjetManagedDeviceInviteCreateInput.Type;

export const WorkjetManagedDeviceInviteRevokeInput = Schema.Struct({
  ...WorkjetManagedBackendControlScope,
  inviteId: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
});
export type WorkjetManagedDeviceInviteRevokeInput =
  typeof WorkjetManagedDeviceInviteRevokeInput.Type;

/** DPoP proof for the unauthenticated possession-of-secret redemption request. */
export const WorkjetManagedDeviceInviteRedeemHeaders = Schema.Struct({
  dpop: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
});
export type WorkjetManagedDeviceInviteRedeemHeaders =
  typeof WorkjetManagedDeviceInviteRedeemHeaders.Type;

export const WorkjetManagedProvisioningGrantId = OpaqueBase64Url.pipe(
  Schema.brand("WorkjetManagedProvisioningGrantId"),
);
export type WorkjetManagedProvisioningGrantId = typeof WorkjetManagedProvisioningGrantId.Type;

export const WorkjetDeviceSessionBootstrapCredential = OpaqueBase64Url.pipe(
  Schema.brand("WorkjetDeviceSessionBootstrapCredential"),
);
export type WorkjetDeviceSessionBootstrapCredential =
  typeof WorkjetDeviceSessionBootstrapCredential.Type;

export const WorkjetDeviceSessionAccessToken = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(8_192),
  Schema.isPattern(/^[A-Za-z0-9._~-]+$/),
).pipe(Schema.brand("WorkjetDeviceSessionAccessToken"));
export type WorkjetDeviceSessionAccessToken = typeof WorkjetDeviceSessionAccessToken.Type;

export const WorkjetDeviceSessionRefreshGrant = OpaqueBase64Url.pipe(
  Schema.brand("WorkjetDeviceSessionRefreshGrant"),
);
export type WorkjetDeviceSessionRefreshGrant = typeof WorkjetDeviceSessionRefreshGrant.Type;

export const WorkjetDeviceSessionRelayScopes = Schema.Array(RelayDpopAccessTokenScope).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(3),
  Schema.makeFilter((scopes: ReadonlyArray<string>) => {
    const unique = new Set(scopes);
    return unique.size === scopes.length &&
      unique.has(RelayEnvironmentConnectScope) &&
      unique.has(RelayEnvironmentStatusScope)
      ? true
      : "Device sessions must grant unique environment connect and status scopes.";
  }),
);
export type WorkjetDeviceSessionRelayScopes = typeof WorkjetDeviceSessionRelayScopes.Type;

const WorkjetManagedDeviceProvisioningScope = {
  businessOsInstanceId: BusinessOsInstanceId,
  devicePairingId: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  deviceId: WorkjetDeviceInviteRedeemInput.fields.deviceId,
  proofKeyThumbprint: WorkjetDeviceInviteRedeemInput.fields.proofKeyThumbprint,
  ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 3_600 })),
} as const;

/**
 * Private input to the instance-scoped Workjet device-session issuer.
 * The resulting session discovers 0..N Code computers through authoritative
 * membership; it is never a bootstrap for one chosen Environment.
 */
export const WorkjetManagedDeviceSessionIssueInput = Schema.Struct({
  ...WorkjetManagedDeviceProvisioningScope,
});
export type WorkjetManagedDeviceSessionIssueInput =
  typeof WorkjetManagedDeviceSessionIssueInput.Type;

export const WorkjetManagedDeviceSessionIssueResult = Schema.Struct({
  grantId: WorkjetManagedProvisioningGrantId,
  businessOsInstanceId: BusinessOsInstanceId,
  deviceId: WorkjetDeviceInviteRedeemInput.fields.deviceId,
  proofKeyThumbprint: WorkjetDeviceInviteRedeemInput.fields.proofKeyThumbprint,
  issuer: WorkjetManagedIssuerOrigin,
  bootstrapCredential: WorkjetDeviceSessionBootstrapCredential,
  expiresAt: Rfc3339Timestamp,
});
export type WorkjetManagedDeviceSessionIssueResult =
  typeof WorkjetManagedDeviceSessionIssueResult.Type;

/**
 * Managed pairing response. `workjet_session` is instance-scoped and resolves
 * current computer membership after pairing; it does not name one Environment.
 */
export const WorkjetDeviceInviteV2 = Schema.Struct({
  type: Schema.Literal("workjet-device-invite"),
  version: Schema.Literal(2),
  device_pairing_id: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  business_os_instance_id: BusinessOsInstanceId,
  workjet_session: Schema.Struct({
    issuer: WorkjetManagedIssuerOrigin,
    bootstrap_credential: WorkjetDeviceSessionBootstrapCredential,
    expires_at: Rfc3339Timestamp,
  }),
  business_os: CtoxBusinessOsInviteV1,
});
export type WorkjetDeviceInviteV2 = typeof WorkjetDeviceInviteV2.Type;

/**
 * One-time exchange of the bootstrap credential returned by managed redemption.
 * The credential is never a Clerk token or bearer token. The DPoP proof binds
 * the resulting session to the same installation key and instance edge.
 */
export const WorkjetDeviceSessionBootstrapExchangeInput = Schema.Struct({
  bootstrapCredential: WorkjetDeviceSessionBootstrapCredential,
  deviceId: WorkjetDeviceInviteRedeemInput.fields.deviceId,
  businessOsInstanceId: BusinessOsInstanceId,
});
export type WorkjetDeviceSessionBootstrapExchangeInput =
  typeof WorkjetDeviceSessionBootstrapExchangeInput.Type;

const WorkjetDeviceSessionAuthorizationFields = {
  tokenType: Schema.Literal("DPoP"),
  accessToken: WorkjetDeviceSessionAccessToken,
  refreshGrant: WorkjetDeviceSessionRefreshGrant,
  relayIssuer: WorkjetManagedIssuerOrigin,
  relayScopes: WorkjetDeviceSessionRelayScopes,
  businessOsInstanceId: BusinessOsInstanceId,
  deviceId: WorkjetDeviceInviteRedeemInput.fields.deviceId,
  expiresAt: Rfc3339Timestamp,
  refreshExpiresAt: Rfc3339Timestamp,
} as const;

export const WorkjetDeviceSessionBootstrapExchangeResult = Schema.Struct({
  ...WorkjetDeviceSessionAuthorizationFields,
});
export type WorkjetDeviceSessionBootstrapExchangeResult =
  typeof WorkjetDeviceSessionBootstrapExchangeResult.Type;

/**
 * Atomic rotation of the device-session refresh grant. The old grant becomes
 * unusable when this succeeds; both it and the new access token remain bound
 * to the original device, DPoP key and instance edge.
 */
export const WorkjetDeviceSessionRenewInput = Schema.Struct({
  refreshGrant: WorkjetDeviceSessionRefreshGrant,
  deviceId: WorkjetDeviceInviteRedeemInput.fields.deviceId,
  businessOsInstanceId: BusinessOsInstanceId,
});
export type WorkjetDeviceSessionRenewInput = typeof WorkjetDeviceSessionRenewInput.Type;

export const WorkjetDeviceSessionRenewResult = Schema.Struct({
  ...WorkjetDeviceSessionAuthorizationFields,
});
export type WorkjetDeviceSessionRenewResult = typeof WorkjetDeviceSessionRenewResult.Type;

/** DPoP-authenticated read of the current computers assigned to this instance. */
export const WorkjetDeviceSessionMembershipReadHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString.check(
    Schema.isMaxLength(8_192),
    Schema.isPattern(/^DPoP [^\s]+$/),
  ),
  dpop: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
});
export type WorkjetDeviceSessionMembershipReadHeaders =
  typeof WorkjetDeviceSessionMembershipReadHeaders.Type;

export const WorkjetDeviceSessionMembershipReadInput = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
});
export type WorkjetDeviceSessionMembershipReadInput =
  typeof WorkjetDeviceSessionMembershipReadInput.Type;

export const WorkjetDeviceSessionMembershipReadResult = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  membershipVersion: NonNegativeInt,
  environmentIds: Schema.Array(EnvironmentId).check(Schema.isMaxLength(1_000)),
});
export type WorkjetDeviceSessionMembershipReadResult =
  typeof WorkjetDeviceSessionMembershipReadResult.Type;

/** Private input to the native/managed CTOX synchronization invite issuer. */
export const WorkjetManagedCtoxSyncInviteIssueInput = Schema.Struct({
  ...WorkjetManagedDeviceProvisioningScope,
});
export type WorkjetManagedCtoxSyncInviteIssueInput =
  typeof WorkjetManagedCtoxSyncInviteIssueInput.Type;

export const WorkjetManagedCtoxSyncInviteIssueResult = Schema.Struct({
  grantId: WorkjetManagedProvisioningGrantId,
  businessOsInstanceId: BusinessOsInstanceId,
  deviceId: WorkjetDeviceInviteRedeemInput.fields.deviceId,
  proofKeyThumbprint: WorkjetDeviceInviteRedeemInput.fields.proofKeyThumbprint,
  invite: CtoxBusinessOsInviteV1,
  expiresAt: Rfc3339Timestamp,
});
export type WorkjetManagedCtoxSyncInviteIssueResult =
  typeof WorkjetManagedCtoxSyncInviteIssueResult.Type;

/** Private, idempotent revocation command understood by both managed issuers. */
export const WorkjetManagedProvisioningGrantRevokeInput = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  grantId: WorkjetManagedProvisioningGrantId,
});
export type WorkjetManagedProvisioningGrantRevokeInput =
  typeof WorkjetManagedProvisioningGrantRevokeInput.Type;

export const WorkjetManagedDeviceBindingState = Schema.Literals([
  "provisioning",
  "active",
  "revoking",
  "revoked",
]);
export type WorkjetManagedDeviceBindingState = typeof WorkjetManagedDeviceBindingState.Type;

/**
 * Durable, secret-free coordinator record. Credentials and invite payloads are
 * returned once to the redeemer and must never be stored in this record.
 */
export const WorkjetManagedDeviceBindingRecordV1 = Schema.Struct({
  type: Schema.Literal("workjet-managed-device-binding"),
  version: Schema.Literal(1),
  devicePairingId: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  deviceId: WorkjetDeviceInviteRedeemInput.fields.deviceId,
  proofKeyThumbprint: WorkjetDeviceInviteRedeemInput.fields.proofKeyThumbprint,
  businessOsInstanceId: BusinessOsInstanceId,
  deviceSessionGrantId: WorkjetManagedProvisioningGrantId,
  ctoxGrantId: WorkjetManagedProvisioningGrantId,
  state: WorkjetManagedDeviceBindingState,
  createdAt: Rfc3339Timestamp,
  revokedAt: Schema.NullOr(Rfc3339Timestamp),
});
export type WorkjetManagedDeviceBindingRecordV1 = typeof WorkjetManagedDeviceBindingRecordV1.Type;

/** Revokes one redeemed Workjet-installation-to-instance edge, not the whole device. */
export const WorkjetManagedDeviceBindingRevokeInput = Schema.Struct({
  ...WorkjetManagedBackendControlScope,
  devicePairingId: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
});
export type WorkjetManagedDeviceBindingRevokeInput =
  typeof WorkjetManagedDeviceBindingRevokeInput.Type;

/** Cookie-session CSRF and DPoP proof are both mandatory on every control request. */
export const WorkjetManagedBackendControlHeaders = Schema.Struct({
  dpop: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
  "x-workjet-csrf": TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
});
export type WorkjetManagedBackendControlHeaders = typeof WorkjetManagedBackendControlHeaders.Type;

export class WorkjetManagedBackendControlRejectedError extends Schema.TaggedErrorClass<WorkjetManagedBackendControlRejectedError>()(
  "WorkjetManagedBackendControlRejectedError",
  { code: Schema.Literal("managed_backend_control_rejected") },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetManagedBackendControlRejectedError)(this, {
      status: 403,
    });
  }
}

export class WorkjetManagedBackendControlExpiredError extends Schema.TaggedErrorClass<WorkjetManagedBackendControlExpiredError>()(
  "WorkjetManagedBackendControlExpiredError",
  { code: Schema.Literal("managed_backend_control_expired") },
  { httpApiStatus: 410 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetManagedBackendControlExpiredError)(this, {
      status: 410,
    });
  }
}

export class WorkjetManagedBackendControlUnavailableError extends Schema.TaggedErrorClass<WorkjetManagedBackendControlUnavailableError>()(
  "WorkjetManagedBackendControlUnavailableError",
  { code: Schema.Literal("managed_backend_control_unavailable") },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetManagedBackendControlUnavailableError)(this, {
      status: 503,
    });
  }
}

export class WorkjetManagedBackendControlRateLimitedError extends Schema.TaggedErrorClass<WorkjetManagedBackendControlRateLimitedError>()(
  "WorkjetManagedBackendControlRateLimitedError",
  { code: Schema.Literal("managed_backend_control_rate_limited") },
  { httpApiStatus: 429 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetManagedBackendControlRateLimitedError)(this, {
      status: 429,
    });
  }
}

const ManagedControlErrors = [
  WorkjetManagedBackendControlRejectedError,
  WorkjetManagedBackendControlExpiredError,
  WorkjetManagedBackendControlUnavailableError,
] as const;

export const WORKJET_MANAGED_BACKEND_CONTROL_RESOLVE_PATH =
  "/api/workjet/backend-control/connections";
export const WORKJET_MANAGED_DEVICE_CONTROL_RESOLVE_PATH =
  "/api/workjet/backend-control/device-connections";
export const WORKJET_MANAGED_DEVICE_CONTROL_CSRF_PATH = "/api/workjet/backend-control/device-csrf";
export const WORKJET_RELAY_CONTROL_IDENTITY_ASSERTION_PATH =
  "/api/workjet/device-session/control-assertion";
export const WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH =
  "/api/workjet/backend-control/device-bindings/list";
export const WORKJET_MANAGED_DEVICE_BINDINGS_REVOKE_PATH =
  "/api/workjet/backend-control/device-bindings/revoke";
export const WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH =
  "/api/workjet/backend-control/device-invites/create";
export const WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH =
  "/api/workjet/backend-control/device-invites/revoke";
export const WORKJET_MANAGED_DEVICE_INVITES_REDEEM_PATH = "/api/workjet/device-invites/redeem";
export const WORKJET_DEVICE_SESSION_BOOTSTRAP_EXCHANGE_PATH =
  "/api/workjet/device-session/exchange";
export const WORKJET_DEVICE_SESSION_RENEW_PATH = "/api/workjet/device-session/renew";
export const WORKJET_DEVICE_SESSION_MEMBERSHIP_READ_PATH =
  "/api/workjet/device-session/business-os/computers";

export class WorkjetManagedBackendControlHttpGroup extends HttpApiGroup.make(
  "managedBackendControl",
)
  .add(
    HttpApiEndpoint.post("resolveDeviceControl", WORKJET_MANAGED_DEVICE_CONTROL_RESOLVE_PATH, {
      headers: WorkjetManagedDeviceControlResolveHeaders,
      payload: WorkjetManagedDeviceControlResolveInput,
      success: WorkjetManagedBackendControlResolveResult,
      error: [...ManagedControlErrors, WorkjetManagedBackendControlRateLimitedError],
    }),
  )
  .add(
    HttpApiEndpoint.post("issueDeviceControlCsrf", WORKJET_MANAGED_DEVICE_CONTROL_CSRF_PATH, {
      headers: WorkjetManagedDeviceControlCsrfHeaders,
      payload: WorkjetManagedDeviceControlCsrfInput,
      success: WorkjetManagedControlCsrfResult,
      error: [...ManagedControlErrors, WorkjetManagedBackendControlRateLimitedError],
    }),
  )
  .add(
    HttpApiEndpoint.post("resolve", WORKJET_MANAGED_BACKEND_CONTROL_RESOLVE_PATH, {
      headers: WorkjetManagedBackendControlHeaders,
      payload: WorkjetManagedBackendControlResolveInput,
      success: WorkjetManagedBackendControlResolveResult,
      error: ManagedControlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("listDeviceBindings", WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH, {
      headers: WorkjetManagedBackendControlHeaders,
      payload: WorkjetManagedDeviceBindingListInput,
      success: WorkjetDeviceBindingListResult,
      error: ManagedControlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("revokeDeviceBinding", WORKJET_MANAGED_DEVICE_BINDINGS_REVOKE_PATH, {
      headers: WorkjetManagedBackendControlHeaders,
      payload: WorkjetManagedDeviceBindingRevokeInput,
      success: WorkjetDeviceInviteRevokeResult,
      error: ManagedControlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createDeviceInvite", WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH, {
      headers: WorkjetManagedBackendControlHeaders,
      payload: WorkjetManagedDeviceInviteCreateInput,
      success: WorkjetDeviceInviteCreateResult,
      error: ManagedControlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("revokeDeviceInvite", WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH, {
      headers: WorkjetManagedBackendControlHeaders,
      payload: WorkjetManagedDeviceInviteRevokeInput,
      success: WorkjetDeviceInviteRevokeResult,
      error: ManagedControlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("redeemDeviceInvite", WORKJET_MANAGED_DEVICE_INVITES_REDEEM_PATH, {
      headers: WorkjetManagedDeviceInviteRedeemHeaders,
      payload: WorkjetDeviceInviteRedeemInput,
      success: WorkjetDeviceInviteV2,
      error: [
        WorkjetDeviceInviteRedeemRejectedError,
        WorkjetDeviceInviteRedeemRateLimitedError,
        WorkjetManagedBackendControlUnavailableError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "exchangeDeviceSessionBootstrap",
      WORKJET_DEVICE_SESSION_BOOTSTRAP_EXCHANGE_PATH,
      {
        headers: WorkjetManagedDeviceInviteRedeemHeaders,
        payload: WorkjetDeviceSessionBootstrapExchangeInput,
        success: WorkjetDeviceSessionBootstrapExchangeResult,
        error: [
          WorkjetDeviceInviteRedeemRejectedError,
          WorkjetDeviceInviteRedeemRateLimitedError,
          WorkjetManagedBackendControlUnavailableError,
        ],
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("renewDeviceSession", WORKJET_DEVICE_SESSION_RENEW_PATH, {
      headers: WorkjetManagedDeviceInviteRedeemHeaders,
      payload: WorkjetDeviceSessionRenewInput,
      success: WorkjetDeviceSessionRenewResult,
      error: [
        WorkjetDeviceInviteRedeemRejectedError,
        WorkjetDeviceInviteRedeemRateLimitedError,
        WorkjetManagedBackendControlUnavailableError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "readDeviceSessionMembership",
      WORKJET_DEVICE_SESSION_MEMBERSHIP_READ_PATH,
      {
        headers: WorkjetDeviceSessionMembershipReadHeaders,
        payload: WorkjetDeviceSessionMembershipReadInput,
        success: WorkjetDeviceSessionMembershipReadResult,
        error: [
          WorkjetManagedBackendControlRejectedError,
          WorkjetManagedBackendControlUnavailableError,
        ],
      },
    ),
  ) {}

/**
 * Contract for the ctox.dev producer. It is intentionally not registered on
 * the local Workjet EnvironmentHttpApi: doing so would reintroduce the forbidden
 * Primary Environment / Code-computer fallback.
 */
export class WorkjetManagedBackendControlHttpApi extends HttpApi.make(
  "workjetManagedBackendControl",
).add(WorkjetManagedBackendControlHttpGroup) {}
