import type { WorkjetConnectionId } from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class CtoxConnectionBindingError extends Schema.TaggedErrorClass<CtoxConnectionBindingError>()(
  "CtoxConnectionBindingError",
  { reason: Schema.Literals(["connection-instance-mismatch", "connection-unavailable"]) },
) {}

const unavailable = () => new CtoxConnectionBindingError({ reason: "connection-unavailable" });

/** Check the explicit managed route. This does not attest a self-hosted peer's identity. */
export const requireCtoxManagedInstanceRoute = (endpoint: string, instanceId: string) =>
  Effect.try({
    try: () => {
      const url = new URL(endpoint);
      if (url.hostname !== "mcp.ctox.dev") return;
      if (url.pathname === "/mcp") return;
      const match = /^\/mcp\/([^/]+)$/.exec(url.pathname);
      if (!match || decodeURIComponent(match[1]!) !== instanceId) {
        throw new Error("Managed route names another instance");
      }
    },
    catch: () => new CtoxConnectionBindingError({ reason: "connection-instance-mismatch" }),
  });

const decodeBindings = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ instanceId: Schema.String })),
);

export const requireCtoxConnectionInstance = Effect.fn("ctox.requireConnectionInstance")(function* (
  connectionId: WorkjetConnectionId,
  expectedInstanceId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT instance_id AS "instanceId" FROM workjet_ctox_connection_bindings
    WHERE connection_id = ${connectionId}
  `.pipe(
    Effect.mapError(unavailable),
    Effect.flatMap(decodeBindings),
    Effect.mapError(unavailable),
  );
  if (rows[0]?.instanceId !== expectedInstanceId) {
    return yield* new CtoxConnectionBindingError({ reason: "connection-instance-mismatch" });
  }
});

/** First writer wins across sessions/processes. Never delete this binding on disconnect. */
export const bindCtoxConnectionInstance = Effect.fn("ctox.bindConnectionInstance")(function* (
  connectionId: WorkjetConnectionId,
  instanceId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`
    INSERT INTO workjet_ctox_connection_bindings (connection_id, instance_id, created_at_ms)
    VALUES (${connectionId}, ${instanceId}, ${now})
    ON CONFLICT(connection_id) DO NOTHING
  `.pipe(Effect.mapError(unavailable));
  yield* requireCtoxConnectionInstance(connectionId, instanceId);
});
