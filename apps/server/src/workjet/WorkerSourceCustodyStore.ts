// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { RemoteWorkerHarness, TrimmedNonEmptyString } from "@workjet/contracts";
import * as NodeUtil from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PersistenceSqlError } from "../persistence/Errors.ts";

export class WorkerSourceCustodyError extends Schema.TaggedErrorClass<WorkerSourceCustodyError>()(
  "WorkerSourceCustodyError",
  { reason: Schema.Literals(["invalid", "conflict"]) },
) {}

export const WorkerSourceCustodyIntent = Schema.Struct({
  workerId: TrimmedNonEmptyString,
  sourceEnvironmentId: TrimmedNonEmptyString,
  targetEnvironmentId: TrimmedNonEmptyString,
  requestDigest: TrimmedNonEmptyString,
  harness: RemoteWorkerHarness,
  model: TrimmedNonEmptyString,
  profileRoot: TrimmedNonEmptyString,
});
export type WorkerSourceCustodyIntent = typeof WorkerSourceCustodyIntent.Type;
const FileCapture = Schema.Struct({
  path: TrimmedNonEmptyString,
  identity: Schema.Struct({
    device: TrimmedNonEmptyString,
    inode: TrimmedNonEmptyString,
  }),
});
export const WorkerSourceProfileCustody = Schema.Struct({ root: FileCapture, profile: FileCapture });
export type WorkerSourceProfileCustody = typeof WorkerSourceProfileCustody.Type;
export const WorkerSourceRuntimeCustody = Schema.Struct({
  command: TrimmedNonEmptyString,
  runtimeFiles: Schema.Array(FileCapture),
});
export type WorkerSourceRuntimeCustody = typeof WorkerSourceRuntimeCustody.Type;
const Receipt = Schema.Struct({
  intent: WorkerSourceCustodyIntent,
  profile: Schema.NullOr(WorkerSourceProfileCustody),
  runtime: Schema.NullOr(WorkerSourceRuntimeCustody),
});
export type WorkerSourceCustodyReceipt = typeof Receipt.Type;
type StoreError = WorkerSourceCustodyError | PersistenceSqlError;

export class WorkerSourceCustodyStore extends Context.Service<WorkerSourceCustodyStore, {
  readonly reserve: (intent: WorkerSourceCustodyIntent) => Effect.Effect<WorkerSourceCustodyReceipt, StoreError>;
  readonly get: (workerId: string) => Effect.Effect<Option.Option<WorkerSourceCustodyReceipt>, StoreError>;
  readonly captureProfile: (workerId: string, capture: WorkerSourceProfileCustody) => Effect.Effect<void, StoreError>;
  readonly captureRuntime: (workerId: string, capture: WorkerSourceRuntimeCustody) => Effect.Effect<void, StoreError>;
}>()("workjet/workjet/WorkerSourceCustodyStore") {}

const failure = (reason: "invalid" | "conflict") => new WorkerSourceCustodyError({ reason });
const sqlFailure = (operation: string) => (cause: unknown) => new PersistenceSqlError({ operation, cause });
const decode = Schema.decodeUnknownEffect(Schema.Struct({
  intent: Schema.fromJsonString(WorkerSourceCustodyIntent),
  profile: Schema.NullOr(Schema.fromJsonString(WorkerSourceProfileCustody)),
  runtime: Schema.NullOr(Schema.fromJsonString(WorkerSourceRuntimeCustody)),
}));
const encodeIntent = Schema.encodeEffect(Schema.fromJsonString(WorkerSourceCustodyIntent));
const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(WorkerSourceProfileCustody));
const encodeRuntime = Schema.encodeEffect(Schema.fromJsonString(WorkerSourceRuntimeCustody));

/** Metadata records the original Source allocation, never a capability or account secret.
 * First profile/runtime captures are immutable across database and server restarts. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = Effect.fn("WorkerSourceCustodyStore.get")(function* (workerId: string) {
    const rows = yield* sql`
      SELECT intent_json AS intent, profile_json AS profile, runtime_json AS runtime, profile_root
      FROM workjet_worker_source_custody WHERE worker_id = ${workerId}
    `.pipe(Effect.mapError(sqlFailure("WorkerSourceCustodyStore.get")));
    if (rows[0] === undefined) return Option.none<WorkerSourceCustodyReceipt>();
    const receipt = yield* decode(rows[0]).pipe(Effect.mapError(sqlFailure("WorkerSourceCustodyStore.decode")));
    if (receipt.intent.workerId !== workerId || receipt.intent.profileRoot !== rows[0].profile_root)
      return yield* failure("invalid");
    return Option.some(receipt);
  });
  const requireReceipt = Effect.fn("WorkerSourceCustodyStore.require")(function* (workerId: string) {
    const receipt = yield* get(workerId);
    if (Option.isNone(receipt)) return yield* failure("invalid");
    return receipt.value;
  });
  const reserve = Effect.fn("WorkerSourceCustodyStore.reserve")(function* (intent: WorkerSourceCustodyIntent) {
    const json = yield* encodeIntent(intent).pipe(Effect.mapError(() => failure("invalid")));
    yield* sql`
      INSERT INTO workjet_worker_source_custody(worker_id, intent_json, profile_root)
      VALUES (${intent.workerId}, ${json}, ${intent.profileRoot}) ON CONFLICT DO NOTHING
    `.pipe(Effect.mapError(sqlFailure("WorkerSourceCustodyStore.reserve")));
    const receipt = yield* requireReceipt(intent.workerId);
    if (!NodeUtil.isDeepStrictEqual(receipt.intent, intent)) return yield* failure("conflict");
    return receipt;
  });
  const captureProfile = Effect.fn("WorkerSourceCustodyStore.captureProfile")(function* (
    workerId: string, capture: WorkerSourceProfileCustody,
  ) {
    const receipt = yield* requireReceipt(workerId);
    if (capture.root.path !== receipt.intent.profileRoot) return yield* failure("invalid");
    const json = yield* encodeProfile(capture).pipe(Effect.mapError(() => failure("invalid")));
    yield* sql`
      UPDATE workjet_worker_source_custody SET profile_json = ${json}
      WHERE worker_id = ${workerId} AND profile_json IS NULL
    `.pipe(Effect.mapError(sqlFailure("WorkerSourceCustodyStore.captureProfile")));
    if (!NodeUtil.isDeepStrictEqual((yield* requireReceipt(workerId)).profile, capture))
      return yield* failure("conflict");
  });
  const captureRuntime = Effect.fn("WorkerSourceCustodyStore.captureRuntime")(function* (
    workerId: string, capture: WorkerSourceRuntimeCustody,
  ) {
    const receipt = yield* requireReceipt(workerId);
    if (receipt.profile === null || capture.runtimeFiles.length === 0 ||
      capture.runtimeFiles[0]?.path !== capture.command) return yield* failure("invalid");
    const json = yield* encodeRuntime(capture).pipe(Effect.mapError(() => failure("invalid")));
    yield* sql`
      UPDATE workjet_worker_source_custody SET runtime_json = ${json}
      WHERE worker_id = ${workerId} AND runtime_json IS NULL
    `.pipe(Effect.mapError(sqlFailure("WorkerSourceCustodyStore.captureRuntime")));
    if (!NodeUtil.isDeepStrictEqual((yield* requireReceipt(workerId)).runtime, capture))
      return yield* failure("conflict");
  });
  return WorkerSourceCustodyStore.of({ get, reserve, captureProfile, captureRuntime });
});
export const layer = Layer.effect(WorkerSourceCustodyStore, make);
