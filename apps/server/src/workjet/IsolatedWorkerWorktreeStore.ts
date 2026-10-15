// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { TrimmedNonEmptyString } from "@workjet/contracts";
import * as NodeUtil from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../persistence/Errors.ts";

export class IsolatedWorkerWorktreeError extends Schema.TaggedErrorClass<IsolatedWorkerWorktreeError>()(
  "IsolatedWorkerWorktreeError",
  {
    reason: Schema.Literals([
      "conflict",
      "invalid",
      "unavailable",
      "identity",
      "git",
      "publication",
    ]),
  },
) {}

export const IsolatedWorkerWorktreeIntent = Schema.Struct({
  workerId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  repositoryKey: TrimmedNonEmptyString,
  repositoryUrl: TrimmedNonEmptyString,
  sourceCwd: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  destination: TrimmedNonEmptyString,
  authorityDigest: TrimmedNonEmptyString,
});
export type IsolatedWorkerWorktreeIntent = typeof IsolatedWorkerWorktreeIntent.Type;

export const IsolatedWorkerWorktreeCustody = Schema.Struct({
  kind: Schema.Literal("isolated"),
  worktreePath: TrimmedNonEmptyString,
  worktreeDev: TrimmedNonEmptyString,
  worktreeIno: TrimmedNonEmptyString,
  adminPath: TrimmedNonEmptyString,
  adminDev: TrimmedNonEmptyString,
  adminIno: TrimmedNonEmptyString,
});
export type IsolatedWorkerWorktreeCustody = typeof IsolatedWorkerWorktreeCustody.Type;
export const IsolatedWorkerWorktreeReceipt = Schema.Struct({
  intent: IsolatedWorkerWorktreeIntent,
  custody: Schema.NullOr(IsolatedWorkerWorktreeCustody),
});
export type IsolatedWorkerWorktreeReceipt = typeof IsolatedWorkerWorktreeReceipt.Type;

type StoreError = IsolatedWorkerWorktreeError | PersistenceSqlError;
export class IsolatedWorkerWorktreeStore extends Context.Service<
  IsolatedWorkerWorktreeStore,
  {
    readonly reserve: (
      intent: IsolatedWorkerWorktreeIntent,
    ) => Effect.Effect<IsolatedWorkerWorktreeReceipt, StoreError>;
    readonly get: (
      workerId: string,
    ) => Effect.Effect<Option.Option<IsolatedWorkerWorktreeReceipt>, StoreError>;
    readonly capture: (
      workerId: string,
      custody: IsolatedWorkerWorktreeCustody,
    ) => Effect.Effect<IsolatedWorkerWorktreeReceipt, StoreError>;
  }
>()("workjet/workjet/IsolatedWorkerWorktreeStore") {}

const decodeRow = Schema.decodeUnknownEffect(
  Schema.Struct({
    intent: Schema.fromJsonString(IsolatedWorkerWorktreeIntent),
    custody: Schema.NullOr(Schema.fromJsonString(IsolatedWorkerWorktreeCustody)),
  }),
);
const encodeIntent = Schema.encodeEffect(Schema.fromJsonString(IsolatedWorkerWorktreeIntent));
const encodeCustody = Schema.encodeEffect(Schema.fromJsonString(IsolatedWorkerWorktreeCustody));
const invalid = () => new IsolatedWorkerWorktreeError({ reason: "invalid" });
const conflict = () => new IsolatedWorkerWorktreeError({ reason: "conflict" });
const sqlFailure = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });

/** The original intent and pre-publication inode capture are immutable.
 * Publication needs no second DB write: a lost acknowledgement is resolved
 * against this same capture at either the staging or destination path. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = Effect.fn("IsolatedWorkerWorktreeStore.get")(function* (workerId: string) {
    const rows = yield* sql`
      SELECT intent_json AS intent, custody_json AS custody, destination
      FROM workjet_isolated_worker_worktrees WHERE worker_id = ${workerId}
    `.pipe(Effect.mapError(sqlFailure("IsolatedWorkerWorktreeStore.get")));
    if (rows[0] === undefined) return Option.none<IsolatedWorkerWorktreeReceipt>();
    const receipt = yield* decodeRow(rows[0]).pipe(
      Effect.mapError(sqlFailure("IsolatedWorkerWorktreeStore.decode")),
    );
    if (receipt.intent.workerId !== workerId || receipt.intent.destination !== rows[0].destination)
      return yield* invalid();
    return Option.some(receipt);
  });
  const requireReceipt = Effect.fn("IsolatedWorkerWorktreeStore.require")(function* (
    workerId: string,
  ) {
    const receipt = yield* get(workerId);
    if (Option.isNone(receipt)) return yield* invalid();
    return receipt.value;
  });
  const reserve = Effect.fn("IsolatedWorkerWorktreeStore.reserve")(function* (
    intent: IsolatedWorkerWorktreeIntent,
  ) {
    const json = yield* encodeIntent(intent).pipe(Effect.mapError(invalid));
    yield* sql`
      INSERT INTO workjet_isolated_worker_worktrees(worker_id, intent_json, destination)
      VALUES (${intent.workerId}, ${json}, ${intent.destination}) ON CONFLICT DO NOTHING
    `.pipe(Effect.mapError(sqlFailure("IsolatedWorkerWorktreeStore.reserve")));
    const receipt = yield* get(intent.workerId);
    if (Option.isNone(receipt) || !NodeUtil.isDeepStrictEqual(receipt.value.intent, intent))
      return yield* conflict();
    return receipt.value;
  });
  const capture = Effect.fn("IsolatedWorkerWorktreeStore.capture")(function* (
    workerId: string,
    custody: IsolatedWorkerWorktreeCustody,
  ) {
    const json = yield* encodeCustody(custody).pipe(Effect.mapError(invalid));
    yield* sql`
      UPDATE workjet_isolated_worker_worktrees SET custody_json = ${json}
      WHERE worker_id = ${workerId} AND custody_json IS NULL
    `.pipe(Effect.mapError(sqlFailure("IsolatedWorkerWorktreeStore.capture")));
    const receipt = yield* requireReceipt(workerId);
    if (!NodeUtil.isDeepStrictEqual(receipt.custody, custody)) return yield* conflict();
    return receipt;
  });
  return IsolatedWorkerWorktreeStore.of({ get, reserve, capture });
});
export const layer = Layer.effect(IsolatedWorkerWorktreeStore, make);
