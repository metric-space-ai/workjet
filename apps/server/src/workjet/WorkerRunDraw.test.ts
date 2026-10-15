// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { makeWithRandom } from "./WorkerRunDraw.ts";

// Opaque fake-worker handles, deliberately not invented model IDs or a live catalog.
const pool = {
  candidates: ["fixture-worker-a", "fixture-worker-b", "fixture-worker-c"],
  healthSnapshotSha256: "a".repeat(64),
  observedAt: "2026-10-13T09:00:00.000Z",
};
const database = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
describe("persisted uniform worker draws", () => {
  it.effect(
    "reuses the same brief after reconstruction, changed candidates and a different random source",
    () =>
      database(
        Effect.gen(function* () {
          yield* runMigrations();
          const store = yield* makeWithRandom(Effect.succeed(0.5));
          const input = { briefSha256: "b".repeat(64), pool };
          const first = yield* store.select(input);
          const rebuilt = yield* makeWithRandom(Effect.succeed(0.99));
          assert.deepEqual(
            yield* rebuilt.select({ ...input, pool: { ...pool, candidates: [] } }),
            first,
          );
          assert.equal(first.selected, "fixture-worker-b");
          assert.deepEqual(
            first.candidates.map((candidate) => candidate.probability),
            [1 / 3, 1 / 3, 1 / 3],
          );
          assert.equal(
            (yield* Effect.exit(
              store.select({
                ...input,
                briefSha256: "c".repeat(64),
                pool: { ...pool, candidates: [] },
              }),
            ))._tag,
            "Failure",
          );
        }),
      ),
  );
  it.effect("runs fake workers across many distinct briefs with approximately uniform counts", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        let seed = 12345;
        const store = yield* makeWithRandom(
          Effect.sync(() => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 2 ** 32;
          }),
        );
        const counts = new Map(pool.candidates.map((candidate) => [candidate, 0]));
        for (let index = 0; index < 1200; index++) {
          const receipt = yield* store.select({
            briefSha256: index.toString(16).padStart(64, "0"),
            pool,
          });
          // A fake worker receives exactly the committed selection, including retries.
          const run = () => counts.set(receipt.selected, counts.get(receipt.selected)! + 1);
          run();
          assert.deepEqual(
            yield* store.select({ briefSha256: receipt.briefSha256, pool }),
            receipt,
          );
        }
        for (const count of counts.values()) assert.ok(count > 340 && count < 460);
      }),
    ),
  );
});
