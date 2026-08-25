import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "@t3tools/client-runtime/authorization";
import {
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { RpcSessionFactory } from "@t3tools/client-runtime/rpc";
import {
  WS_METHODS,
  type CtoxDecisionHubDisconnectInput,
  type CtoxDecisionHubDisconnectResult,
  WorkjetConnectionId,
  type CtoxDecisionHubProvisionInput,
  type CtoxDecisionHubProvisionResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as CtoxElectronSessions from "./CtoxElectronSessions.ts";
import * as CtoxInstanceRegistry from "./CtoxInstanceRegistry.ts";
import { resolveCtoxBinary } from "./CtoxLocalDaemonLaunch.ts";

const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectionCatalogDocument));
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
const LocalSecretResponse = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(16_384)),
});
const decodeLocalSecret = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalSecretResponse));
const LOCAL_MCP_ENDPOINT = "http://127.0.0.1:8788/mcp";
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

type EnvironmentTarget = {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string;
};

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
>()("@t3tools/desktop/ctox/CtoxDecisionHubProvisioner") {}

const make = Effect.gen(function* () {
  const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
  const catalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const rpcFactory = yield* RpcSessionFactory;
  const httpClient = yield* HttpClient.HttpClient;
  const instanceRegistry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const issuedGrants = yield* Ref.make<
    ReadonlyArray<{ connectionId: WorkjetConnectionId; tenantId: string; tokenId: string }>
  >([]);

  const resolveEnvironment = (environmentId: string) =>
    Effect.gen(function* () {
      const stored = yield* catalogStore.get;
      if (Option.isSome(stored)) {
        const catalog = yield* decodeCatalog(stored.value);
        const target = catalog.targets.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (target?._tag === "BearerConnectionTarget") {
          const profile = catalog.profiles.find(
            (candidate) =>
              candidate._tag === "BearerConnectionProfile" &&
              candidate.connectionId === target.connectionId,
          );
          const credential = catalog.credentials.find(
            (candidate) => candidate.connectionId === target.connectionId,
          )?.credential;
          if (
            profile?._tag === "BearerConnectionProfile" &&
            credential?._tag === "BearerConnectionCredential"
          ) {
            return {
              httpBaseUrl: profile.httpBaseUrl,
              wsBaseUrl: profile.wsBaseUrl,
              bearerToken: credential.token,
            };
          }
        }
      }

      for (const instance of yield* pool.list) {
        const config = yield* instance.currentConfig;
        if (Option.isNone(config)) continue;
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: config.value.httpBaseUrl.href,
        });
        if (descriptor.environmentId !== environmentId) continue;
        const session = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: config.value.httpBaseUrl.href,
          credential: config.value.bootstrap.desktopBootstrapToken,
          clientMetadata: { label: "CTOX Desktop Decision Hub", deviceType: "desktop" },
        });
        return {
          httpBaseUrl: config.value.httpBaseUrl.href,
          wsBaseUrl: config.value.httpBaseUrl.href.replace(/^http/, "ws"),
          bearerToken: session.access_token,
        };
      }
      return yield* Effect.fail("environment_unavailable" as const);
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const revokeGrant = (grant: { readonly tenantId: string; readonly tokenId: string }) =>
    Effect.gen(function* () {
      const account = yield* sessions.account;
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
        const managedTenantId = target._tag === "ctox_dev" ? target.tenantId : undefined;
        const localInstanceId = target._tag === "local_ctox" ? target.instanceId : undefined;
        const provisionTarget =
          managedTenantId !== undefined
            ? yield* Effect.gen(function* () {
                const account = yield* sessions.account;
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
                const decoded = yield* Schema.decodeUnknownEffect(GrantResponse)(
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
          ...provisionTarget,
        });
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

  const revokeAll = Effect.gen(function* () {
    const grants = yield* Ref.getAndSet(issuedGrants, []);
    if (grants.length === 0) return;
    yield* Effect.forEach(grants, revokeGrant, { concurrency: 4, discard: true });
  }).pipe(Effect.catchCause(() => Effect.void));

  return CtoxDecisionHubProvisioner.of({ provision, disconnect, revokeAll });
});

export const layer = Layer.effect(CtoxDecisionHubProvisioner, make);
