import type {
  BusinessOsInstanceId,
  WorkjetDeviceBindingListResult,
  WorkjetDeviceInviteCreateResult,
  WorkjetDeviceInviteRedeemInput,
  WorkjetDeviceInviteRefV1,
  WorkjetDeviceInviteRevokeResult,
  WorkjetDeviceInviteV2,
  WorkjetDeviceSessionBootstrapExchangeInput,
  WorkjetDeviceSessionBootstrapExchangeResult,
  WorkjetDeviceSessionMembershipReadInput,
  WorkjetDeviceSessionMembershipReadResult,
  WorkjetDeviceSessionRenewInput,
  WorkjetDeviceSessionRenewResult,
  WorkjetManagedIssuerOrigin,
  WorkjetManagedBackendControlResolveInput,
  WorkjetManagedBackendControlResolveResult,
  WorkjetManagedDeviceBindingListInput,
  WorkjetManagedDeviceBindingRevokeInput,
  WorkjetManagedDeviceInviteCreateInput,
  WorkjetManagedDeviceInviteRevokeInput,
  WorkjetRelayControlIdentityAssertionIssueInput,
  WorkjetRelayControlIdentityAssertionIssueResult,
} from "@t3tools/contracts";
import {
  WORKJET_DEVICE_SESSION_BOOTSTRAP_EXCHANGE_PATH,
  WORKJET_DEVICE_SESSION_MEMBERSHIP_READ_PATH,
  WORKJET_DEVICE_SESSION_RENEW_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_REDEEM_PATH,
  WORKJET_RELAY_CONTROL_IDENTITY_ASSERTION_PATH,
} from "@t3tools/contracts";
import type { RelayEnvironmentConnectResponse } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class WorkjetManagedBackendControlClientError extends Data.TaggedError(
  "WorkjetManagedBackendControlClientError",
)<{
  readonly operation: "resolve" | "list" | "create" | "revoke";
  readonly message: string;
}> {}

/**
 * Platform adapter for the managed ctox.dev control plane.
 *
 * Desktop implements this in Electron main with its authenticated account
 * session; Mobile implements it with its own Workjet account + DPoP session.
 * The port intentionally has no Environment or Computer identifier, so callers
 * cannot route managed device operations through a Code worker by accident.
 */
export class WorkjetManagedBackendControlClient extends Context.Service<
  WorkjetManagedBackendControlClient,
  {
    readonly resolve: (
      input: WorkjetManagedBackendControlResolveInput,
    ) => Effect.Effect<
      WorkjetManagedBackendControlResolveResult,
      WorkjetManagedBackendControlClientError
    >;
    readonly listDeviceBindings: (
      input: WorkjetManagedDeviceBindingListInput,
    ) => Effect.Effect<WorkjetDeviceBindingListResult, WorkjetManagedBackendControlClientError>;
    readonly createDeviceInvite: (
      input: WorkjetManagedDeviceInviteCreateInput,
    ) => Effect.Effect<WorkjetDeviceInviteCreateResult, WorkjetManagedBackendControlClientError>;
    readonly revokeDeviceInvite: (
      input: WorkjetManagedDeviceInviteRevokeInput,
    ) => Effect.Effect<WorkjetDeviceInviteRevokeResult, WorkjetManagedBackendControlClientError>;
    readonly revokeDeviceBinding: (
      input: WorkjetManagedDeviceBindingRevokeInput,
    ) => Effect.Effect<WorkjetDeviceInviteRevokeResult, WorkjetManagedBackendControlClientError>;
  }
>()(
  "@t3tools/client-runtime/state/businessOsManagedBackendControl/WorkjetManagedBackendControlClient",
) {}

export const resolveManagedBusinessOsBackendControl = (
  input: WorkjetManagedBackendControlResolveInput,
): Effect.Effect<
  WorkjetManagedBackendControlResolveResult,
  WorkjetManagedBackendControlClientError,
  WorkjetManagedBackendControlClient
> => Effect.flatMap(WorkjetManagedBackendControlClient, (client) => client.resolve(input));

export const listManagedWorkjetDeviceBindings = (
  input: WorkjetManagedDeviceBindingListInput,
): Effect.Effect<
  WorkjetDeviceBindingListResult,
  WorkjetManagedBackendControlClientError,
  WorkjetManagedBackendControlClient
> =>
  Effect.flatMap(WorkjetManagedBackendControlClient, (client) => client.listDeviceBindings(input));

export const createManagedWorkjetDeviceInvite = (
  input: WorkjetManagedDeviceInviteCreateInput,
): Effect.Effect<
  WorkjetDeviceInviteCreateResult,
  WorkjetManagedBackendControlClientError,
  WorkjetManagedBackendControlClient
> =>
  Effect.flatMap(WorkjetManagedBackendControlClient, (client) => client.createDeviceInvite(input));

export const revokeManagedWorkjetDeviceInvite = (
  input: WorkjetManagedDeviceInviteRevokeInput,
): Effect.Effect<
  WorkjetDeviceInviteRevokeResult,
  WorkjetManagedBackendControlClientError,
  WorkjetManagedBackendControlClient
> =>
  Effect.flatMap(WorkjetManagedBackendControlClient, (client) => client.revokeDeviceInvite(input));

export const revokeManagedWorkjetDeviceBinding = (
  input: WorkjetManagedDeviceBindingRevokeInput,
): Effect.Effect<
  WorkjetDeviceInviteRevokeResult,
  WorkjetManagedBackendControlClientError,
  WorkjetManagedBackendControlClient
> =>
  Effect.flatMap(WorkjetManagedBackendControlClient, (client) => client.revokeDeviceBinding(input));

export type WorkjetManagedDeviceSessionOperation =
  | "identity"
  | "connect"
  | "redeem"
  | "exchange"
  | "renew"
  | "membership";

/**
 * Sanitized failure returned by the platform adapter. It deliberately carries
 * neither a request payload nor an underlying exception because both may hold
 * a bootstrap credential or DPoP-bound session token.
 */
export class WorkjetManagedDeviceSessionClientError extends Data.TaggedError(
  "WorkjetManagedDeviceSessionClientError",
)<{
  readonly operation: WorkjetManagedDeviceSessionOperation;
  readonly code:
    | "invalid_endpoint"
    | "authentication_failed"
    | "permission_denied"
    | "session_expired"
    | "request_failed";
}> {}

export interface WorkjetManagedDeviceSessionRequestTarget {
  readonly method: "POST";
  readonly url: string;
}

export interface WorkjetManagedDeviceInviteRedeemRequest {
  readonly target: WorkjetManagedDeviceSessionRequestTarget;
  readonly payload: WorkjetDeviceInviteRedeemInput;
}

export interface WorkjetManagedDeviceSessionBootstrapExchangeRequest {
  readonly target: WorkjetManagedDeviceSessionRequestTarget;
  readonly payload: WorkjetDeviceSessionBootstrapExchangeInput;
}

export interface WorkjetManagedDeviceSessionMembershipReadRequest {
  readonly target: WorkjetManagedDeviceSessionRequestTarget;
  readonly accessToken: WorkjetDeviceSessionBootstrapExchangeResult["accessToken"];
  readonly payload: WorkjetDeviceSessionMembershipReadInput;
}

export interface WorkjetManagedDeviceSessionRenewRequest {
  readonly target: WorkjetManagedDeviceSessionRequestTarget;
  readonly payload: WorkjetDeviceSessionRenewInput;
}

export interface WorkjetManagedDeviceSessionEnvironmentConnectRequest {
  readonly relayIssuer: WorkjetManagedIssuerOrigin;
  readonly accessToken: WorkjetDeviceSessionBootstrapExchangeResult["accessToken"];
  readonly environmentId: RelayEnvironmentConnectResponse["environmentId"];
  readonly deviceId: WorkjetDeviceSessionBootstrapExchangeResult["deviceId"];
  readonly businessOsInstanceId: BusinessOsInstanceId;
}

export interface WorkjetRelayControlIdentityAssertionIssueRequest {
  readonly target: WorkjetManagedDeviceSessionRequestTarget;
  readonly payload: WorkjetRelayControlIdentityAssertionIssueInput;
}

/**
 * DPoP-bound Workjet installation session for one Business OS instance.
 * Platform secure storage may persist this value; it is not a Clerk session
 * and it never contains per-computer bootstrap credentials.
 */
export interface WorkjetManagedDeviceSessionAuthorization {
  /** Producer for session exchange and authoritative membership reads. */
  readonly sessionIssuer: WorkjetManagedIssuerOrigin;
  /** Relay issuer that accepts this DPoP token for assigned environments. */
  readonly relayIssuer: WorkjetDeviceSessionBootstrapExchangeResult["relayIssuer"];
  readonly relayScopes: WorkjetDeviceSessionBootstrapExchangeResult["relayScopes"];
  readonly tokenType: "DPoP";
  readonly accessToken: WorkjetDeviceSessionBootstrapExchangeResult["accessToken"];
  readonly expiresAt: WorkjetDeviceSessionBootstrapExchangeResult["expiresAt"];
  readonly refreshGrant: WorkjetDeviceSessionBootstrapExchangeResult["refreshGrant"];
  readonly refreshExpiresAt: WorkjetDeviceSessionBootstrapExchangeResult["refreshExpiresAt"];
  readonly businessOsInstanceId: BusinessOsInstanceId;
  readonly deviceId: WorkjetDeviceSessionBootstrapExchangeResult["deviceId"];
}

/**
 * Platform-owned DPoP transport for managed pairing and device sessions.
 *
 * Implementations MUST create a fresh DPoP proof for `target.method` and
 * `target.url`. Membership proofs additionally bind `accessToken` through the
 * JWT `ath` claim. The adapter may keep its proof key and session token in the
 * platform secure store, but this shared runtime never logs or persists them.
 */
export class WorkjetManagedDeviceSessionClient extends Context.Service<
  WorkjetManagedDeviceSessionClient,
  {
    readonly issueControlIdentityAssertion: (
      request: WorkjetRelayControlIdentityAssertionIssueRequest,
    ) => Effect.Effect<
      WorkjetRelayControlIdentityAssertionIssueResult,
      WorkjetManagedDeviceSessionClientError
    >;
    /** Creates a fresh ath-bound DPoP proof and calls the Relay connect endpoint directly. */
    readonly connectEnvironment: (
      request: WorkjetManagedDeviceSessionEnvironmentConnectRequest,
    ) => Effect.Effect<RelayEnvironmentConnectResponse, WorkjetManagedDeviceSessionClientError>;
    readonly redeemDeviceInvite: (
      request: WorkjetManagedDeviceInviteRedeemRequest,
    ) => Effect.Effect<WorkjetDeviceInviteV2, WorkjetManagedDeviceSessionClientError>;
    readonly exchangeDeviceSessionBootstrap: (
      request: WorkjetManagedDeviceSessionBootstrapExchangeRequest,
    ) => Effect.Effect<
      WorkjetDeviceSessionBootstrapExchangeResult,
      WorkjetManagedDeviceSessionClientError
    >;
    readonly renewDeviceSession: (
      request: WorkjetManagedDeviceSessionRenewRequest,
    ) => Effect.Effect<WorkjetDeviceSessionRenewResult, WorkjetManagedDeviceSessionClientError>;
    readonly readDeviceSessionMembership: (
      request: WorkjetManagedDeviceSessionMembershipReadRequest,
    ) => Effect.Effect<
      WorkjetDeviceSessionMembershipReadResult,
      WorkjetManagedDeviceSessionClientError
    >;
  }
>()(
  "@t3tools/client-runtime/state/businessOsManagedBackendControl/WorkjetManagedDeviceSessionClient",
) {}

/** Obtains the Relay-signed, DPoP-bound identity assertion consumed by ctox.dev resolve. */
export const issueManagedRelayControlIdentityAssertion = (input: {
  readonly relayIssuer: WorkjetManagedIssuerOrigin;
  readonly payload: WorkjetRelayControlIdentityAssertionIssueInput;
}): Effect.Effect<
  WorkjetRelayControlIdentityAssertionIssueResult,
  WorkjetManagedDeviceSessionClientError,
  WorkjetManagedDeviceSessionClient
> =>
  Effect.gen(function* () {
    const url = yield* managedDeviceSessionRequestUrl(
      input.relayIssuer,
      WORKJET_RELAY_CONTROL_IDENTITY_ASSERTION_PATH,
      "identity",
    );
    const client = yield* WorkjetManagedDeviceSessionClient;
    return yield* client.issueControlIdentityAssertion({
      target: { method: "POST", url },
      payload: input.payload,
    });
  });

/**
 * Platform secure-session adapter. Mobile can back this with SecureStore and
 * Desktop with its main-process secret store; no account/Clerk dependency is
 * part of this shared contract.
 */
export class WorkjetManagedDeviceSessionAuthorizationProvider extends Context.Service<
  WorkjetManagedDeviceSessionAuthorizationProvider,
  {
    readonly read: (input: {
      readonly businessOsInstanceId: BusinessOsInstanceId;
    }) => Effect.Effect<
      WorkjetManagedDeviceSessionAuthorization,
      WorkjetManagedDeviceSessionClientError
    >;
  }
>()(
  "@t3tools/client-runtime/state/businessOsManagedBackendControl/WorkjetManagedDeviceSessionAuthorizationProvider",
) {}

function isExactLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "[::1]" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function managedDeviceSessionRequestUrl(
  endpoint: string,
  path: string,
  operation: WorkjetManagedDeviceSessionOperation,
): Effect.Effect<string, WorkjetManagedDeviceSessionClientError> {
  try {
    const base = new URL(endpoint);
    const isAllowedProtocol =
      base.protocol === "https:" ||
      (base.protocol === "http:" && isExactLoopbackHostname(base.hostname));
    if (
      !isAllowedProtocol ||
      base.username !== "" ||
      base.password !== "" ||
      base.search !== "" ||
      base.hash !== "" ||
      base.pathname !== "/"
    ) {
      return Effect.fail(
        new WorkjetManagedDeviceSessionClientError({ operation, code: "invalid_endpoint" }),
      );
    }
    return Effect.succeed(new URL(path, base).toString());
  } catch {
    return Effect.fail(
      new WorkjetManagedDeviceSessionClientError({ operation, code: "invalid_endpoint" }),
    );
  }
}

/** Redeems one compact reference into the instance-scoped Workjet/CTOX invite. */
export const redeemManagedWorkjetDeviceInviteReference = (input: {
  readonly reference: WorkjetDeviceInviteRefV1;
  readonly deviceId: WorkjetDeviceInviteRedeemInput["deviceId"];
  readonly proofKeyThumbprint: WorkjetDeviceInviteRedeemInput["proofKeyThumbprint"];
}): Effect.Effect<
  WorkjetDeviceInviteV2,
  WorkjetManagedDeviceSessionClientError,
  WorkjetManagedDeviceSessionClient
> =>
  Effect.gen(function* () {
    const url = yield* managedDeviceSessionRequestUrl(
      input.reference.endpoint,
      WORKJET_MANAGED_DEVICE_INVITES_REDEEM_PATH,
      "redeem",
    );
    const client = yield* WorkjetManagedDeviceSessionClient;
    return yield* client.redeemDeviceInvite({
      target: { method: "POST", url },
      payload: {
        code: input.reference.code,
        deviceId: input.deviceId,
        proofKeyThumbprint: input.proofKeyThumbprint,
      },
    });
  });

/**
 * Exchanges the one-time bootstrap credential for a short-lived DPoP session.
 * The bootstrap credential is not a bearer/Clerk credential and is never
 * returned from this helper after the exchange.
 */
export const exchangeManagedWorkjetDeviceSessionBootstrap = (input: {
  readonly issuer: WorkjetManagedIssuerOrigin;
  readonly bootstrapCredential: WorkjetDeviceSessionBootstrapExchangeInput["bootstrapCredential"];
  readonly deviceId: WorkjetDeviceSessionBootstrapExchangeInput["deviceId"];
  readonly businessOsInstanceId: BusinessOsInstanceId;
}): Effect.Effect<
  WorkjetDeviceSessionBootstrapExchangeResult,
  WorkjetManagedDeviceSessionClientError,
  WorkjetManagedDeviceSessionClient
> =>
  Effect.gen(function* () {
    const url = yield* managedDeviceSessionRequestUrl(
      input.issuer,
      WORKJET_DEVICE_SESSION_BOOTSTRAP_EXCHANGE_PATH,
      "exchange",
    );
    const client = yield* WorkjetManagedDeviceSessionClient;
    return yield* client.exchangeDeviceSessionBootstrap({
      target: { method: "POST", url },
      payload: {
        bootstrapCredential: input.bootstrapCredential,
        deviceId: input.deviceId,
        businessOsInstanceId: input.businessOsInstanceId,
      },
    });
  });

export const toManagedWorkjetDeviceSessionAuthorization = (
  sessionIssuer: WorkjetManagedIssuerOrigin,
  exchange: WorkjetDeviceSessionBootstrapExchangeResult,
): WorkjetManagedDeviceSessionAuthorization => ({
  sessionIssuer,
  relayIssuer: exchange.relayIssuer,
  relayScopes: exchange.relayScopes,
  tokenType: exchange.tokenType,
  accessToken: exchange.accessToken,
  expiresAt: exchange.expiresAt,
  refreshGrant: exchange.refreshGrant,
  refreshExpiresAt: exchange.refreshExpiresAt,
  businessOsInstanceId: exchange.businessOsInstanceId,
  deviceId: exchange.deviceId,
});

/** Minimal adapter input for ManagedRelay; no Clerk token or raw credentials. */
export const toManagedRelayDeviceSessionAuthorization = (
  authorization: WorkjetManagedDeviceSessionAuthorization,
) => ({
  issuer: authorization.relayIssuer,
  tokenType: authorization.tokenType,
  accessToken: authorization.accessToken,
  scopes: authorization.relayScopes,
  expiresAt: authorization.expiresAt,
  businessOsInstanceId: authorization.businessOsInstanceId,
  deviceId: authorization.deviceId,
});

export const connectManagedWorkjetDeviceSessionEnvironment = (input: {
  readonly authorization: WorkjetManagedDeviceSessionAuthorization;
  readonly environmentId: RelayEnvironmentConnectResponse["environmentId"];
}): Effect.Effect<
  RelayEnvironmentConnectResponse,
  WorkjetManagedDeviceSessionClientError,
  WorkjetManagedDeviceSessionClient
> =>
  Effect.flatMap(WorkjetManagedDeviceSessionClient, (client) =>
    client.connectEnvironment({
      relayIssuer: input.authorization.relayIssuer,
      accessToken: input.authorization.accessToken,
      environmentId: input.environmentId,
      deviceId: input.authorization.deviceId,
      businessOsInstanceId: input.authorization.businessOsInstanceId,
    }),
  );

/**
 * Rotates the opaque refresh grant. The platform adapter owns the atomic secure
 * storage replacement; this runtime never logs or retains either grant.
 */
export const renewManagedWorkjetDeviceSession = (input: {
  readonly authorization: WorkjetManagedDeviceSessionAuthorization;
}): Effect.Effect<
  WorkjetManagedDeviceSessionAuthorization,
  WorkjetManagedDeviceSessionClientError,
  WorkjetManagedDeviceSessionClient
> =>
  Effect.gen(function* () {
    const url = yield* managedDeviceSessionRequestUrl(
      input.authorization.sessionIssuer,
      WORKJET_DEVICE_SESSION_RENEW_PATH,
      "renew",
    );
    const client = yield* WorkjetManagedDeviceSessionClient;
    const renewed = yield* client.renewDeviceSession({
      target: { method: "POST", url },
      payload: {
        refreshGrant: input.authorization.refreshGrant,
        deviceId: input.authorization.deviceId,
        businessOsInstanceId: input.authorization.businessOsInstanceId,
      },
    });
    return toManagedWorkjetDeviceSessionAuthorization(input.authorization.sessionIssuer, renewed);
  });

export const readManagedWorkjetDeviceSessionAuthorization = (input: {
  readonly businessOsInstanceId: BusinessOsInstanceId;
}): Effect.Effect<
  WorkjetManagedDeviceSessionAuthorization,
  WorkjetManagedDeviceSessionClientError,
  WorkjetManagedDeviceSessionAuthorizationProvider
> =>
  Effect.flatMap(WorkjetManagedDeviceSessionAuthorizationProvider, (provider) =>
    provider.read(input),
  );

/** Reads the current 0..N Code-computer membership for one paired instance. */
export const readManagedBusinessOsDeviceSessionMembership = (input: {
  readonly authorization: WorkjetManagedDeviceSessionAuthorization;
}): Effect.Effect<
  WorkjetDeviceSessionMembershipReadResult,
  WorkjetManagedDeviceSessionClientError,
  WorkjetManagedDeviceSessionClient
> =>
  Effect.gen(function* () {
    const url = yield* managedDeviceSessionRequestUrl(
      input.authorization.sessionIssuer,
      WORKJET_DEVICE_SESSION_MEMBERSHIP_READ_PATH,
      "membership",
    );
    const client = yield* WorkjetManagedDeviceSessionClient;
    return yield* client.readDeviceSessionMembership({
      target: { method: "POST", url },
      accessToken: input.authorization.accessToken,
      payload: { businessOsInstanceId: input.authorization.businessOsInstanceId },
    });
  });
