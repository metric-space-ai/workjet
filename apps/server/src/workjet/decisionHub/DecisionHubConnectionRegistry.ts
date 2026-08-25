import {
  WorkjetConnectionId,
  type WorkjetConnectionSummary,
  WorkjetDecisionHubConnectionError,
  type WorkjetDecisionHubProvisionInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
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
  Effect.try({
    try: () => {
      const url = new URL(value);
      if (url.username !== "" || url.password !== "" || url.hash !== "") throw new Error();
      const loopback =
        url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error();
      url.search = "";
      url.pathname = url.pathname.replace(/\/+$/, "");
      if (!url.pathname.endsWith("/mcp"))
        url.pathname = `${url.pathname}/mcp`.replace("//mcp", "/mcp");
      return url.toString();
    },
    catch: () => failure("invalid-endpoint"),
  });

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
  ) => Effect.Effect<DecisionHubMcpTarget, WorkjetDecisionHubConnectionError>;
}

export class DecisionHubConnectionRegistry extends Context.Service<
  DecisionHubConnectionRegistry,
  DecisionHubConnectionRegistryShape
>()("t3/workjet/decisionHub/DecisionHubConnectionRegistry") {}

const make = Effect.gen(function* () {
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
      return row;
    });

  const readTarget = (
    connectionId: WorkjetConnectionId,
  ): Effect.Effect<DecisionHubMcpTarget, WorkjetDecisionHubConnectionError> =>
    Effect.gen(function* () {
      yield* getSummary(connectionId);
      const bytes = yield* secrets
        .get(secretName(connectionId))
        .pipe(Effect.mapError(() => failure("secret-store-unavailable")));
      if (Option.isNone(bytes)) return yield* failure("secret-store-unavailable");
      return yield* decodeSecret(textDecoder.decode(bytes.value)).pipe(
        Effect.mapError(() => failure("secret-store-unavailable")),
      );
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
      const target = { endpoint, token: input.token };
      yield* client.probe(target);
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
          instance_id = excluded.instance_id,
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

  const provision: DecisionHubConnectionRegistryShape["provision"] = provisionRaw;

  const probe: DecisionHubConnectionRegistryShape["probe"] = (connectionId) =>
    Effect.gen(function* () {
      const target = yield* readTarget(connectionId);
      yield* client.probe(target).pipe(
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
      yield* secrets
        .remove(secretName(connectionId))
        .pipe(Effect.mapError(() => failure("secret-store-unavailable")));
      yield* sql`
        DELETE FROM workjet_decision_hub_connections WHERE connection_id = ${connectionId}
      `.pipe(Effect.mapError(() => failure("connection-unavailable")));
      return true;
    });

  const resolveReadyTarget: DecisionHubConnectionRegistryShape["resolveReadyTarget"] = (
    connectionId,
  ) =>
    Effect.gen(function* () {
      const summary = yield* getSummary(connectionId);
      if (summary.status !== "ready") return yield* failure("connection-unavailable");
      return yield* readTarget(connectionId);
    });

  return DecisionHubConnectionRegistry.of({
    list,
    provision,
    probe,
    disconnect,
    resolveReadyTarget,
  });
});

export const layer = Layer.effect(DecisionHubConnectionRegistry, make);
