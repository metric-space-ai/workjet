import {
  ThreadId,
  WorkjetCrossModeError,
  WorkjetCrossModeLink,
  WorkjetCrossModeLinkId,
  type WorkjetCrossModeCtoxRef,
  type WorkjetCrossModeTimestamp,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../../persistence/Errors.ts";

/**
 * The durable cross-mode link store (migration 052).
 *
 * It owns the LOCAL durable table and its two invariants, and nothing else. No
 * authority verification, no thread creation, no CTOX command, no clock — those
 * belong to {@link ../crossmode/WorkjetCrossModeAuthority} and
 * {@link ../crossmode/WorkjetCrossModeRpc}, and keeping them out of here is what
 * lets the store's tests state the invariants without a server.
 *
 * Invariants, both enforced by the DATABASE rather than by request ordering:
 *
 * 1. One Business OS object holds at most one link, so `Delegate to Code` on an
 *    object that already has a Code thread SELECTS that thread and never forks a
 *    second one — even when two requests race.
 * 2. One Code thread carries at most one backlink, so "which object does this
 *    thread implement" always has exactly one answer.
 *
 * Every stored value is encoded and decoded through the `@t3tools/contracts`
 * `WorkjetCrossModeLink` schema; there is no hand-rolled JSON shape in this
 * file, and a row that stops decoding surfaces as a typed corrupt-row failure
 * rather than a crash — the same discipline `WorkjetMailboxStore` applies.
 */

// ===============================
// Errors
// ===============================

/**
 * A durable row that no longer decodes through its contract schema. Reported
 * with the table and row id and never with the offending payload: a link row
 * names two authorities' objects, and a log line is not one of them.
 */
export class WorkjetCrossModeStoreCorruptRowError extends Schema.TaggedErrorClass<WorkjetCrossModeStoreCorruptRowError>()(
  "WorkjetCrossModeStoreCorruptRowError",
  {
    table: Schema.Literals(["workjet_cross_mode_links"]),
    rowId: Schema.String,
    issue: Schema.String,
  },
) {
  override get message(): string {
    return `Corrupt ${this.table} row ${this.rowId}: ${this.issue}`;
  }
}

export const isWorkjetCrossModeError = Schema.is(WorkjetCrossModeError);
export const isWorkjetCrossModeStoreCorruptRowError = Schema.is(
  WorkjetCrossModeStoreCorruptRowError,
);

export type WorkjetCrossModeStoreError =
  | PersistenceSqlError
  | WorkjetCrossModeStoreCorruptRowError
  | WorkjetCrossModeError;

/**
 * Collapse a store failure onto the contract's bounded reasons at an RPC
 * boundary. A SQL fault and a corrupt row are both "the local store could not
 * answer"; a contract error already carries its own bounded reason.
 */
export const boundCrossModeStoreError = (
  cause: WorkjetCrossModeStoreError,
): WorkjetCrossModeError =>
  isWorkjetCrossModeError(cause)
    ? cause
    : new WorkjetCrossModeError({ reason: "cross-mode-unavailable" });

// ===============================
// Records and outcomes
// ===============================

export interface WorkjetCrossModeLinkRecord {
  readonly linkId: WorkjetCrossModeLinkId;
  readonly link: WorkjetCrossModeLink;
  readonly createdAtMillis: number;
  /** `null` is the ordinary case and means "no expiry", never "expired". */
  readonly expiresAtMillis: number | null;
}

/**
 * `existing` is the normal, non-error outcome of `Delegate to Code` on an object
 * that already has a Code thread — it is the SELECT half of create-or-select,
 * not a failure. The record returned is the one that was already stored, never
 * the one the caller proposed.
 */
export type WorkjetCrossModeLinkCreateOutcome =
  | { readonly _tag: "created"; readonly record: WorkjetCrossModeLinkRecord }
  | { readonly _tag: "existing"; readonly record: WorkjetCrossModeLinkRecord };

// ===============================
// Row schema
// ===============================

const CrossModeLinkDbRow = Schema.Struct({
  linkId: WorkjetCrossModeLinkId,
  link: Schema.fromJsonString(WorkjetCrossModeLink),
  createdAtMillis: Schema.Int,
  expiresAtMillis: Schema.NullOr(Schema.Int),
});
const decodeCrossModeLinkDbRow = Schema.decodeUnknownEffect(CrossModeLinkDbRow);
const encodeCrossModeLinkJson = Schema.encodeEffect(Schema.fromJsonString(WorkjetCrossModeLink));

const LINK_COLUMNS = `
  link_id AS "linkId",
  link_json AS "link",
  created_at_ms AS "createdAtMillis",
  expires_at_ms AS "expiresAtMillis"
`;

// ===============================
// Service
// ===============================

export interface WorkjetCrossModeLinkStoreShape {
  /**
   * The create-or-select write. Idempotent on the Business OS object: a second
   * call for the same `(instance, module, kind, id)` returns the STORED link
   * untouched, so the caller's proposed Code thread is discarded rather than
   * linked. A caller that creates a thread first must therefore be prepared to
   * delete it when the outcome is `existing`, exactly as the handoff accept
   * deletes the thread it created when it loses the claim race.
   *
   * Fails with `thread-already-linked` when the proposed Code thread already
   * carries a link to a DIFFERENT object.
   */
  readonly createOrSelect: (
    link: WorkjetCrossModeLink,
  ) => Effect.Effect<WorkjetCrossModeLinkCreateOutcome, WorkjetCrossModeStoreError>;

  /** Lookup by the CTOX side: "does this Business OS object have a Code thread". */
  readonly getByObject: (
    ctox: WorkjetCrossModeCtoxRef,
  ) => Effect.Effect<Option.Option<WorkjetCrossModeLinkRecord>, WorkjetCrossModeStoreError>;

  /** Lookup by the Code side: "does this thread implement a Business OS object". */
  readonly getByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<WorkjetCrossModeLinkRecord>, WorkjetCrossModeStoreError>;

  readonly getById: (
    linkId: WorkjetCrossModeLinkId,
  ) => Effect.Effect<Option.Option<WorkjetCrossModeLinkRecord>, WorkjetCrossModeStoreError>;

  /** Bounded listing, newest link first, stable on ties. */
  readonly list: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WorkjetCrossModeLinkRecord>, WorkjetCrossModeStoreError>;
}

export class WorkjetCrossModeLinkStore extends Context.Service<
  WorkjetCrossModeLinkStore,
  WorkjetCrossModeLinkStoreShape
>()("t3/workjet/crossmode/WorkjetCrossModeLinkStore") {}

const sqlFailure = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

/** Contract timestamps are schema-checked, so a parse failure is a malformed link. */
const toEpochMillis = (
  value: WorkjetCrossModeTimestamp,
): Effect.Effect<number, WorkjetCrossModeError> =>
  Option.match(DateTime.make(value), {
    onNone: () => Effect.fail(new WorkjetCrossModeError({ reason: "cross-mode-unavailable" })),
    onSome: (instant) => Effect.succeed(DateTime.toEpochMillis(instant)),
  });

const rowIdOf = (row: unknown): string => {
  const candidate = row as { readonly linkId?: unknown };
  return typeof candidate.linkId === "string" ? candidate.linkId : "unknown";
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decodeRow = (row: unknown, rowId: string) =>
    decodeCrossModeLinkDbRow(row).pipe(
      Effect.mapError(
        (cause) =>
          new WorkjetCrossModeStoreCorruptRowError({
            table: "workjet_cross_mode_links",
            rowId,
            issue: cause.issue._tag,
          }),
      ),
      Effect.map(
        (decoded): WorkjetCrossModeLinkRecord => ({
          linkId: decoded.linkId,
          link: decoded.link,
          createdAtMillis: decoded.createdAtMillis,
          expiresAtMillis: decoded.expiresAtMillis,
        }),
      ),
    );

  const selectOne = (operation: string, where: string, parameters: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${LINK_COLUMNS}
          FROM workjet_cross_mode_links
          WHERE ${where}
        `,
          [...parameters],
        )
        .pipe(Effect.mapError(sqlFailure(operation)));
      const row = rows[0];
      if (row === undefined) return Option.none<WorkjetCrossModeLinkRecord>();
      return Option.some(yield* decodeRow(row, rowIdOf(row)));
    });

  const getByObject: WorkjetCrossModeLinkStoreShape["getByObject"] = (ctox) =>
    selectOne(
      "WorkjetCrossModeLinkStore.getByObject:select",
      `ctox_instance_id = ?
       AND ctox_module_id = ?
       AND ctox_object_kind = ?
       AND ctox_object_id = ?`,
      [ctox.instanceId, ctox.moduleId, ctox.objectKind, ctox.objectId],
    );

  const getByThread: WorkjetCrossModeLinkStoreShape["getByThread"] = (threadId) =>
    selectOne("WorkjetCrossModeLinkStore.getByThread:select", `code_thread_id = ?`, [threadId]);

  const getById: WorkjetCrossModeLinkStoreShape["getById"] = (linkId) =>
    selectOne("WorkjetCrossModeLinkStore.getById:select", `link_id = ?`, [linkId]);

  const createOrSelect: WorkjetCrossModeLinkStoreShape["createOrSelect"] = (link) =>
    Effect.gen(function* () {
      const linkJson = yield* encodeCrossModeLinkJson(link).pipe(
        Effect.mapError(() => new WorkjetCrossModeError({ reason: "cross-mode-unavailable" })),
      );
      const createdAtMillis = yield* toEpochMillis(link.createdAt);
      const expiresAtMillis =
        link.expiresAt === undefined ? null : yield* toEpochMillis(link.expiresAt);

      // `ON CONFLICT DO NOTHING` with NO conflict target covers BOTH unique
      // constraints — the object index and the thread column. Which one fired is
      // then resolved by reading, so the two very different situations ("this
      // object already has a thread" and "this thread already has an object")
      // get their own answers instead of one ambiguous failure.
      const inserted = yield* sql<{ readonly linkId: string }>`
        INSERT INTO workjet_cross_mode_links (
          link_id,
          ctox_instance_id,
          ctox_module_id,
          ctox_object_kind,
          ctox_object_id,
          code_environment_id,
          code_thread_id,
          link_json,
          created_at_ms,
          expires_at_ms
        )
        VALUES (
          ${link.linkId},
          ${link.ctox.instanceId},
          ${link.ctox.moduleId},
          ${link.ctox.objectKind},
          ${link.ctox.objectId},
          ${link.code.environmentId},
          ${link.code.threadId},
          ${linkJson},
          ${createdAtMillis},
          ${expiresAtMillis}
        )
        ON CONFLICT DO NOTHING
        RETURNING link_id AS "linkId"
      `.pipe(Effect.mapError(sqlFailure("WorkjetCrossModeLinkStore.createOrSelect:insert")));

      if (inserted.length > 0) {
        const created = yield* getById(link.linkId);
        return yield* Option.match(created, {
          onNone: () =>
            Effect.fail(new WorkjetCrossModeError({ reason: "cross-mode-unavailable" })),
          onSome: (record) => Effect.succeed({ _tag: "created", record } as const),
        });
      }

      const existing = yield* getByObject(link.ctox);
      return yield* Option.match(existing, {
        onSome: (record) => Effect.succeed({ _tag: "existing", record } as const),
        // The object has no link, so the conflict was the THREAD column: the
        // proposed Code thread already implements a different object.
        onNone: () => Effect.fail(new WorkjetCrossModeError({ reason: "thread-already-linked" })),
      });
    });

  const list: WorkjetCrossModeLinkStoreShape["list"] = (limit) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
          SELECT ${LINK_COLUMNS}
          FROM workjet_cross_mode_links
          ORDER BY created_at_ms DESC, link_id ASC
          LIMIT ?
        `,
          [limit],
        )
        .pipe(Effect.mapError(sqlFailure("WorkjetCrossModeLinkStore.list:select")));
      return yield* Effect.forEach(rows, (row) => decodeRow(row, rowIdOf(row)));
    });

  return {
    createOrSelect,
    getByObject,
    getByThread,
    getById,
    list,
  } satisfies WorkjetCrossModeLinkStoreShape;
});

export const WorkjetCrossModeLinkStoreLive = Layer.effect(WorkjetCrossModeLinkStore, make);
