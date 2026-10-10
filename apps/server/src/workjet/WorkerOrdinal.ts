import type { EnvironmentId, ThreadId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Retry-stable, monotonically increasing names, including remote and archived workers. */
export const makeWorkerOrdinal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (
    parent: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
    workerId: ThreadId,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        INSERT INTO workjet_worker_ordinals (environment_id, parent_thread_id, worker_thread_id, ordinal)
        SELECT ${parent.environmentId}, ${parent.threadId}, ${workerId}, COALESCE(MAX(ordinal), 0) + 1
        FROM workjet_worker_ordinals
        WHERE environment_id = ${parent.environmentId} AND parent_thread_id = ${parent.threadId}
        ON CONFLICT(worker_thread_id) DO NOTHING
      `;
        const rows = yield* sql<{
          readonly ordinal: number;
          readonly environmentId: string;
          readonly parentId: string;
        }>`
        SELECT ordinal, environment_id AS "environmentId", parent_thread_id AS "parentId"
        FROM workjet_worker_ordinals WHERE worker_thread_id = ${workerId}
      `;
        const saved = rows[0];
        if (
          !saved ||
          saved.environmentId !== parent.environmentId ||
          saved.parentId !== parent.threadId
        )
          return yield* Effect.die("Worker ordinal parent conflict.");
        return saved.ordinal;
      }),
    );
});
