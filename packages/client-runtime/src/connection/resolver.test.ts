import {
  BusinessOsInstanceId,
  EnvironmentId,
  type DesktopSshEnvironmentTarget,
  type WorkjetDeviceSessionAccessToken,
  type WorkjetDeviceSessionRefreshGrant,
  type WorkjetManagedIssuerOrigin,
} from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@t3tools/contracts/relay";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Tracer from "effect/Tracer";

import * as ManagedRelay from "../relay/managedRelay.ts";
import * as BusinessOsManagedBackendControl from "../state/businessOsManagedBackendControl.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  ConnectionBlockedError,
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const BUSINESS_OS_INSTANCE_ID = BusinessOsInstanceId.make("biz_welsch");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
  providerKind: "cloudflare_tunnel" as const,
};
const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "development",
  hostname: "development.example.test",
  username: "developer",
  port: 22,
};

function catalogEntry(
  target: ConnectionTarget,
  profile: Option.Option<ConnectionProfile> = Option.none(),
): ConnectionCatalogEntry {
  return { target, profile };
}

function unsupported<A>(name: string): Effect.Effect<A> {
  return Effect.die(new Error(`Unexpected relay call: ${name}`));
}

function collectingTracer(spans: Array<string>): Tracer.Tracer {
  return Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        spans.push(span.name);
      };
      return span;
    },
  });
}

function relayClient(
  connectEnvironment: ManagedRelay.ManagedRelayClient["Service"]["connectEnvironment"],
) {
  return ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.example.test",
    listEnvironments: () => unsupported("listEnvironments"),
    listDevices: () => unsupported("listDevices"),
    createEnvironmentLinkChallenge: () => unsupported("createEnvironmentLinkChallenge"),
    linkEnvironment: () => unsupported("linkEnvironment"),
    unlinkEnvironment: () => unsupported("unlinkEnvironment"),
    getEnvironmentStatus: () => unsupported("getEnvironmentStatus"),
    connectEnvironment,
    issueWorkjetControlIdentityAssertion: () => unsupported("issueWorkjetControlIdentityAssertion"),
    registerDevice: () => unsupported("registerDevice"),
    unregisterDevice: () => unsupported("unregisterDevice"),
    registerLiveActivity: () => unsupported("registerLiveActivity"),
    getAgentActivitySnapshot: () => unsupported("getAgentActivitySnapshot"),
    resetTokenCache: Effect.void,
  });
}

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly profiles?: ReadonlyArray<ConnectionProfile>;
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
  readonly connectEnvironment?: ManagedRelay.ManagedRelayClient["Service"]["connectEnvironment"];
  readonly authorizeBearer?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly authorizeDpop?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeDpop"];
  readonly primaryBearerToken?: string;
  readonly prepareSsh?: ClientCapabilities.SshEnvironmentGateway["Service"]["prepare"];
  readonly cloudSessionToken?: Effect.Effect<string>;
  readonly managedAuthorizationProvider?: BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionAuthorizationProvider["Service"];
  readonly managedDeviceSessionClient?: BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionClient["Service"];
}) => {
  const profiles = new Map(
    (options?.profiles ?? []).map((profile) => [profile.connectionId, profile]),
  );
  const credentials = new Map(options?.credentials ?? []);

  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      Effect.sync(() => void credentials.set(connectionId, credential)),
    remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
  });
  const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer:
      options?.authorizeBearer ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized bearer environment",
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=bearer",
          httpAuthorization: {
            _tag: "Bearer" as const,
            token: input.bearerToken,
          },
        })),
    authorizeDpop:
      options?.authorizeDpop ??
      ((input) =>
        input.obtainBootstrap.pipe(
          Effect.as({
            environmentId: input.expectedEnvironmentId,
            label: "Authorized relay environment",
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            socketUrl: "wss://authorized.example.test/ws?wsTicket=dpop",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: "dpop-access-token",
            },
          }),
        )),
  });
  const ssh = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die("unused"),
    prepare:
      options?.prepareSsh ??
      (() =>
        Effect.succeed({
          bootstrap: {
            target: SSH_TARGET,
            httpBaseUrl: "http://127.0.0.1:4010",
            wsBaseUrl: "ws://127.0.0.1:4010",
            pairingToken: null,
          },
          bearerToken: "ssh-bearer",
        })),
    disconnect: () => Effect.void,
  });

  const dependencies = Layer.mergeAll(
    Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
    Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
    Layer.succeed(
      ClientCapabilities.CloudSession,
      ClientCapabilities.CloudSession.of({
        clerkToken: options?.cloudSessionToken ?? Effect.succeed("clerk-session"),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeed(Option.fromNullishOr(options?.primaryBearerToken)),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.RelayDeviceIdentity,
      ClientCapabilities.RelayDeviceIdentity.of({
        deviceId: Effect.succeed(Option.some("device-1")),
      }),
    ),
    Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
    Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
    Layer.succeed(
      ManagedRelay.ManagedRelayClient,
      relayClient(
        options?.connectEnvironment ??
          ((input) =>
            Effect.succeed({
              environmentId: input.environmentId,
              endpoint: ENDPOINT,
              credential: "relay-bootstrap",
              expiresAt: "2026-06-06T00:00:00.000Z",
            })),
      ),
    ),
    options?.managedAuthorizationProvider === undefined
      ? Layer.empty
      : Layer.succeed(
          BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionAuthorizationProvider,
          options.managedAuthorizationProvider,
        ),
    options?.managedDeviceSessionClient === undefined
      ? Layer.empty
      : Layer.succeed(
          BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionClient,
          options.managedDeviceSessionClient,
        ),
  );

  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provide(dependencies)));
});

const MANAGED_AUTHORIZATION = {
  sessionIssuer: "https://managed.example.test" as WorkjetManagedIssuerOrigin,
  relayIssuer: "https://relay.example.test" as WorkjetManagedIssuerOrigin,
  relayScopes: [RelayEnvironmentConnectScope, RelayEnvironmentStatusScope],
  tokenType: "DPoP" as const,
  accessToken: "s".repeat(43) as WorkjetDeviceSessionAccessToken,
  refreshGrant: "g".repeat(43) as WorkjetDeviceSessionRefreshGrant,
  expiresAt: "2099-08-27T04:00:00Z",
  refreshExpiresAt: "2099-09-27T04:00:00Z",
  businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
  deviceId: "desktop-michael",
} satisfies BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionAuthorization;

function managedDeviceSessionClient(options?: {
  readonly connectEnvironment?: BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionClient["Service"]["connectEnvironment"];
  readonly readDeviceSessionMembership?: BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionClient["Service"]["readDeviceSessionMembership"];
}) {
  return BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionClient.of({
    issueControlIdentityAssertion: () => unsupported("issueControlIdentityAssertion"),
    connectEnvironment:
      options?.connectEnvironment ?? (() => unsupported("managed connectEnvironment")),
    redeemDeviceInvite: () => unsupported("redeemDeviceInvite"),
    exchangeDeviceSessionBootstrap: () => unsupported("exchangeDeviceSessionBootstrap"),
    renewDeviceSession: () => unsupported("renewDeviceSession"),
    readDeviceSessionMembership:
      options?.readDeviceSessionMembership ?? (() => unsupported("readDeviceSessionMembership")),
  });
}

describe("ConnectionResolver", () => {
  it.effect("prepares a primary environment without remote capabilities", () =>
    Effect.gen(function* () {
      const brokerLayer = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        socketUrl: "ws://127.0.0.1:3777/ws",
        httpAuthorization: null,
        target,
      });
    }),
  );

  it.effect("authorizes a desktop primary environment with its platform bearer token", () =>
    Effect.gen(function* () {
      const bearerInputs = yield* Ref.make<ReadonlyArray<string>>([]);
      const brokerLayer = yield* makeDependencies({
        primaryBearerToken: "desktop-bearer",
        authorizeBearer: (input) =>
          Ref.update(bearerInputs, (values) => [...values, input.bearerToken]).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Primary",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "ws://127.0.0.1:3777/ws?wsTicket=desktop",
              httpAuthorization: {
                _tag: "Bearer" as const,
                token: input.bearerToken,
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toMatchObject({
        socketUrl: "ws://127.0.0.1:3777/ws?wsTicket=desktop",
        httpAuthorization: { _tag: "Bearer", token: "desktop-bearer" },
        target,
      });
      expect(yield* Ref.get(bearerInputs)).toEqual(["desktop-bearer"]);
    }),
  );

  it.effect("uses the registered bearer profile without re-reading the profile store", () =>
    Effect.gen(function* () {
      const bearerInputs = yield* Ref.make<ReadonlyArray<string>>([]);
      const target = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Saved",
        connectionId: "saved-1",
      });
      const profile = new BearerConnectionProfile({
        connectionId: "saved-1",
        environmentId: ENVIRONMENT_ID,
        label: "Saved",
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      });
      const brokerLayer = yield* makeDependencies({
        credentials: [["saved-1", new BearerConnectionCredential({ token: "secret-bearer" })]],
        authorizeBearer: (input) =>
          Ref.update(bearerInputs, (values) => [...values, input.bearerToken]).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Saved",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=ticket",
              httpAuthorization: {
                _tag: "Bearer" as const,
                token: input.bearerToken,
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      expect(
        (yield* broker.prepare(catalogEntry(target, Option.some(profile)))).socketUrl,
      ).toContain("wsTicket=ticket");
      expect(yield* Ref.get(bearerInputs)).toEqual(["secret-bearer"]);
    }),
  );

  it.effect("brokers relay credentials with the current cloud session and device identity", () =>
    Effect.gen(function* () {
      const relayInputs = yield* Ref.make<
        ReadonlyArray<{
          readonly clerkToken: string;
          readonly scopes: ReadonlyArray<string>;
          readonly deviceId?: string;
        }>
      >([]);
      const bootstrapCredentials = yield* Ref.make<ReadonlyArray<string>>([]);
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Cloud",
      });
      const brokerLayer = yield* makeDependencies({
        connectEnvironment: (input) =>
          Ref.update(relayInputs, (values) => [
            ...values,
            {
              clerkToken: input.clerkToken,
              scopes: input.scopes,
              ...(input.deviceId ? { deviceId: input.deviceId } : {}),
            },
          ]).pipe(
            Effect.as({
              environmentId: input.environmentId,
              endpoint: ENDPOINT,
              credential: "relay-bootstrap",
              expiresAt: "2026-06-06T00:00:00.000Z",
            }),
          ),
        authorizeDpop: (input) =>
          input.obtainBootstrap.pipe(
            Effect.tap((bootstrap) =>
              Ref.update(bootstrapCredentials, (values) => [...values, bootstrap.credential]),
            ),
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Cloud",
              httpBaseUrl: ENDPOINT.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=dpop",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: "dpop-access-token",
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      expect((yield* broker.prepare(catalogEntry(target))).socketUrl).toContain("wsTicket=dpop");
      expect(yield* Ref.get(relayInputs)).toEqual([
        {
          clerkToken: "clerk-session",
          scopes: [RelayEnvironmentConnectScope],
          deviceId: "device-1",
        },
      ]);
      expect(yield* Ref.get(bootstrapCredentials)).toEqual(["relay-bootstrap"]);
    }),
  );

  it.effect(
    "uses the exact Business OS device session and authoritative membership for a scoped relay target",
    () =>
      Effect.gen(function* () {
        const providerInputs = yield* Ref.make<ReadonlyArray<string>>([]);
        const membershipInputs = yield* Ref.make<ReadonlyArray<string>>([]);
        const connectInputs = yield* Ref.make<
          ReadonlyArray<BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionEnvironmentConnectRequest>
        >([]);
        const bootstrapCredentials = yield* Ref.make<ReadonlyArray<string>>([]);
        const target = new RelayConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "WELSCH computer",
          businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
        });
        const brokerLayer = yield* makeDependencies({
          cloudSessionToken: Effect.die("Scoped relay target must never read Clerk."),
          managedAuthorizationProvider:
            BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionAuthorizationProvider.of({
              read: (input) =>
                Ref.update(providerInputs, (values) => [
                  ...values,
                  input.businessOsInstanceId,
                ]).pipe(Effect.as(MANAGED_AUTHORIZATION)),
            }),
          managedDeviceSessionClient: managedDeviceSessionClient({
            readDeviceSessionMembership: (request) =>
              Ref.update(membershipInputs, (values) => [
                ...values,
                request.payload.businessOsInstanceId,
              ]).pipe(
                Effect.as({
                  businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
                  membershipVersion: 7,
                  environmentIds: [ENVIRONMENT_ID],
                }),
              ),
            connectEnvironment: (request) =>
              Ref.update(connectInputs, (values) => [...values, request]).pipe(
                Effect.as({
                  environmentId: request.environmentId,
                  endpoint: ENDPOINT,
                  credential: "managed-relay-bootstrap",
                  expiresAt: "2099-08-27T04:00:00Z",
                }),
              ),
          }),
          authorizeDpop: (input) =>
            input.obtainBootstrap.pipe(
              Effect.tap((bootstrap) =>
                Ref.update(bootstrapCredentials, (values) => [...values, bootstrap.credential]),
              ),
              Effect.as({
                environmentId: input.expectedEnvironmentId,
                label: "WELSCH computer",
                httpBaseUrl: ENDPOINT.httpBaseUrl,
                socketUrl: "wss://environment.example.test/ws?wsTicket=managed-dpop",
                httpAuthorization: {
                  _tag: "Dpop" as const,
                  accessToken: "environment-dpop-token",
                },
              }),
            ),
        });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(brokerLayer),
        );

        expect((yield* broker.prepare(catalogEntry(target))).socketUrl).toContain(
          "wsTicket=managed-dpop",
        );
        expect(yield* Ref.get(providerInputs)).toEqual([BUSINESS_OS_INSTANCE_ID]);
        expect(yield* Ref.get(membershipInputs)).toEqual([BUSINESS_OS_INSTANCE_ID]);
        expect(yield* Ref.get(connectInputs)).toEqual([
          {
            relayIssuer: MANAGED_AUTHORIZATION.relayIssuer,
            accessToken: MANAGED_AUTHORIZATION.accessToken,
            environmentId: ENVIRONMENT_ID,
            deviceId: MANAGED_AUTHORIZATION.deviceId,
            businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
          },
        ]);
        expect(yield* Ref.get(bootstrapCredentials)).toEqual(["managed-relay-bootstrap"]);
      }),
  );

  it.effect("revalidates instance membership before reusing a scoped environment token", () =>
    Effect.gen(function* () {
      const providerCalls = yield* Ref.make(0);
      const membershipCalls = yield* Ref.make(0);
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "WELSCH computer",
        businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
      });
      const brokerLayer = yield* makeDependencies({
        cloudSessionToken: Effect.die("Scoped relay target must never read Clerk."),
        managedAuthorizationProvider:
          BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionAuthorizationProvider.of({
            read: () =>
              Ref.update(providerCalls, (count) => count + 1).pipe(
                Effect.as(MANAGED_AUTHORIZATION),
              ),
          }),
        managedDeviceSessionClient: managedDeviceSessionClient({
          readDeviceSessionMembership: () =>
            Ref.update(membershipCalls, (count) => count + 1).pipe(
              Effect.as({
                businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
                membershipVersion: 9,
                environmentIds: [ENVIRONMENT_ID],
              }),
            ),
          connectEnvironment: () =>
            Effect.die("A valid scoped cache entry must not mint a fresh Relay bootstrap."),
        }),
        authorizeDpop: () =>
          Effect.succeed({
            environmentId: ENVIRONMENT_ID,
            label: "WELSCH computer",
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            socketUrl: "wss://environment.example.test/ws?wsTicket=cached-managed-dpop",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: "cached-managed-environment-token",
            },
          }),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      expect((yield* broker.prepare(catalogEntry(target))).socketUrl).toContain(
        "cached-managed-dpop",
      );
      expect(yield* Ref.get(providerCalls)).toBe(1);
      expect(yield* Ref.get(membershipCalls)).toBe(1);
    }),
  );

  it.effect("does not fall back to Clerk when a scoped relay target has no device session", () =>
    Effect.gen(function* () {
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "WELSCH computer",
        businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
      });
      const brokerLayer = yield* makeDependencies({
        cloudSessionToken: Effect.die("Scoped relay target must never read Clerk."),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toBeInstanceOf(ConnectionBlockedError);
      expect(error).toMatchObject({ reason: "authentication" });
    }),
  );

  it.effect("rejects a stale Business OS device session", () =>
    Effect.gen(function* () {
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "WELSCH computer",
        businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
      });
      const staleAuthorization = {
        ...MANAGED_AUTHORIZATION,
        expiresAt: "1969-12-31T23:59:00Z",
      };
      const brokerLayer = yield* makeDependencies({
        cloudSessionToken: Effect.die("Scoped relay target must never read Clerk."),
        managedAuthorizationProvider:
          BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionAuthorizationProvider.of({
            read: () => Effect.succeed(staleAuthorization),
          }),
        managedDeviceSessionClient: managedDeviceSessionClient(),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toBeInstanceOf(ConnectionBlockedError);
      expect(error).toMatchObject({ reason: "authentication" });
    }),
  );

  it.effect("blocks a scoped relay target that is absent from current instance membership", () =>
    Effect.gen(function* () {
      const connectCalls = yield* Ref.make(0);
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "WELSCH computer",
        businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
      });
      const brokerLayer = yield* makeDependencies({
        cloudSessionToken: Effect.die("Scoped relay target must never read Clerk."),
        managedAuthorizationProvider:
          BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionAuthorizationProvider.of({
            read: () => Effect.succeed(MANAGED_AUTHORIZATION),
          }),
        managedDeviceSessionClient: managedDeviceSessionClient({
          readDeviceSessionMembership: () =>
            Effect.succeed({
              businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
              membershipVersion: 8,
              environmentIds: [EnvironmentId.make("environment-gpu3")],
            }),
          connectEnvironment: () =>
            Ref.update(connectCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.die("Membership rejection must happen before connect.")),
            ),
        }),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toBeInstanceOf(ConnectionBlockedError);
      expect(error).toMatchObject({ reason: "permission" });
      expect(yield* Ref.get(connectCalls)).toBe(0);
    }),
  );

  it.effect("never retries a rejected instance-scoped direct connection through Clerk", () =>
    Effect.gen(function* () {
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "WELSCH computer",
        businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
      });
      const brokerLayer = yield* makeDependencies({
        cloudSessionToken: Effect.die("Scoped relay target must never read Clerk."),
        managedAuthorizationProvider:
          BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionAuthorizationProvider.of({
            read: () => Effect.succeed(MANAGED_AUTHORIZATION),
          }),
        managedDeviceSessionClient: managedDeviceSessionClient({
          readDeviceSessionMembership: () =>
            Effect.succeed({
              businessOsInstanceId: BUSINESS_OS_INSTANCE_ID,
              membershipVersion: 9,
              environmentIds: [ENVIRONMENT_ID],
            }),
          connectEnvironment: () =>
            Effect.fail(
              new BusinessOsManagedBackendControl.WorkjetManagedDeviceSessionClientError({
                operation: "connect",
                code: "request_failed",
              }),
            ),
        }),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({ reason: "relay-unavailable" });
    }),
  );

  it.effect("exports the complete relay authorization flow through the product tracer", () =>
    Effect.gen(function* () {
      const userSpans: Array<string> = [];
      const productSpans: Array<string> = [];
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Cloud",
      });
      const brokerLayer = yield* makeDependencies({
        authorizeDpop: (input) =>
          input.obtainBootstrap.pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Cloud",
              httpBaseUrl: ENDPOINT.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=dpop",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: "dpop-access-token",
              },
            }),
            Effect.withSpan("test.remote.authorizeDpop"),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      yield* broker
        .prepare(catalogEntry(target))
        .pipe(
          Effect.provideService(RelayClientTracer, Option.some(collectingTracer(productSpans))),
          Effect.withTracer(collectingTracer(userSpans)),
        );

      expect(productSpans).toContain("clientRuntime.connection.broker.relay");
      expect(productSpans).toContain("test.remote.authorizeDpop");
      expect(userSpans).toContain("clientRuntime.connection.broker.prepare");
      expect(userSpans).not.toContain("test.remote.authorizeDpop");
    }),
  );

  it.effect("delegates SSH launch to the platform gateway before remote authorization", () =>
    Effect.gen(function* () {
      const preparedTargets = yield* Ref.make<ReadonlyArray<DesktopSshEnvironmentTarget>>([]);
      const target = new SshConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        connectionId: "ssh-1",
      });
      const profile = new SshConnectionProfile({
        connectionId: "ssh-1",
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        target: SSH_TARGET,
      });
      const brokerLayer = yield* makeDependencies({
        prepareSsh: (input) =>
          Ref.update(preparedTargets, (values) => [...values, input.target]).pipe(
            Effect.as({
              bootstrap: {
                target: input.target,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "ssh-bearer",
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      expect(
        (yield* broker.prepare(catalogEntry(target, Option.some(profile)))).socketUrl,
      ).toContain("wsTicket=bearer");
      expect(yield* Ref.get(preparedTargets)).toEqual([SSH_TARGET]);
    }),
  );

  it.effect("classifies relay request timeouts as retryable connection failures", () =>
    Effect.gen(function* () {
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Cloud",
      });
      const brokerLayer = yield* makeDependencies({
        connectEnvironment: () =>
          Effect.fail(
            new ManagedRelay.ManagedRelayRequestTimeoutError({
              activity: "Relay environment connection",
              timeoutMs: ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS,
              traceId: null,
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({ reason: "timeout" });
    }),
  );
});
