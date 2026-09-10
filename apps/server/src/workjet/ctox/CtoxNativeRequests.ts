// @effect-diagnostics nodeBuiltinImport:off -- Server-only SHA-256 pins opaque credentials without storing the bearer token.
import * as NodeCrypto from "node:crypto";
import {
  WorkjetCtoxBusinessOsInput,
  WorkjetCtoxCrewRequest,
  WorkjetCtoxCrewReceipt,
  ProviderInstanceId,
  type ThreadId,
  type WorkjetConnectionId,
} from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { CtoxMcpTarget } from "./CtoxMcpTransport.ts";

export type NativeTaskRequest =
  | WorkjetCtoxCrewRequest
  | (Extract<
      WorkjetCtoxBusinessOsInput["request"],
      { readonly operation: "create_app" | "modify_app" | "delegate_task" }
    > & { readonly idempotency_key: string });

export interface CtoxNativeRequestIdentity {
  readonly threadId: ThreadId;
  readonly connectionId: WorkjetConnectionId;
  readonly instanceId: string;
  readonly requestKey: string;
}

export interface NativeTaskReference {
  readonly request: NativeTaskRequest;
  readonly instanceId: string;
  readonly commandId: string | null;
  readonly taskId: string | null;
  readonly preparedAt: number;
  readonly receivedAt: number | null;
}

export class CtoxNativeRequestError extends Schema.TaggedErrorClass<CtoxNativeRequestError>()(
  "CtoxNativeRequestError",
  {
    reason: Schema.Literals([
      "native-request-conflict",
      "native-request-credentials-changed",
      "native-request-not-found",
      "native-request-store-unavailable",
      "native-task-reference-conflict",
      "native-response-invalid",
      "ctox-operation-rejected",
    ]),
  },
) {}
const failure = (reason: CtoxNativeRequestError["reason"]) =>
  new CtoxNativeRequestError({ reason });
const unavailable = () => failure("native-request-store-unavailable");
const IntentCodec = Schema.fromJsonString(
  Schema.Struct({
    request: Schema.Union([WorkjetCtoxBusinessOsInput.fields.request, WorkjetCtoxCrewRequest]),
  }),
);
const encodeIntent = Schema.encodeEffect(IntentCodec);
const decodeIntent = Schema.decodeUnknownEffect(IntentCodec);
const Rows = Schema.Array(
  Schema.Struct({
    connectionId: Schema.String,
    instanceId: Schema.String,
    intentJson: Schema.String,
    targetDigest: Schema.String,
    remoteRequestKey: Schema.String,
    preparedAt: Schema.Number,
    commandId: Schema.NullOr(Schema.String),
    taskId: Schema.NullOr(Schema.String),
    receivedAt: Schema.NullOr(Schema.Number),
  }),
);
const Receipt = Schema.Struct({
  module_id: Schema.String,
  command_type: Schema.String,
  command_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  task_id: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  ),
});

const NativeTurns = Schema.Array(
  Schema.Struct({ requestId: Schema.String, requestKey: Schema.String }),
);

const CrewStartId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const CrewStartBinding = Schema.Struct({
  attemptId: CrewStartId,
  commandId: CrewStartId,
  taskId: CrewStartId,
  executorId: CrewStartId,
  memberId: CrewStartId,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  providerThreadId: Schema.NullOr(CrewStartId),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const load = (identity: CtoxNativeRequestIdentity) =>
    sql`
    SELECT connection_id AS "connectionId", instance_id AS "instanceId",
      intent_json AS "intentJson", target_digest AS "targetDigest", remote_request_key AS "remoteRequestKey",
      prepared_at_ms AS "preparedAt", command_id AS "commandId",
      task_id AS "taskId", received_at_ms AS "receivedAt"
    FROM workjet_ctox_native_requests
    WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
  `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
      Effect.mapError(unavailable),
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (!row) return Effect.fail(failure("native-request-not-found"));
        if (row.connectionId !== identity.connectionId || row.instanceId !== identity.instanceId)
          return Effect.fail(failure("native-request-conflict"));
        return Effect.succeed(row);
      }),
    );

  const prepare = Effect.fn("CtoxNativeRequests.prepare")(function* (
    identity: CtoxNativeRequestIdentity,
    request: NativeTaskRequest,
    target: CtoxMcpTarget,
  ) {
    if (request.idempotency_key !== identity.requestKey)
      return yield* failure("native-request-conflict");
    const intentJson = yield* encodeIntent({ request }).pipe(Effect.mapError(unavailable));
    // Until CTOX exposes a durable authenticated-principal identity, a changed
    // credential may denote another actor (and thus another remote retry scope).
    // Keep retries pinned rather than accidentally creating a task.
    const encodedTarget = yield* encodeIntentTarget([target.endpoint, target.token]).pipe(
      Effect.mapError(unavailable),
    );
    const targetDigest = NodeCrypto.createHash("sha256").update(encodedTarget).digest("hex");
    const now = yield* Clock.currentTimeMillis;
    // A client may use "request-1" in more than one thread. Allocate a native
    // key once per durable claim so those independent requests never coalesce.
    const remoteRequestKey = `workjet_${NodeCrypto.randomUUID()}`;
    yield* sql`
      INSERT INTO workjet_ctox_native_requests
        (thread_id, request_key, remote_request_key, connection_id, instance_id, intent_json, target_digest, prepared_at_ms)
      VALUES (${identity.threadId}, ${identity.requestKey}, ${remoteRequestKey}, ${identity.connectionId}, ${identity.instanceId}, ${intentJson}, ${targetDigest}, ${now})
      ON CONFLICT(thread_id, request_key) DO NOTHING
    `.pipe(Effect.mapError(unavailable));
    const row = yield* load(identity);
    if (row.intentJson !== intentJson) return yield* failure("native-request-conflict");
    if (row.targetDigest !== targetDigest)
      return yield* failure("native-request-credentials-changed");
    return row.remoteRequestKey;
  });

  const verifyTarget = Effect.fn("CtoxNativeRequests.verifyTarget")(function* (
    identity: CtoxNativeRequestIdentity,
    target: CtoxMcpTarget,
  ) {
    const row = yield* load(identity);
    const encodedTarget = yield* encodeIntentTarget([target.endpoint, target.token]).pipe(
      Effect.mapError(unavailable),
    );
    const digest = NodeCrypto.createHash("sha256").update(encodedTarget).digest("hex");
    if (row.targetDigest !== digest) return yield* failure("native-request-credentials-changed");
  });

  const recordReceipt = Effect.fn("CtoxNativeRequests.recordReceipt")(function* (
    identity: CtoxNativeRequestIdentity,
    value: unknown,
  ) {
    const row = yield* load(identity);
    const { request } = yield* decodeIntent(row.intentJson).pipe(Effect.mapError(unavailable));
    const receipt =
      request.operation === "start_crew_execution"
        ? yield* Schema.decodeUnknownEffect(WorkjetCtoxCrewReceipt)(value).pipe(
            Effect.mapError(() => failure("native-response-invalid")),
          )
        : yield* Schema.decodeUnknownEffect(Receipt)(value).pipe(
            Effect.mapError(() => failure("native-response-invalid")),
          );
    if (request.operation === "start_crew_execution") {
      if (!("thread_id" in receipt) || receipt.thread_id !== request.thread_id)
        return yield* failure("native-response-invalid");
    } else if (
      !("module_id" in receipt) ||
      (request.operation !== "create_app" &&
        request.operation !== "modify_app" &&
        request.operation !== "delegate_task") ||
      receipt.module_id !== request.module_id ||
      receipt.command_type !==
        (request.operation === "create_app"
          ? "ctox.business_os.app.create"
          : request.operation === "modify_app"
            ? "ctox.business_os.app.modify"
            : "ctox.delegate_task")
    ) {
      return yield* failure("native-response-invalid");
    }
    const now = yield* Clock.currentTimeMillis;
    const taskId = receipt.task_id ?? null;
    const updated = yield* sql`
      UPDATE workjet_ctox_native_requests
      SET command_id = ${receipt.command_id}, task_id = COALESCE(task_id, ${taskId}),
        received_at_ms = COALESCE(received_at_ms, ${now})
      WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
        AND (command_id IS NULL OR command_id = ${receipt.command_id})
        AND (${taskId} IS NULL OR task_id IS NULL OR task_id IS ${taskId})
      RETURNING request_key
    `.pipe(Effect.mapError(unavailable));
    if (updated.length !== 1) return yield* failure("native-task-reference-conflict");
  });

  /** Bind a task assigned after command acceptance, without changing an existing binding. */
  const recordObservedTask = Effect.fn("CtoxNativeRequests.recordObservedTask")(function* (
    identity: CtoxNativeRequestIdentity,
    commandId: string,
    taskId: string,
  ) {
    yield* Schema.decodeUnknownEffect(Receipt.fields.command_id)(taskId).pipe(
      Effect.mapError(() => failure("native-response-invalid")),
    );
    const row = yield* load(identity);
    if (row.commandId !== commandId) return yield* failure("native-task-reference-conflict");
    const updated = yield* sql`
      UPDATE workjet_ctox_native_requests SET task_id = ${taskId}
      WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
        AND connection_id = ${identity.connectionId} AND instance_id = ${identity.instanceId}
        AND command_id = ${commandId} AND (task_id IS NULL OR task_id = ${taskId})
      RETURNING request_key
    `.pipe(Effect.mapError(unavailable));
    if (updated.length !== 1) return yield* failure("native-task-reference-conflict");
  });

  const get = Effect.fn("CtoxNativeRequests.get")(function* (identity: CtoxNativeRequestIdentity) {
    const row = yield* load(identity);
    const { request } = yield* decodeIntent(row.intentJson).pipe(Effect.mapError(unavailable));
    if (
      (request.operation !== "create_app" &&
        request.operation !== "modify_app" &&
        request.operation !== "delegate_task" &&
        request.operation !== "start_crew_execution") ||
      !request.idempotency_key
    )
      return yield* unavailable();
    return {
      request: { ...request, idempotency_key: request.idempotency_key },
      instanceId: row.instanceId,
      commandId: row.commandId,
      taskId: row.taskId,
      preparedAt: row.preparedAt,
      receivedAt: row.receivedAt,
    } satisfies NativeTaskReference;
  });
  const readCrewStart = Effect.fn("CtoxNativeRequests.readCrewStart")(function* (
    requestIdentity: CtoxNativeRequestIdentity,
    attemptId: string,
  ) {
    const identity = { ...requestIdentity };
    yield* load(identity);
    const rows = yield* sql`
      SELECT attempt_id AS "attemptId", command_id AS "commandId", task_id AS "taskId",
        executor_id AS "executorId", member_id AS "memberId",
        provider_instance_id AS "providerInstanceId", provider_thread_id AS "providerThreadId"
      FROM workjet_ctox_crew_starts
      WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
        AND attempt_id = ${attemptId}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CrewStartBinding))),
      Effect.mapError(() => failure("native-task-reference-conflict")),
    );
    const row = rows[0] ?? null;
    if (row && (row.providerInstanceId === null) !== (row.providerThreadId === null))
      return yield* failure("native-task-reference-conflict");
    return row;
  });

  /**
   * Pin an existing reservation to one provider instance and provider thread.
   * Legacy rows remain unassigned. Once assigned, the pair is immutable and
   * exact retries return the same binding.
   */
  const bindCrewStartProvider = Effect.fn("CtoxNativeRequests.bindCrewStartProvider")(
    function* (
      requestIdentity: CtoxNativeRequestIdentity,
      attemptId: string,
      providerInstanceId: typeof ProviderInstanceId.Type,
      providerThreadId: string,
    ) {
      const identity = { ...requestIdentity };
      const decodedAttemptId = yield* Schema.decodeUnknownEffect(CrewStartId)(attemptId).pipe(
        Effect.mapError(() => failure("native-response-invalid")),
      );
      const decodedProviderInstanceId = yield* Schema.decodeUnknownEffect(ProviderInstanceId)(
        providerInstanceId,
      ).pipe(Effect.mapError(() => failure("native-response-invalid")));
      const decodedProviderThreadId = yield* Schema.decodeUnknownEffect(CrewStartId)(
        providerThreadId,
      ).pipe(Effect.mapError(() => failure("native-response-invalid")));
      yield* load(identity);
      const updated = yield* sql`
        UPDATE workjet_ctox_crew_starts
        SET provider_instance_id = ${decodedProviderInstanceId},
            provider_thread_id = ${decodedProviderThreadId}
        WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
          AND attempt_id = ${decodedAttemptId}
          AND (
            (provider_instance_id IS NULL AND provider_thread_id IS NULL)
            OR (provider_instance_id = ${decodedProviderInstanceId}
                AND provider_thread_id = ${decodedProviderThreadId})
          )
        RETURNING attempt_id
      `.pipe(Effect.mapError(unavailable));
      if (updated.length !== 1) return yield* failure("native-task-reference-conflict");
      const saved = yield* readCrewStart(identity, decodedAttemptId);
      if (
        !saved ||
        saved.providerInstanceId !== decodedProviderInstanceId ||
        saved.providerThreadId !== decodedProviderThreadId
      )
        return yield* failure("native-task-reference-conflict");
      return saved;
    },
  );

  /** Reserve BEFORE the remote claim. Only the inserting caller may start fresh.
   * An interrupted/ambiguous claim leaves the reservation intact for explicit
   * recovery; deleting it could cause two external harnesses for one attempt.
   */
  const reserveCrewStart = Effect.fn("CtoxNativeRequests.reserveCrewStart")(function* (
    requestIdentity: CtoxNativeRequestIdentity,
    requestedBinding: typeof CrewStartBinding.Type,
  ) {
    const identity = { ...requestIdentity };
    const binding = yield* Schema.decodeUnknownEffect(CrewStartBinding)({
      ...requestedBinding,
    }).pipe(Effect.mapError(() => failure("native-response-invalid")));
    const reference = yield* get(identity);
    if (
      reference.request.operation !== "start_crew_execution" ||
      reference.commandId !== binding.commandId ||
      reference.taskId !== binding.taskId
    )
      return yield* failure("native-task-reference-conflict");
    const now = yield* Clock.currentTimeMillis;
    const inserted = yield* sql`
      INSERT INTO workjet_ctox_crew_starts
        (thread_id, request_key, attempt_id, command_id, task_id, executor_id, member_id, reserved_at_ms)
      VALUES (${identity.threadId}, ${identity.requestKey}, ${binding.attemptId},
        ${binding.commandId}, ${binding.taskId}, ${binding.executorId}, ${binding.memberId}, ${now})
      ON CONFLICT(thread_id, request_key, attempt_id) DO NOTHING
      RETURNING attempt_id
    `.pipe(Effect.mapError(unavailable));
    const saved = yield* readCrewStart(identity, binding.attemptId);
    if (
      !saved ||
      saved.commandId !== binding.commandId ||
      saved.taskId !== binding.taskId ||
      saved.executorId !== binding.executorId ||
      saved.memberId !== binding.memberId
    )
      return yield* failure("native-task-reference-conflict");
    return {
      state: inserted.length === 1 ? ("reserved" as const) : ("existing" as const),
      binding: saved,
    };
  });

  const registerNativeTurn = Effect.fn("CtoxNativeRequests.registerNativeTurn")(function* (
    identity: CtoxNativeRequestIdentity,
    requestId: string,
  ) {
    yield* load(identity);
    yield* sql`
      INSERT INTO workjet_ctox_native_turns (thread_id, request_id, request_key)
      VALUES (${identity.threadId}, ${requestId}, ${identity.requestKey})
      ON CONFLICT(thread_id, request_id) DO NOTHING
    `.pipe(Effect.mapError(unavailable));
    const rows = yield* sql`
      SELECT request_id AS "requestId", request_key AS "requestKey"
      FROM workjet_ctox_native_turns
      WHERE thread_id = ${identity.threadId} AND request_id = ${requestId}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(NativeTurns)), Effect.mapError(unavailable));
    if (rows[0]?.requestKey !== identity.requestKey)
      return yield* failure("native-request-conflict");
  });
  const latestNativeTurn = Effect.fn("CtoxNativeRequests.latestNativeTurn")(function* (
    scope: Omit<CtoxNativeRequestIdentity, "requestKey">,
  ) {
    const rows = yield* sql`
      SELECT request_id AS "requestId", request_key AS "requestKey"
      FROM workjet_ctox_native_turns WHERE thread_id = ${scope.threadId}
      ORDER BY sequence DESC LIMIT 1
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(NativeTurns)), Effect.mapError(unavailable));
    const row = rows[0];
    if (!row) return null;
    return { ...row, reference: yield* get({ ...scope, requestKey: row.requestKey }) };
  });
  return {
    prepare,
    verifyTarget,
    recordReceipt,
    recordObservedTask,
    get,
    readCrewStart,
    reserveCrewStart,
    bindCrewStartProvider,
    registerNativeTurn,
    latestNativeTurn,
  };
});

const encodeIntentTarget = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

export class CtoxNativeRequests extends Context.Service<
  CtoxNativeRequests,
  Effect.Success<typeof make>
>()("workjet/workjet/ctox/CtoxNativeRequests") {
  static readonly layer = Layer.effect(this, make);
}
