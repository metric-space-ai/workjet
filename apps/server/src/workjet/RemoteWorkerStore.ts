// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { RemoteWorkerDispatchError, RemoteWorkerRequest, RemoteWorkerResponse, TrimmedNonEmptyString } from "@workjet/contracts";
import * as NodeUtil from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../persistence/Errors.ts";

export type RemoteWorkerDirection = "outbound" | "inbound";
export type RemoteWorkerStoreError = RemoteWorkerDispatchError | PersistenceSqlError;
export interface RemoteWorkerReceipt {
  readonly request: RemoteWorkerRequest;
  readonly response: RemoteWorkerResponse | null;
  readonly worktreePath: string | null;
}
export interface RemoteWorkerStoreShape {
  readonly put: (direction: RemoteWorkerDirection, request: RemoteWorkerRequest) => Effect.Effect<void, RemoteWorkerStoreError>;
  readonly get: (direction: RemoteWorkerDirection, requestId: string) => Effect.Effect<Option.Option<RemoteWorkerReceipt>, RemoteWorkerStoreError>;
  readonly pendingOutbound: Effect.Effect<ReadonlyArray<RemoteWorkerRequest>, RemoteWorkerStoreError>;
  readonly complete: (direction: RemoteWorkerDirection, response: RemoteWorkerResponse) => Effect.Effect<void, RemoteWorkerStoreError>;
  readonly recordWorktree: (requestId: string, worktreePath: string) => Effect.Effect<void, RemoteWorkerStoreError>;
}
export class RemoteWorkerStore extends Context.Service<RemoteWorkerStore, RemoteWorkerStoreShape>()("t3/workjet/RemoteWorkerStore") {}

const ReceiptRow = Schema.Struct({
  request: Schema.fromJsonString(RemoteWorkerRequest),
  response: Schema.NullOr(Schema.fromJsonString(RemoteWorkerResponse)),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
const decodeRow = Schema.decodeUnknownEffect(ReceiptRow);
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(RemoteWorkerRequest));
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(RemoteWorkerRequest));
const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(RemoteWorkerResponse));
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(RemoteWorkerResponse));
const decodePath = Schema.decodeUnknownEffect(TrimmedNonEmptyString);
const conflict = () => new RemoteWorkerDispatchError({ reason: "request-conflict" });
const invalid = () => new RemoteWorkerDispatchError({ reason: "invalid-request" });
const sqlFailure = (operation: string) => (cause: unknown) => new PersistenceSqlError({ operation, cause });

/** Persist prepared requests before filesystem work. The first request and
 * outcome are immutable, including across reconnects and server restarts. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get = Effect.fn("RemoteWorkerStore.get")(function* (direction: RemoteWorkerDirection, requestId: string) {
    const rows = yield* sql`
      SELECT request_json AS "request", response_json AS "response", worktree_path AS "worktreePath"
      FROM workjet_remote_worker_receipts WHERE direction = ${direction} AND request_id = ${requestId}
    `.pipe(Effect.mapError(sqlFailure("RemoteWorkerStore.get")));
    if (rows[0] === undefined) return Option.none<RemoteWorkerReceipt>();
    const receipt = yield* decodeRow(rows[0]).pipe(Effect.mapError(sqlFailure("RemoteWorkerStore.get:decode")));
    if (receipt.request.requestId !== requestId || (receipt.response !== null && receipt.response.requestId !== requestId)) {
      return yield* new PersistenceSqlError({ operation: "RemoteWorkerStore.get:decode", detail: "Receipt request ID does not match its key" });
    }
    return Option.some(receipt);
  });

  const requireReceipt = Effect.fn("RemoteWorkerStore.requireReceipt")(function* (direction: RemoteWorkerDirection, requestId: string) {
    const receipt = yield* get(direction, requestId);
    if (Option.isNone(receipt)) return yield* invalid();
    return receipt.value;
  });

  const put = Effect.fn("RemoteWorkerStore.put")(function* (direction: RemoteWorkerDirection, request: RemoteWorkerRequest) {
    const requestJson = yield* encodeRequest(request).pipe(Effect.mapError(invalid));
    const normalized = yield* decodeRequest(requestJson).pipe(Effect.mapError(invalid));
    yield* sql`
      INSERT INTO workjet_remote_worker_receipts(direction, request_id, request_json, created_at)
      VALUES (${direction}, ${normalized.requestId}, ${requestJson}, ${normalized.createdAt})
      ON CONFLICT(direction, request_id) DO NOTHING
    `.pipe(Effect.mapError(sqlFailure("RemoteWorkerStore.put")));
    const receipt = yield* requireReceipt(direction, normalized.requestId);
    if (!NodeUtil.isDeepStrictEqual(receipt.request, normalized)) return yield* conflict();
  });

  const complete = Effect.fn("RemoteWorkerStore.complete")(function* (direction: RemoteWorkerDirection, response: RemoteWorkerResponse) {
    const responseJson = yield* encodeResponse(response).pipe(Effect.mapError(invalid));
    const normalized = yield* decodeResponse(responseJson).pipe(Effect.mapError(invalid));
    // Compare-and-set keeps concurrent completions from replacing the winner.
    yield* sql`
      UPDATE workjet_remote_worker_receipts SET response_json = ${responseJson}
      WHERE direction = ${direction} AND request_id = ${normalized.requestId} AND response_json IS NULL
    `.pipe(Effect.mapError(sqlFailure("RemoteWorkerStore.complete")));
    const receipt = yield* requireReceipt(direction, normalized.requestId);
    if (!NodeUtil.isDeepStrictEqual(receipt.response, normalized)) return yield* conflict();
  });

  const recordWorktree = Effect.fn("RemoteWorkerStore.recordWorktree")(function* (requestId: string, worktreePath: string) {
    const normalized = yield* decodePath(worktreePath).pipe(Effect.mapError(invalid));
    yield* sql`
      UPDATE workjet_remote_worker_receipts SET worktree_path = ${normalized}
      WHERE direction = 'inbound' AND request_id = ${requestId} AND worktree_path IS NULL
    `.pipe(Effect.mapError(sqlFailure("RemoteWorkerStore.recordWorktree")));
    const receipt = yield* requireReceipt("inbound", requestId);
    if (receipt.worktreePath !== normalized) return yield* conflict();
  });

  const pendingOutbound = Effect.gen(function* () {
    const rows = yield* sql`
      SELECT request_json AS "request", response_json AS "response", worktree_path AS "worktreePath"
      FROM workjet_remote_worker_receipts WHERE direction = 'outbound' AND response_json IS NULL
      ORDER BY created_at, request_id LIMIT 128
    `.pipe(Effect.mapError(sqlFailure("RemoteWorkerStore.pendingOutbound")));
    return yield* Effect.forEach(rows, (row) => decodeRow(row).pipe(
      Effect.mapError(sqlFailure("RemoteWorkerStore.pendingOutbound:decode")),
      Effect.map((receipt) => receipt.request),
    ));
  });

  return RemoteWorkerStore.of({ put, get, pendingOutbound, complete, recordWorktree });
});
export const layer = Layer.effect(RemoteWorkerStore, make);
