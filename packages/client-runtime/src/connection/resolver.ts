import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as BusinessOsManagedBackendControl from "../state/businessOsManagedBackendControl.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapManagedRelayError,
  profileMissingError,
} from "./errors.ts";
import type {
  BearerConnectionTarget,
  ConnectionTarget,
  PreparedConnection,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/resolver/ConnectionResolver") {}

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isSshProfile = Schema.is(SshConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

function primarySocketUrl(target: PrimaryConnectionTarget): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  return url.toString();
}

const makePrimaryBroker = Effect.fn("clientRuntime.connection.broker.makePrimary")(function* () {
  const auth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.primary")(function* (
    target: PrimaryConnectionTarget,
  ) {
    const bearerToken = yield* auth.bearerToken;
    if (Option.isNone(bearerToken)) {
      return {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: primarySocketUrl(target),
        httpAuthorization: null,
        target,
      } satisfies PreparedConnection;
    }

    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      bearerToken: bearerToken.value,
    });
    return {
      ...authorized,
      target,
    } satisfies PreparedConnection;
  });
});

const makeBearerBroker = Effect.fn("clientRuntime.connection.broker.makeBearer")(function* () {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.bearer")(function* (
    entry: ConnectionCatalogEntry & { readonly target: BearerConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Option.match(entry.profile, {
      onNone: () => Effect.fail(profileMissingError(target.connectionId)),
      onSome: Effect.succeed,
    });
    if (!isBearerProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not a bearer connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    const credential = yield* credentials.get(target.connectionId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(credentialMissingError(target.connectionId)),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (!isBearerCredential(credential)) {
      return yield* credentialMissingError(target.connectionId);
    }
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: profile.httpBaseUrl,
      wsBaseUrl: profile.wsBaseUrl,
      bearerToken: credential.token,
    });
    return {
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

const makeRelayBroker = Effect.fn("clientRuntime.connection.broker.makeRelay")(function* () {
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const session = yield* ClientCapabilities.CloudSession;
  const identity = yield* ClientCapabilities.RelayDeviceIdentity;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const managedAuthorizationProvider = yield* Effect.serviceOption(
    BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionAuthorizationProvider,
  );
  const managedDeviceSessionClient = yield* Effect.serviceOption(
    BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionClient,
  );

  const mapManagedSessionError = (
    error: BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionClientError,
  ): ConnectionAttemptError => {
    switch (error.code) {
      case "invalid_endpoint":
        return new ConnectionBlockedError({
          reason: "configuration",
          detail: "The Business OS device-session endpoint is invalid.",
        });
      case "authentication_failed":
      case "session_expired":
        return new ConnectionBlockedError({
          reason: "authentication",
          detail: "The Business OS device session must be renewed.",
        });
      case "permission_denied":
        return new ConnectionBlockedError({
          reason: "permission",
          detail: "The Business OS device session does not authorize this computer.",
        });
      case "request_failed":
        return new ConnectionTransientError({
          reason: "relay-unavailable",
          detail: "The Business OS device session could not authorize this computer.",
        });
    }
  };

  const managedServiceMissing = () =>
    new ConnectionBlockedError({
      reason: "authentication",
      detail: "This Workjet installation is not paired with the selected Business OS instance.",
    });

  const relayOriginsMatch = (left: string, right: string): boolean => {
    try {
      return new URL(left).origin === new URL(right).origin;
    } catch {
      return false;
    }
  };

  return Effect.fnUntraced(
    function* (target: RelayConnectionTarget) {
      const businessOsInstanceId = target.businessOsInstanceId;
      const managedSession =
        businessOsInstanceId === undefined
          ? undefined
          : yield* Effect.gen(function* () {
              if (
                Option.isNone(managedAuthorizationProvider) ||
                Option.isNone(managedDeviceSessionClient)
              ) {
                return yield* managedServiceMissing();
              }

              const authorization = yield* managedAuthorizationProvider.value
                .read({ businessOsInstanceId })
                .pipe(Effect.mapError(mapManagedSessionError));
              if (authorization.businessOsInstanceId !== businessOsInstanceId) {
                return yield* new ConnectionBlockedError({
                  reason: "permission",
                  detail: "The device session belongs to a different Business OS instance.",
                });
              }
              if (!relayOriginsMatch(authorization.relayIssuer, relay.relayUrl)) {
                return yield* new ConnectionBlockedError({
                  reason: "configuration",
                  detail: "The device session was issued for a different Workjet relay.",
                });
              }
              if (
                !authorization.relayScopes.includes(RelayEnvironmentConnectScope) ||
                !authorization.relayScopes.includes(RelayEnvironmentStatusScope)
              ) {
                return yield* new ConnectionBlockedError({
                  reason: "permission",
                  detail: "The device session does not grant the required computer access.",
                });
              }
              const nowMillis = yield* Clock.currentTimeMillis;
              const expiresAtMillis = Date.parse(authorization.expiresAt);
              if (!Number.isFinite(expiresAtMillis) || expiresAtMillis <= nowMillis + 5_000) {
                return yield* new ConnectionBlockedError({
                  reason: "authentication",
                  detail: "The Business OS device session has expired.",
                });
              }

              const membership =
                yield* BusinessOsManagedBackendControl.readManagedBusinessOsDeviceSessionMembership(
                  { authorization },
                ).pipe(
                  Effect.provideService(
                    BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionClient,
                    managedDeviceSessionClient.value,
                  ),
                  Effect.mapError(mapManagedSessionError),
                );
              if (membership.businessOsInstanceId !== businessOsInstanceId) {
                return yield* new ConnectionBlockedError({
                  reason: "permission",
                  detail: "The computer inventory belongs to a different Business OS instance.",
                });
              }
              if (!membership.environmentIds.includes(target.environmentId)) {
                return yield* new ConnectionBlockedError({
                  reason: "permission",
                  detail: "This computer is not assigned to the selected Business OS instance.",
                });
              }

              return { authorization, client: managedDeviceSessionClient.value };
            }).pipe(Effect.withSpan("relay.connection.managedSession.validate"));

      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
        ...(businessOsInstanceId === undefined
          ? {}
          : { authorizationContext: `business-os:${businessOsInstanceId}` }),
        obtainBootstrap: Effect.gen(function* () {
          if (managedSession !== undefined) {
            const connected =
              yield* BusinessOsManagedBackendControl.connectManagedWorkjetDeviceSessionEnvironment({
                authorization: managedSession.authorization,
                environmentId: target.environmentId,
              }).pipe(
                Effect.provideService(
                  BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionClient,
                  managedSession.client,
                ),
                Effect.mapError(mapManagedSessionError),
              );
            if (connected.environmentId !== target.environmentId) {
              return yield* environmentMismatchError({
                expected: target.environmentId,
                actual: connected.environmentId,
              });
            }
            return connected;
          }

          const clerkToken = yield* session.clerkToken.pipe(
            Effect.withSpan("relay.connection.cloudSessionToken.resolve"),
          );
          const deviceId = yield* identity.deviceId.pipe(
            Effect.withSpan("relay.connection.deviceIdentity.resolve"),
          );
          const connected = yield* relay
            .connectEnvironment({
              clerkToken,
              scopes: [RelayEnvironmentConnectScope],
              environmentId: target.environmentId,
              ...(Option.isSome(deviceId) ? { deviceId: deviceId.value } : {}),
            })
            .pipe(Effect.mapError(mapManagedRelayError));
          if (connected.environmentId !== target.environmentId) {
            return yield* environmentMismatchError({
              expected: target.environmentId,
              actual: connected.environmentId,
            });
          }
          return connected;
        }).pipe(Effect.withSpan("relay.connection.bootstrap.obtain")),
      });
      return {
        environmentId: authorized.environmentId,
        label: authorized.label,
        httpBaseUrl: authorized.httpBaseUrl,
        socketUrl: authorized.socketUrl,
        httpAuthorization: authorized.httpAuthorization,
        target,
      } satisfies PreparedConnection;
    },
    Effect.withSpan("clientRuntime.connection.broker.relay"),
    withRelayClientTracing,
  );
});

const makeSshBroker = Effect.fn("clientRuntime.connection.broker.makeSsh")(function* () {
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.ssh")(function* (
    entry: ConnectionCatalogEntry & { readonly target: SshConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Option.match(entry.profile, {
      onNone: () => Effect.fail(profileMissingError(target.connectionId)),
      onSome: Effect.succeed,
    });
    if (!isSshProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not an SSH connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    const prepared = yield* ssh.prepare({
      connectionId: target.connectionId,
      expectedEnvironmentId: target.environmentId,
      target: profile.target,
    });
    yield* profiles.put(
      new SshConnectionProfile({
        connectionId: profile.connectionId,
        environmentId: profile.environmentId,
        label: profile.label,
        target: prepared.bootstrap.target,
      }),
    );
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: prepared.bootstrap.httpBaseUrl,
      wsBaseUrl: prepared.bootstrap.wsBaseUrl,
      bearerToken: prepared.bearerToken,
    });
    return {
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

export const make = Effect.gen(function* () {
  const primary = yield* makePrimaryBroker();
  const bearer = yield* makeBearerBroker();
  const relay = yield* makeRelayBroker();
  const ssh = yield* makeSshBroker();

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target: ConnectionTarget = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    switch (target._tag) {
      case "PrimaryConnectionTarget":
        return yield* primary(target);
      case "BearerConnectionTarget":
        return yield* bearer({ ...entry, target });
      case "RelayConnectionTarget":
        return yield* relay(target);
      case "SshConnectionTarget":
        return yield* ssh({ ...entry, target });
    }
  });

  return ConnectionResolver.of({ prepare });
});

export const layer = Layer.effect(ConnectionResolver, make);
