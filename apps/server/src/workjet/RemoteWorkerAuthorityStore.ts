// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeUtil from "node:util";
import {
  RemoteWorkerDispatchError,
  RemoteWorkerRequest,
  WorkjetConnectionId,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  RemoteWorkerNativeBinding,
  RemoteWorkerNativeReceipt,
  remoteWorkerRequestDigest,
} from "./ctox/CtoxRemoteWorkerAdmission.ts";

export const RemoteWorkerAuthorityIntent = Schema.Struct({
  request: RemoteWorkerRequest,
  scope: Schema.Struct({ connectionId: WorkjetConnectionId, instanceId: Schema.String }),
  binding: RemoteWorkerNativeBinding,
});
export type RemoteWorkerAuthorityIntent = typeof RemoteWorkerAuthorityIntent.Type;
export interface RemoteWorkerAuthorityRecord {
  readonly intent: RemoteWorkerAuthorityIntent;
  readonly receipt: RemoteWorkerNativeReceipt | null;
}
export type RemoteWorkerAuthorityStoreError = RemoteWorkerDispatchError | PersistenceSqlError;
export interface RemoteWorkerAuthorityStoreShape {
  readonly prepare: (
    intent: RemoteWorkerAuthorityIntent,
  ) => Effect.Effect<void, RemoteWorkerAuthorityStoreError>;
  readonly get: (
    id: string,
  ) => Effect.Effect<Option.Option<RemoteWorkerAuthorityRecord>, RemoteWorkerAuthorityStoreError>;
  /** Compare-and-set. A lost ACK may replay the winner; a competing renewal must reread. */
  readonly saveReceipt: (
    id: string,
    expected: RemoteWorkerNativeReceipt | null,
    next: RemoteWorkerNativeReceipt,
  ) => Effect.Effect<void, RemoteWorkerAuthorityStoreError>;
}
export class RemoteWorkerAuthorityStore extends Context.Service<
  RemoteWorkerAuthorityStore,
  RemoteWorkerAuthorityStoreShape
>()("workjet/workjet/RemoteWorkerAuthorityStore") {}

const conflict = () => new RemoteWorkerDispatchError({ reason: "request-conflict" });
const invalid = () => new RemoteWorkerDispatchError({ reason: "invalid-request" });
const sqlFailure = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });
const intentJson = Schema.fromJsonString(RemoteWorkerAuthorityIntent);
const receiptJson = Schema.fromJsonString(RemoteWorkerNativeReceipt);
const rowSchema = Schema.Struct({ intent: intentJson, receipt: Schema.NullOr(receiptJson) });

/** The immutable intent is committed before calling native issue. Native issue,
 * claim and renew retry with this same key after loss; no second worker is minted. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = Effect.fn("RemoteWorkerAuthorityStore.get")(function* (id: string) {
    const rows = yield* sql`SELECT intent_json AS "intent", receipt_json AS "receipt"
      FROM workjet_remote_worker_authority WHERE request_id = ${id}`.pipe(
      Effect.mapError(sqlFailure("RemoteWorkerAuthorityStore.get")),
    );
    if (rows[0] === undefined) return Option.none<RemoteWorkerAuthorityRecord>();
    const row = yield* Schema.decodeUnknownEffect(rowSchema)(rows[0]).pipe(
      Effect.mapError(sqlFailure("RemoteWorkerAuthorityStore.decode")),
    );
    if (
      row.intent.request.requestId !== id ||
      row.intent.binding.requestId !== id ||
      !NodeUtil.isDeepStrictEqual(
        row.intent.binding.executionPolicy,
        row.intent.request.executionPolicy) ||
      (row.receipt !== null && !NodeUtil.isDeepStrictEqual(row.receipt.binding, row.intent.binding))
    )
      return yield* invalid();
    return Option.some(row);
  });
  const prepare = Effect.fn("RemoteWorkerAuthorityStore.prepare")(function* (
    intent: RemoteWorkerAuthorityIntent,
  ) {
    const json = yield* Schema.encodeEffect(intentJson)(intent).pipe(Effect.mapError(invalid));
    const normalized = yield* Schema.decodeUnknownEffect(intentJson)(json).pipe(
      Effect.mapError(invalid),
    );
    const { request, scope, binding } = normalized;
    if (
      binding.requestId !== request.requestId ||
      binding.workspaceKey !== request.requestId ||
      binding.requestDigest !== (yield* remoteWorkerRequestDigest(request)) ||
      binding.sourceEnvironmentId !== request.parent.environmentId ||
      binding.sourceSupervisorThreadId !== request.parent.threadId ||
      binding.sourceInstanceId !== scope.instanceId ||
      binding.targetEnvironmentId !== request.targetEnvironmentId ||
      binding.projectId !== request.project.id ||
      !NodeUtil.isDeepStrictEqual(binding.executionPolicy, request.executionPolicy) ||
      (binding.executionPolicy !== undefined &&
        binding.executionPolicy.projectId !== binding.projectId) ||
      binding.repositoryHead !== request.revision
    )
      return yield* invalid();
    yield* sql`INSERT INTO workjet_remote_worker_authority(request_id,intent_json,created_at)
      VALUES(${request.requestId},${json},${request.createdAt})
      ON CONFLICT(request_id) DO NOTHING`.pipe(
      Effect.mapError(sqlFailure("RemoteWorkerAuthorityStore.prepare")),
    );
    const saved = Option.getOrUndefined(yield* get(request.requestId));
    if (!saved || !NodeUtil.isDeepStrictEqual(saved.intent, normalized)) return yield* conflict();
  });
  const saveReceipt = Effect.fn("RemoteWorkerAuthorityStore.saveReceipt")(function* (
    id: string,
    expected: RemoteWorkerNativeReceipt | null,
    next: RemoteWorkerNativeReceipt,
  ) {
    const record = Option.getOrUndefined(yield* get(id));
    if (!record || !NodeUtil.isDeepStrictEqual(next.binding, record.intent.binding))
      return yield* invalid();
    if (NodeUtil.isDeepStrictEqual(record.receipt, next)) return;
    if (!NodeUtil.isDeepStrictEqual(record.receipt, expected)) return yield* conflict();
    if (
      expected !== null &&
      (next.permitId !== expected.permitId ||
        next.ownerUserId !== expected.ownerUserId ||
        next.authorityEpoch !== expected.authorityEpoch ||
        next.authorityFingerprint !== expected.authorityFingerprint ||
        expected.state === "revoked" ||
        (expected.state === "claimed" &&
          (next.state === "issued" || next.executionId !== expected.executionId)) ||
        next.renewalSequence < expected.renewalSequence ||
        next.renewalSequence > expected.renewalSequence + 1 ||
        (next.renewalSequence === expected.renewalSequence &&
          next.expiresAtMs !== expected.expiresAtMs) ||
        (next.renewalSequence > expected.renewalSequence &&
          next.expiresAtMs < expected.expiresAtMs))
    )
      return yield* conflict();
    const json = yield* Schema.encodeEffect(receiptJson)(next).pipe(Effect.mapError(invalid));
    const previous =
      expected === null
        ? null
        : yield* Schema.encodeEffect(receiptJson)(expected).pipe(Effect.mapError(invalid));
    yield* sql`UPDATE workjet_remote_worker_authority SET receipt_json = ${json}
      WHERE request_id = ${id} AND receipt_json IS ${previous}`.pipe(
      Effect.mapError(sqlFailure("RemoteWorkerAuthorityStore.saveReceipt")),
    );
    const saved = Option.getOrUndefined(yield* get(id));
    if (!saved || !NodeUtil.isDeepStrictEqual(saved.receipt, next)) return yield* conflict();
  });
  return RemoteWorkerAuthorityStore.of({ prepare, get, saveReceipt });
});
export const layer = Layer.effect(RemoteWorkerAuthorityStore, make);
