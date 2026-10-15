import { resolveRemoteWebSocketConnectionUrl } from "@workjet/client-runtime/authorization";
import {
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "@workjet/client-runtime/connection";

import { RpcSessionFactory } from "@workjet/client-runtime/rpc";
import {
  WS_METHODS,
  type CtoxDecisionHubDisconnectInput,
  type CtoxDecisionHubDisconnectResult,
  WorkjetConnectionId,
  type CtoxDecisionHubProvisionInput,
  type CtoxDecisionHubProvisionResult,
} from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import { DesktopLocalServiceSession } from "../backend/DesktopLocalServiceSession.ts";
import * as CtoxElectronSessions from "./CtoxElectronSessions.ts";
import * as CtoxInstanceRegistry from "./CtoxInstanceRegistry.ts";
import { resolveCtoxBinary } from "./CtoxLocalDaemonLaunch.ts";
import { makeDecisionHubEnvironmentResolver } from "./CtoxDecisionHubEnvironment.ts";
import { ElectronWindow } from "../electron/ElectronWindow.ts";
import { CONNECTION_CATALOG_WARNING_CHANNEL } from "../ipc/channels.ts";
import {
  acquireWorkjetWorkerSourceGrant,
  revokeWorkjetWorkerSourceGrant,
  workerSourceGrantIdentity,
  workerSourceNeedsRenewal,
} from "./CtoxWorkerSourceGrant.ts";
import { fetchRemoteEnvironmentDescriptor } from "@workjet/client-runtime/environment";

const GrantResponse = Schema.Struct({
  ok: Schema.Literal(true),
  grant: Schema.Struct({
    token: Schema.String,
    tokenId: Schema.NullOr(Schema.String),
    endpoint: Schema.String,
    instanceId: Schema.String,
    displayName: Schema.String,
  }),
});
const decodeGrantResponse = Schema.decodeUnknownEffect(GrantResponse);
const LocalSecretResponse = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(16_384)),
});
const decodeLocalSecret = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalSecretResponse));
const LOCAL_MCP_ENDPOINT = "http://127.0.0.1:8788/mcp";
// Worker-Quellen still erneuern: kurz nach dem App-Start, danach stündlich.
const WORKER_SOURCE_RENEW_START_DELAY = Duration.seconds(30);
const WORKER_SOURCE_RENEW_INTERVAL = Duration.minutes(60);
const LOCAL_SECRET_TIMEOUT = Duration.seconds(10);
const MAX_LOCAL_SECRET_OUTPUT_BYTES = 65_536;

const collectBounded = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (current, chunk) =>
        new TextEncoder().encode(current).byteLength > MAX_LOCAL_SECRET_OUTPUT_BYTES
          ? current
          : current + chunk,
    ),
  );

export class CtoxDecisionHubProvisioner extends Context.Service<
  CtoxDecisionHubProvisioner,
  {
    readonly provision: (
      input: CtoxDecisionHubProvisionInput,
    ) => Effect.Effect<CtoxDecisionHubProvisionResult>;
    readonly disconnect: (
      input: CtoxDecisionHubDisconnectInput,
    ) => Effect.Effect<CtoxDecisionHubDisconnectResult>;
    readonly revokeAll: Effect.Effect<void>;
  }
>()("@workjet/desktop/ctox/CtoxDecisionHubProvisioner") {}

const make = Effect.gen(function* () {
  const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
  const catalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const localServiceSession = yield* DesktopLocalServiceSession;
  const rpcFactory = yield* RpcSessionFactory;
  const httpClient = yield* HttpClient.HttpClient;
  const instanceRegistry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const windows = yield* ElectronWindow;
  const issuedGrants = yield* Ref.make<
    ReadonlyArray<{
      connectionId: WorkjetConnectionId;
      tenantId: string;
      tokenId: string;
      purpose?: "worker_source";
    }>
  >([]);

  const environmentResolver = yield* makeDecisionHubEnvironmentResolver({
    readCatalog: catalogStore.get,
    localConfigurations: Effect.gen(function* () {
      const configs = [];
      for (const instance of yield* pool.list) {
        const config = yield* instance.currentConfig;
        if (Option.isSome(config)) configs.push(config.value);
      }
      return configs;
    }),
    notifyCatalogError: windows.sendAll(CONNECTION_CATALOG_WARNING_CHANNEL),
  });
  const resolveEnvironment = (environmentId: string) =>
    environmentResolver(environmentId).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(DesktopLocalServiceSession, localServiceSession),
    );

  const revokeGrant = (grant: {
    readonly tenantId: string;
    readonly tokenId: string;
    readonly purpose?: "worker_source";
  }) =>
    Effect.gen(function* () {
      const account = yield* sessions.account;
      if (grant.purpose === "worker_source") {
        yield* Effect.tryPromise({
          try: () => revokeWorkjetWorkerSourceGrant(account.fetch.bind(account), grant),
          catch: () => "grant_revoke_unavailable" as const,
        });
        return;
      }
      yield* Effect.promise(() =>
        account.fetch("https://ctox.dev/api/desktop/decision-hub-grant", {
          method: "DELETE",
          cache: "no-store",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "x-ctox-desktop-client": "ctox-business-os-desktop",
          },
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- Electron fetch requires a JSON string body.
          body: JSON.stringify({ tenantId: grant.tenantId, tokenId: grant.tokenId }),
        }),
      );
    }).pipe(Effect.catchCause(() => Effect.void));

  const provision = (input: CtoxDecisionHubProvisionInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* resolveEnvironment(input.environmentId);
        const target = input.target;
        if (input.purpose === "worker_source" && target._tag !== "ctox_dev")
          return yield* Effect.fail("grant_unavailable" as const);
        const managedTenantId = target._tag === "ctox_dev" ? target.tenantId : undefined;
        const localInstanceId = target._tag === "local_ctox" ? target.instanceId : undefined;
        const provisionTarget =
          managedTenantId !== undefined
            ? yield* Effect.gen(function* () {
                const account = yield* sessions.account;
                if (input.purpose === "worker_source") {
                  const grant = yield* acquireWorkjetWorkerSourceGrant(
                    account.fetch.bind(account),
                    managedTenantId,
                    (rolledBack) =>
                      Ref.update(issuedGrants, (current) =>
                        current.filter((candidate) => candidate.tokenId !== rolledBack.tokenId),
                      ),
                  ).pipe(Effect.mapError((error) => error.code));
                  const issued = {
                    connectionId: grant.connectionId,
                    tenantId: grant.tenantId,
                    tokenId: grant.tokenId,
                    purpose: "worker_source" as const,
                  };
                  yield* Ref.update(issuedGrants, (current) => [...current, issued]);
                  return {
                    connectionId: grant.connectionId,
                    instanceId: grant.instanceId,
                    displayName: grant.displayName,
                    source: grant.source,
                    endpoint: grant.endpoint,
                    token: grant.token,
                    commit: grant.commit,
                  };
                }
                const response = yield* Effect.promise(() =>
                  account.fetch("https://ctox.dev/api/desktop/decision-hub-grant", {
                    method: "POST",
                    cache: "no-store",
                    credentials: "include",
                    headers: {
                      "content-type": "application/json",
                      "x-ctox-desktop-client": "ctox-business-os-desktop",
                    },
                    // @effect-diagnostics-next-line preferSchemaOverJson:off -- Electron fetch requires a JSON string body.
                    body: JSON.stringify({ tenantId: managedTenantId }),
                  }),
                );
                if (response.status === 401) return yield* Effect.fail("signed_out" as const);
                if (!response.ok) return yield* Effect.fail("grant_unavailable" as const);
                const decoded = yield* decodeGrantResponse(
                  yield* Effect.promise(() => response.json()),
                );
                if (decoded.grant.tokenId !== null) {
                  yield* Ref.update(issuedGrants, (current) => [
                    ...current.filter((grant) => grant.tokenId !== decoded.grant.tokenId),
                    {
                      connectionId: WorkjetConnectionId.make(`ctox-dev:${managedTenantId}`),
                      tenantId: managedTenantId,
                      tokenId: decoded.grant.tokenId!,
                    },
                  ]);
                }
                return {
                  connectionId: WorkjetConnectionId.make(`ctox-dev:${managedTenantId}`),
                  instanceId: decoded.grant.instanceId,
                  displayName: decoded.grant.displayName,
                  source: "ctox_dev" as const,
                  endpoint: decoded.grant.endpoint,
                  token: decoded.grant.token,
                };
              })
            : yield* Effect.gen(function* () {
                const local = yield* instanceRegistry.resolveLocalDaemonTarget(localInstanceId!);
                if (local.discoveredCount !== 1)
                  return yield* Effect.fail("provision_failed" as const);
                const child = yield* spawner.spawn(
                  ChildProcess.make(resolveCtoxBinary(process.env), [
                    "secret",
                    "get",
                    "--scope",
                    "business_os",
                    "--name",
                    "mcp_inbound_auth_token",
                  ]),
                );
                const [stdout, , exitCode] = yield* Effect.all(
                  [collectBounded(child.stdout), collectBounded(child.stderr), child.exitCode],
                  { concurrency: "unbounded" },
                ).pipe(Effect.timeout(LOCAL_SECRET_TIMEOUT));
                if (
                  Number(exitCode) !== 0 ||
                  new TextEncoder().encode(stdout).byteLength > MAX_LOCAL_SECRET_OUTPUT_BYTES
                ) {
                  return yield* Effect.fail("provision_failed" as const);
                }
                const secret = yield* decodeLocalSecret(stdout, { onExcessProperty: "ignore" });
                return {
                  connectionId: WorkjetConnectionId.make(`local-ctox:${local.daemonInstanceId}`),
                  instanceId: local.daemonInstanceId,
                  displayName: local.descriptor.displayName,
                  source: "local_ctox" as const,
                  endpoint: LOCAL_MCP_ENDPOINT,
                  token: secret.value,
                };
              });
        const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
          httpBaseUrl: environment.httpBaseUrl,
          wsBaseUrl: environment.wsBaseUrl,
          bearerToken: environment.bearerToken,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        const connection: PreparedConnection = {
          environmentId: input.environmentId,
          label: "Decision Hub provisioning",
          httpBaseUrl: environment.httpBaseUrl,
          socketUrl,
          httpAuthorization: { _tag: "Bearer", token: environment.bearerToken },
          target: new PrimaryConnectionTarget({
            environmentId: input.environmentId,
            label: "Decision Hub provisioning",
            httpBaseUrl: environment.httpBaseUrl,
            wsBaseUrl: environment.wsBaseUrl,
          }),
        };
        const rpc = yield* rpcFactory.connect(connection);
        yield* rpc.ready;
        const result = yield* rpc.client[WS_METHODS.workjetDecisionHubProvisionConnection]({
          connectionId: provisionTarget.connectionId,
          instanceId: provisionTarget.instanceId,
          displayName: provisionTarget.displayName,
          source: provisionTarget.source,
          endpoint: provisionTarget.endpoint,
          token: provisionTarget.token,
        });
        if ("commit" in provisionTarget) provisionTarget.commit();
        return { _tag: "completed", connection: result.connection } as const;
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed({
            _tag: "failed",
            code:
              cause === "signed_out" ||
              cause === "grant_unavailable" ||
              cause === "environment_unavailable"
                ? cause
                : "provision_failed",
          } as const),
        ),
      ),
    );

  const disconnect = (input: CtoxDecisionHubDisconnectInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* resolveEnvironment(input.environmentId);
        const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
          httpBaseUrl: environment.httpBaseUrl,
          wsBaseUrl: environment.wsBaseUrl,
          bearerToken: environment.bearerToken,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        const connection: PreparedConnection = {
          environmentId: input.environmentId,
          label: "Decision Hub disconnect",
          httpBaseUrl: environment.httpBaseUrl,
          socketUrl,
          httpAuthorization: { _tag: "Bearer", token: environment.bearerToken },
          target: new PrimaryConnectionTarget({
            environmentId: input.environmentId,
            label: "Decision Hub disconnect",
            httpBaseUrl: environment.httpBaseUrl,
            wsBaseUrl: environment.wsBaseUrl,
          }),
        };
        const rpc = yield* rpcFactory.connect(connection);
        yield* rpc.ready;
        const result = yield* rpc.client[WS_METHODS.workjetDecisionHubDisconnectConnection]({
          connectionId: input.connectionId,
        });
        if (!result.disconnected) return yield* Effect.fail("disconnect_failed" as const);
        const grant = yield* Ref.modify(issuedGrants, (current) => [
          current.find((candidate) => candidate.connectionId === input.connectionId),
          current.filter((candidate) => candidate.connectionId !== input.connectionId),
        ]);
        if (grant !== undefined) yield* revokeGrant(grant);
        else {
          const identity = workerSourceGrantIdentity(input.connectionId);
          if (identity !== undefined) yield* revokeGrant({ ...identity, purpose: "worker_source" });
        }
        return { _tag: "completed" } as const;
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed({
            _tag: "failed",
            code: cause === "environment_unavailable" ? cause : "disconnect_failed",
          } as const),
        ),
      ),
    ) satisfies Effect.Effect<CtoxDecisionHubDisconnectResult>;

  const openEnvironmentRpc = (environmentId: string, label: string) =>
    Effect.gen(function* () {
      const environment = yield* resolveEnvironment(environmentId);
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        httpBaseUrl: environment.httpBaseUrl,
        wsBaseUrl: environment.wsBaseUrl,
        bearerToken: environment.bearerToken,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      const rpc = yield* rpcFactory.connect({
        environmentId: environmentId as PreparedConnection["environmentId"],
        label,
        httpBaseUrl: environment.httpBaseUrl,
        socketUrl,
        httpAuthorization: { _tag: "Bearer", token: environment.bearerToken },
        target: new PrimaryConnectionTarget({
          environmentId: environmentId as PreparedConnection["environmentId"],
          label,
          httpBaseUrl: environment.httpBaseUrl,
          wsBaseUrl: environment.wsBaseUrl,
        }),
      });
      yield* rpc.ready;
      return rpc;
    });

  // Ausstellzeitpunkt je Worker-Quelle in dieser App-Sitzung (Tokens nie loggen).
  const workerSourceIssuedAt = new Map<string, number>();

  /**
   * Stellt eine Worker-Quelle unter DERSELBEN Verbindungs-ID neu aus, damit
   * Unterhaltungen ihre Bindung behalten, und widerruft danach das alte Token.
   */
  const renewWorkerSource = (
    rpc: Effect.Success<ReturnType<typeof openEnvironmentRpc>>,
    connection: { readonly connectionId: WorkjetConnectionId; readonly instanceId: string },
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const identity = workerSourceGrantIdentity(connection.connectionId);
        if (identity === undefined) return;
        const account = yield* sessions.account;
        const grant = yield* acquireWorkjetWorkerSourceGrant(
          account.fetch.bind(account),
          identity.tenantId,
        );
        if (grant.instanceId !== connection.instanceId) return;
        yield* rpc.client[WS_METHODS.workjetDecisionHubProvisionConnection]({
          connectionId: connection.connectionId,
          instanceId: grant.instanceId,
          displayName: grant.displayName,
          source: grant.source,
          endpoint: grant.endpoint,
          token: grant.token,
        });
        grant.commit();
        const now = yield* Clock.currentTimeMillis;
        workerSourceIssuedAt.set(connection.connectionId, now);
        const previousTokenId = yield* Ref.modify(issuedGrants, (current) => [
          current.find((candidate) => candidate.connectionId === connection.connectionId)
            ?.tokenId ?? identity.tokenId,
          [
            ...current.filter((candidate) => candidate.connectionId !== connection.connectionId),
            {
              connectionId: connection.connectionId,
              tenantId: identity.tenantId,
              tokenId: grant.tokenId,
              purpose: "worker_source" as const,
            },
          ],
        ]);
        if (previousTokenId !== grant.tokenId)
          yield* revokeGrant({
            tenantId: identity.tenantId,
            tokenId: previousTokenId,
            purpose: "worker_source",
          });
      }),
    ).pipe(Effect.catchCause(() => Effect.void));

  const renewWorkerSources = Effect.gen(function* () {
    const environmentIds = new Set<string>();
    for (const instance of yield* pool.list) {
      const config = yield* instance.currentConfig;
      if (Option.isNone(config)) continue;
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: config.value.httpBaseUrl.href,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.option);
      if (Option.isSome(descriptor)) environmentIds.add(descriptor.value.environmentId);
    }
    for (const environmentId of environmentIds) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const rpc = yield* openEnvironmentRpc(environmentId, "Worker source renewal");
          const listed = yield* rpc.client[WS_METHODS.workjetDecisionHubListConnections]({});
          const now = yield* Clock.currentTimeMillis;
          for (const connection of listed.connections) {
            if (
              !workerSourceNeedsRenewal(
                connection,
                workerSourceIssuedAt.get(connection.connectionId),
                now,
              )
            )
              continue;
            yield* renewWorkerSource(rpc, connection);
          }
        }),
      ).pipe(Effect.catchCause(() => Effect.void));
    }
  }).pipe(Effect.catchCause(() => Effect.void));

  yield* Effect.sleep(WORKER_SOURCE_RENEW_START_DELAY).pipe(
    Effect.andThen(
      renewWorkerSources.pipe(Effect.repeat(Schedule.spaced(WORKER_SOURCE_RENEW_INTERVAL))),
    ),
    Effect.forkScoped,
  );

  const revokeAll = Effect.gen(function* () {
    const grants = yield* Ref.getAndSet(issuedGrants, []);
    if (grants.length === 0) return;
    yield* Effect.forEach(grants, revokeGrant, { concurrency: 4, discard: true });
  }).pipe(Effect.catchCause(() => Effect.void));

  return CtoxDecisionHubProvisioner.of({ provision, disconnect, revokeAll });
});

export const layer = Layer.effect(CtoxDecisionHubProvisioner, make);
