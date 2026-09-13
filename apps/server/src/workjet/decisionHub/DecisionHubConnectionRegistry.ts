import {
  WorkjetConnectionId,
  type WorkjetConnectionSummary,
  WorkjetDecisionHubConnectionError,
  type WorkjetDecisionHubProvisionInput,
} from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { normalizeCtoxMcpEndpoint } from "../ctox/CtoxMcpTransport.ts";
import {
  bindCtoxConnectionInstance,
  requireCtoxConnectionInstance,
  requireCtoxManagedInstanceRoute,
} from "../ctox/CtoxConnectionBinding.ts";
import { DecisionHubMcpClient, type DecisionHubMcpTarget } from "./DecisionHubMcpClient.ts";

const ConnectionRow = Schema.Struct({
  connectionId: WorkjetConnectionId,
  instanceId: Schema.String,
  displayName: Schema.String,
  source: Schema.Literals(["local_ctox", "ctox_dev"]),
  status: Schema.Literals(["ready", "needs_auth", "offline", "unsupported", "error"]),
  reason: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ConnectionRow));

const ConnectionSecret = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  endpoint: Schema.String,
  token: Schema.String,
});
const decodeSecret = Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectionSecret));
const encodeSecret = Schema.encodeEffect(Schema.fromJsonString(ConnectionSecret));
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const failure = (reason: WorkjetDecisionHubConnectionError["reason"]) =>
  new WorkjetDecisionHubConnectionError({ reason });

const secretName = (connectionId: WorkjetConnectionId): string =>
  `workjet-decision-hub-${Buffer.from(connectionId, "utf8").toString("base64url")}`;

export const normalizeDecisionHubEndpoint = (
  value: string,
): Effect.Effect<string, WorkjetDecisionHubConnectionError> =>
  normalizeCtoxMcpEndpoint(value).pipe(Effect.mapError((error) => failure(error.reason)));

export interface DecisionHubConnectionRegistryShape {
  readonly list: Effect.Effect<
    ReadonlyArray<WorkjetConnectionSummary>,
    WorkjetDecisionHubConnectionError
  >;
  readonly provision: (
    input: WorkjetDecisionHubProvisionInput,
  ) => Effect.Effect<WorkjetConnectionSummary, WorkjetDecisionHubConnectionError>;
  readonly probe: (
    connectionId: WorkjetConnectionId,
  ) => Effect.Effect<WorkjetConnectionSummary, WorkjetDecisionHubConnectionError>;
  readonly disconnect: (
    connectionId: WorkjetConnectionId,
  ) => Effect.Effect<boolean, WorkjetDecisionHubConnectionError>;
  readonly resolveReadyTarget: (
    connectionId: WorkjetConnectionId,
    expectedInstanceId?: string,
  ) => Effect.Effect<DecisionHubMcpTarget, WorkjetDecisionHubConnectionError>;
  /**
   * Emits after a mutation completes — provision, probe, disconnect — so a
   * consumer can re-read `list` instead of polling it. A no-op disconnect emits
   * too: an extra re-read is cheap, a missed change is not.
   *
   * The event carries no payload on purpose. The list is the truth, and a
   * payload would invite acting on a snapshot that is already one mutation old.
   *
   * Subscribe BEFORE reading the initial list. The other order drops every
   * change that lands between the read and the subscription, which is exactly
   * the window in which a connection provisioned at startup goes missing.
   */
  readonly changes: Stream.Stream<void>;
  /**
   * Synchronous subscribe. A consumer that forks its loop must acquire this in
   * its OWN fiber first: `Stream.fromPubSub` only registers when the consumer
   * actually runs, so forking a stream consumer before reading initial state
   * does NOT guarantee the subscription exists yet. Same contract, and same
   * race, as `ProviderInstanceRegistry.subscribeChanges`.
   */
  readonly subscribeChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
}

export class DecisionHubConnectionRegistry extends Context.Service<
  DecisionHubConnectionRegistry,
  DecisionHubConnectionRegistryShape
>()("workjet/workjet/decisionHub/DecisionHubConnectionRegistry") {}

const make = Effect.gen(function* () {
  // Unbounded so a mutation is never blocked by a slow subscriber. A backlog is
  // not free — every queued entry holds memory and every delivery triggers a
  // full re-read of settings and bindings. It is bounded in practice because
  // these events come from human-paced operations (provision, probe,
  // disconnect), not from a data stream. If that ever stops holding, the fix is
  // a coalescing notification that still guarantees one final recomputation,
  // not a larger buffer.
  const changesPubSub = yield* PubSub.unbounded<void>();
  /**
   * Announce a PERSISTED mutation. Deliberately not wrapped around a whole
   * operation: `probe` writes its status and then reads a summary back, and
   * that read can fail. Announcing on overall success would swallow a status
   * change that is already durable — the consumer would keep showing the old
   * state until some unrelated event arrived.
   */
  const announceChange = Effect.suspend(() => PubSub.publish(changesPubSub, undefined));
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore;
  const client = yield* DecisionHubMcpClient;

  const getSummary = (
    connectionId: WorkjetConnectionId,
  ): Effect.Effect<WorkjetConnectionSummary, WorkjetDecisionHubConnectionError> =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT connection_id AS "connectionId", instance_id AS "instanceId",
               display_name AS "displayName", source, status, reason
        FROM workjet_decision_hub_connections
        WHERE connection_id = ${connectionId}
      `.pipe(Effect.mapError(() => failure("connection-unavailable")));
      const decoded = yield* decodeRows(rows).pipe(
        Effect.mapError(() => failure("connection-unavailable")),
      );
      const row = decoded[0];
      if (row === undefined) return yield* failure("unknown-connection");
      yield* requireCtoxConnectionInstance(connectionId, row.instanceId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) => failure(error.reason)),
      );
      return row;
    });

  const readTarget = (
    connectionId: WorkjetConnectionId,
  ): Effect.Effect<DecisionHubMcpTarget, WorkjetDecisionHubConnectionError> =>
    Effect.gen(function* () {
      const summary = yield* getSummary(connectionId);
      const bytes = yield* secrets
        .get(secretName(connectionId))
        .pipe(Effect.mapError(() => failure("secret-store-unavailable")));
      if (Option.isNone(bytes)) return yield* failure("secret-store-unavailable");
      const target = yield* decodeSecret(textDecoder.decode(bytes.value)).pipe(
        Effect.mapError(() => failure("secret-store-unavailable")),
      );
      yield* requireCtoxManagedInstanceRoute(target.endpoint, summary.instanceId).pipe(
        Effect.mapError((error) => failure(error.reason)),
      );
      return target;
    });

  const setStatus = (
    connectionId: WorkjetConnectionId,
    status: WorkjetConnectionSummary["status"],
    reason: string | null,
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap(
        (now) => sql`
          UPDATE workjet_decision_hub_connections
          SET status = ${status}, reason = ${reason}, updated_at_ms = ${now}
          WHERE connection_id = ${connectionId}
        `,
      ),
      Effect.mapError(() => failure("connection-unavailable")),
      Effect.asVoid,
    );

  const provisionRaw = (input: WorkjetDecisionHubProvisionInput) =>
    Effect.gen(function* () {
      const endpoint = yield* normalizeDecisionHubEndpoint(input.endpoint);
      yield* requireCtoxManagedInstanceRoute(endpoint, input.instanceId).pipe(
        Effect.mapError((error) => failure(error.reason)),
      );
      const target = { endpoint, token: input.token };
      // Connection readiness is shared; individual capabilities probe their required tools.
      yield* client.probe(target, []);
      // Claim before writing credentials. A conflicting provision must not
      // replace the secret of a connection referenced by existing threads.
      yield* bindCtoxConnectionInstance(input.connectionId, input.instanceId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) => failure(error.reason)),
      );
      const encoded = yield* encodeSecret({ schemaVersion: 1, ...target }).pipe(
        Effect.mapError(() => failure("secret-store-unavailable")),
      );
      // Secret first: a crash can leave an unreachable orphan secret, but can
      // never publish a ready row whose credential was not durable yet.
      yield* secrets
        .set(secretName(input.connectionId), textEncoder.encode(encoded))
        .pipe(Effect.mapError(() => failure("secret-store-unavailable")));
      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO workjet_decision_hub_connections (
          connection_id, instance_id, display_name, source, status, reason,
          created_at_ms, updated_at_ms
        ) VALUES (
          ${input.connectionId}, ${input.instanceId}, ${input.displayName}, ${input.source},
          'ready', NULL, ${now}, ${now}
        )
        ON CONFLICT(connection_id) DO UPDATE SET
          display_name = excluded.display_name,
          source = excluded.source,
          status = 'ready',
          reason = NULL,
          updated_at_ms = excluded.updated_at_ms
      `.pipe(Effect.mapError(() => failure("connection-unavailable")));
      return yield* getSummary(input.connectionId);
    });

  const list: DecisionHubConnectionRegistryShape["list"] = sql`
    SELECT connection_id AS "connectionId", instance_id AS "instanceId",
           display_name AS "displayName", source, status, reason
    FROM workjet_decision_hub_connections
    ORDER BY display_name COLLATE NOCASE, connection_id
  `.pipe(
    Effect.mapError(() => failure("connection-unavailable")),
    Effect.flatMap(decodeRows),
    Effect.mapError(() => failure("connection-unavailable")),
  );

  const provision: DecisionHubConnectionRegistryShape["provision"] = (input) =>
    provisionRaw(input).pipe(Effect.tap(() => announceChange));

  const probe: DecisionHubConnectionRegistryShape["probe"] = (connectionId) =>
    Effect.gen(function* () {
      const target = yield* readTarget(connectionId);
      yield* client.probe(target, []).pipe(
        Effect.matchEffect({
          onSuccess: () => setStatus(connectionId, "ready", null),
          onFailure: (error) => {
            if (
              error.reason === "remote-identity-mismatch" ||
              error.reason === "remote-tools-missing"
            ) {
              return setStatus(connectionId, "unsupported", error.reason);
            }
            if (error.reason === "remote-response-invalid") {
              return setStatus(connectionId, "error", error.reason);
            }
            return setStatus(connectionId, "offline", error.reason);
          },
        }),
      );
      // The status is persisted at this point. Announcing here rather than
      // after the read-back means a failing summary read cannot hide a status
      // change that already happened.
      yield* announceChange;
      return yield* getSummary(connectionId);
    });

  const disconnect: DecisionHubConnectionRegistryShape["disconnect"] = (connectionId) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT connection_id FROM workjet_decision_hub_connections
        WHERE connection_id = ${connectionId}
      `.pipe(Effect.mapError(() => failure("connection-unavailable")));
      if (rows.length === 0) return false;
      const open = yield* sql`
        SELECT decision_id FROM workjet_decision_hub_escalations
        WHERE connection_id = ${connectionId} AND status = 'open' LIMIT 1
      `.pipe(Effect.mapError(() => failure("connection-unavailable")));
      if (open.length > 0) return yield* failure("connection-unavailable");
      // The durable connection/instance binding deliberately survives this
      // removal. Reusing an id for a different instance would redirect threads.
      yield* secrets
        .remove(secretName(connectionId))
        .pipe(Effect.mapError(() => failure("secret-store-unavailable")));
      yield* sql`
        DELETE FROM workjet_decision_hub_connections WHERE connection_id = ${connectionId}
      `.pipe(Effect.mapError(() => failure("connection-unavailable")));
      // Announced only when a row was really removed. The early `false` return
      // above changed nothing and must not wake every consumer.
      yield* announceChange;
      return true;
    });

  const resolveReadyTarget: DecisionHubConnectionRegistryShape["resolveReadyTarget"] = (
    connectionId,
    expectedInstanceId,
  ) =>
    Effect.gen(function* () {
      const summary = yield* getSummary(connectionId);
      if (summary.status !== "ready") return yield* failure("connection-unavailable");
      if (expectedInstanceId !== undefined && summary.instanceId !== expectedInstanceId) {
        return yield* failure("connection-instance-mismatch");
      }
      return yield* readTarget(connectionId);
    });

  return DecisionHubConnectionRegistry.of({
    changes: Stream.fromPubSub(changesPubSub),
    subscribeChanges: PubSub.subscribe(changesPubSub).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
    list,
    provision,
    probe,
    disconnect,
    resolveReadyTarget,
  });
});

export const layer = Layer.effect(DecisionHubConnectionRegistry, make);
