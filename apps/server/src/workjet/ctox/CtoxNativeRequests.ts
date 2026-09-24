// @effect-diagnostics nodeBuiltinImport:off -- Server-only SHA-256 pins opaque credentials without storing the bearer token.
import * as NodeCrypto from "node:crypto";
import {
  WorkjetCtoxBusinessOsInput,
  WorkjetCtoxCrewRequest,
  WorkjetCtoxCrewReceipt,
  ProviderInstanceId,
  ThreadId,
  WorkjetConnectionId,
} from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { CtoxMcpTarget } from "./CtoxMcpTransport.ts";

type ExistingNativeTaskRequest = Extract<
  WorkjetCtoxBusinessOsInput["request"],
  { readonly operation: "create_app" | "modify_app" | "delegate_task" }
> & { readonly idempotency_key: string };
const NativeProjectTaskRequest = Schema.Struct({
  operation: Schema.Literal("start_project_task"),
  project_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  instruction: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_000)),
  idempotency_key: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)),
});
export type NativeTaskRequest =
  | ExistingNativeTaskRequest
  | typeof NativeProjectTaskRequest.Type
  | WorkjetCtoxCrewRequest;

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
const isCtoxNativeRequestError = Schema.is(CtoxNativeRequestError);
const failure = (reason: CtoxNativeRequestError["reason"]) =>
  new CtoxNativeRequestError({ reason });
const unavailable = () => failure("native-request-store-unavailable");
const ProjectIntent = Schema.Struct({ request: NativeProjectTaskRequest });
const CrewIntent = Schema.Struct({ request: WorkjetCtoxCrewRequest });
const IntentCodec = Schema.fromJsonString(
  Schema.Union([WorkjetCtoxBusinessOsInput, ProjectIntent, CrewIntent]),
);
const encodeExistingIntent = Schema.encodeEffect(Schema.fromJsonString(WorkjetCtoxBusinessOsInput));
const encodeProjectIntent = Schema.encodeEffect(Schema.fromJsonString(ProjectIntent));
const encodeCrewIntent = Schema.encodeEffect(Schema.fromJsonString(CrewIntent));
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
const ExistingReceipt = Schema.Struct({
  module_id: Schema.String,
  command_type: Schema.String,
  command_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  task_id: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  ),
});
const NativeProjectReceipt = Schema.Struct({
  schema: Schema.Literal("ctox.native_project_task.v1"),
  project_id: Schema.String,
  command_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  task_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

const NativeTurns = Schema.Array(
  Schema.Struct({ requestId: Schema.String, requestKey: Schema.String }),
);

const CrewStartId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const CrewStartReservation = Schema.Struct({
  attemptId: CrewStartId,
  commandId: CrewStartId,
  taskId: CrewStartId,
  executorId: CrewStartId,
  memberId: CrewStartId,
});
const CrewStartBinding = Schema.Struct({
  ...CrewStartReservation.fields,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  providerThreadId: Schema.NullOr(CrewStartId),
  codexResumeThreadId: Schema.NullOr(CrewStartId),
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
    const intentJson = yield* (
      request.operation === "start_project_task"
        ? encodeProjectIntent({ request })
        : request.operation === "start_crew_execution"
          ? encodeCrewIntent({ request })
          : encodeExistingIntent({ request })
    ).pipe(Effect.mapError(unavailable));
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
    if (
      request.operation !== "create_app" &&
      request.operation !== "modify_app" &&
      request.operation !== "delegate_task" &&
      request.operation !== "start_project_task" &&
      request.operation !== "start_crew_execution"
    )
      return yield* failure("native-response-invalid");
    const receipt =
      request.operation === "start_crew_execution"
        ? yield* Schema.decodeUnknownEffect(WorkjetCtoxCrewReceipt)(value).pipe(
            Effect.mapError(() => failure("native-response-invalid")),
          )
        : request.operation === "start_project_task"
          ? yield* Schema.decodeUnknownEffect(NativeProjectReceipt)(value).pipe(
              Effect.mapError(() => failure("native-response-invalid")),
            )
          : yield* Schema.decodeUnknownEffect(ExistingReceipt)(value).pipe(
              Effect.mapError(() => failure("native-response-invalid")),
            );
    if (request.operation === "start_crew_execution") {
      if (!("thread_id" in receipt) || receipt.thread_id !== request.thread_id)
        return yield* failure("native-response-invalid");
    } else if (request.operation === "start_project_task") {
      if (!("project_id" in receipt) || receipt.project_id !== request.project_id)
        return yield* failure("native-response-invalid");
    } else if (
      !("module_id" in receipt) ||
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
    yield* Schema.decodeUnknownEffect(CrewStartId)(taskId).pipe(
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
        request.operation !== "start_crew_execution" &&
        request.operation !== "start_project_task") ||
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
        provider_instance_id AS "providerInstanceId", provider_thread_id AS "providerThreadId",
        codex_resume_thread_id AS "codexResumeThreadId"
      FROM workjet_ctox_crew_starts
      WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
        AND attempt_id = ${attemptId}
    `.pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(CrewStartBinding))(rows).pipe(
          Effect.mapError(() => failure("native-task-reference-conflict")),
        ),
      ),
    );
    const row = rows[0] ?? null;
    if (row && (row.providerInstanceId === null) !== (row.providerThreadId === null))
      return yield* failure("native-task-reference-conflict");
    if (row && row.providerThreadId === null && row.codexResumeThreadId !== null)
      return yield* failure("native-task-reference-conflict");
    return row;
  });

  /**
   * Pin an existing reservation to one provider instance and provider thread.
   * Legacy rows remain unassigned. Once assigned, the pair is immutable and
   * exact retries return the same binding.
   */
  const bindCrewStartProvider = Effect.fn("CtoxNativeRequests.bindCrewStartProvider")(function* (
    requestIdentity: CtoxNativeRequestIdentity,
    requestedBinding: typeof CrewStartReservation.Type,
    providerInstanceId: typeof ProviderInstanceId.Type,
    providerThreadId: string,
    codexResumeThreadId: string | null = null,
  ) {
    const identity = { ...requestIdentity };
    const binding = yield* Schema.decodeUnknownEffect(CrewStartReservation)({
      ...requestedBinding,
    }).pipe(Effect.mapError(() => failure("native-response-invalid")));
    const decodedProviderInstanceId = yield* Schema.decodeUnknownEffect(ProviderInstanceId)(
      providerInstanceId,
    ).pipe(Effect.mapError(() => failure("native-response-invalid")));
    const decodedProviderThreadId = yield* Schema.decodeUnknownEffect(CrewStartId)(
      providerThreadId,
    ).pipe(Effect.mapError(() => failure("native-response-invalid")));
    const decodedCodexResumeThreadId =
      codexResumeThreadId === null
        ? null
        : yield* Schema.decodeUnknownEffect(CrewStartId)(codexResumeThreadId).pipe(
            Effect.mapError(() => failure("native-response-invalid")),
          );
    const reference = yield* get(identity);
    if (
      reference.request.operation !== "start_crew_execution" ||
      reference.commandId !== binding.commandId ||
      reference.taskId !== binding.taskId
    )
      return yield* failure("native-task-reference-conflict");
    const updated = yield* sql`
        UPDATE workjet_ctox_crew_starts
        SET provider_instance_id = ${decodedProviderInstanceId},
            provider_thread_id = ${decodedProviderThreadId},
            codex_resume_thread_id = ${decodedCodexResumeThreadId}
        WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
          AND attempt_id = ${binding.attemptId}
          AND command_id = ${binding.commandId} AND task_id = ${binding.taskId}
          AND executor_id = ${binding.executorId} AND member_id = ${binding.memberId}
          AND (
            (provider_instance_id IS NULL AND provider_thread_id IS NULL
                AND codex_resume_thread_id IS NULL)
            OR (provider_instance_id = ${decodedProviderInstanceId}
                AND provider_thread_id = ${decodedProviderThreadId}
                AND codex_resume_thread_id IS ${decodedCodexResumeThreadId})
          )
        RETURNING attempt_id
      `.pipe(Effect.mapError(unavailable));
    if (updated.length !== 1) return yield* failure("native-task-reference-conflict");
    const saved = yield* readCrewStart(identity, binding.attemptId);
    if (
      !saved ||
      saved.providerInstanceId !== decodedProviderInstanceId ||
      saved.providerThreadId !== decodedProviderThreadId ||
      saved.codexResumeThreadId !== decodedCodexResumeThreadId
    )
      return yield* failure("native-task-reference-conflict");
    return saved;
  });

  /** Reserve one continuation turn for a claimed attempt before contacting a
   * provider. A process crash after this write leaves the attempt pending for
   * review; it must not silently dispatch the continuation a second time.
   */
  const reserveCrewRecoveryDispatch = Effect.fn("CtoxNativeRequests.reserveCrewRecoveryDispatch")(
    function* (
      requestIdentity: CtoxNativeRequestIdentity,
      attemptId: string,
      providerInstanceId: typeof ProviderInstanceId.Type,
      providerThreadId: string,
    ) {
      const identity = { ...requestIdentity };
      const saved = yield* readCrewStart(identity, attemptId);
      if (
        !saved ||
        saved.providerInstanceId !== providerInstanceId ||
        saved.providerThreadId !== providerThreadId
      )
        return yield* failure("native-task-reference-conflict");
      const requestId = `ctox-recovery:${identity.requestKey}:${attemptId}`;
      if (requestId.length > 512) return yield* failure("native-task-reference-conflict");
      const now = yield* Clock.currentTimeMillis;
      const inserted = yield* sql`
        UPDATE workjet_ctox_crew_starts
        SET recovery_request_id = ${requestId}, recovery_reserved_at_ms = ${now}
        WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
          AND attempt_id = ${attemptId}
          AND provider_instance_id = ${providerInstanceId}
          AND provider_thread_id = ${providerThreadId}
          AND recovery_request_id IS NULL
        RETURNING recovery_request_id
      `.pipe(Effect.mapError(unavailable));
      if (inserted.length === 1) return { state: "reserved" as const, requestId };
      const rows = yield* sql<{ readonly recoveryRequestId: string | null }>`
        SELECT recovery_request_id AS "recoveryRequestId"
        FROM workjet_ctox_crew_starts
        WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
          AND attempt_id = ${attemptId}
          AND provider_instance_id = ${providerInstanceId}
          AND provider_thread_id = ${providerThreadId}
      `.pipe(Effect.mapError(unavailable));
      if (rows[0]?.recoveryRequestId !== requestId)
        return yield* failure("native-task-reference-conflict");
      return { state: "existing" as const, requestId };
    },
  );

  const bindCrewProviderTurn = Effect.fn("CtoxNativeRequests.bindCrewProviderTurn")(function* (
    requestIdentity: CtoxNativeRequestIdentity,
    attemptId: string,
    providerInstanceId: typeof ProviderInstanceId.Type,
    providerThreadId: string,
    providerTurnId: string,
  ) {
    const identity = { ...requestIdentity };
    if (!providerTurnId.trim() || providerTurnId.length > 512)
      return yield* failure("native-task-reference-conflict");
    const saved = yield* readCrewStart(identity, attemptId);
    if (
      !saved ||
      saved.providerInstanceId !== providerInstanceId ||
      saved.providerThreadId !== providerThreadId
    )
      return yield* failure("native-task-reference-conflict");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const updated = yield* sql`
      UPDATE workjet_ctox_crew_starts SET
        provider_turn_id = ${providerTurnId},
        provider_terminal_state = COALESCE((
          SELECT terminal_state FROM workjet_ctox_unbound_provider_terminals
          WHERE thread_id = ${identity.threadId}
            AND provider_instance_id = ${providerInstanceId}
            AND provider_turn_id = ${providerTurnId}
        ), provider_terminal_state),
        provider_terminal_at_ms = COALESCE((
          SELECT terminal_at_ms FROM workjet_ctox_unbound_provider_terminals
          WHERE thread_id = ${identity.threadId}
            AND provider_instance_id = ${providerInstanceId}
            AND provider_turn_id = ${providerTurnId}
        ), provider_terminal_at_ms)
      WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
        AND attempt_id = ${attemptId}
        AND provider_instance_id = ${providerInstanceId}
        AND provider_thread_id = ${providerThreadId}
        AND (provider_turn_id IS NULL OR provider_turn_id = ${providerTurnId})
      RETURNING provider_turn_id
    `.pipe(Effect.mapError(unavailable));
        if (updated.length !== 1) return yield* failure("native-task-reference-conflict");
        yield* sql`
      DELETE FROM workjet_ctox_unbound_provider_terminals
      WHERE thread_id = ${identity.threadId}
        AND provider_instance_id = ${providerInstanceId}
        AND provider_turn_id = ${providerTurnId}
    `.pipe(Effect.mapError(unavailable));
      }),
    );
  });

  const recordCrewProviderTerminal = Effect.fn("CtoxNativeRequests.recordCrewProviderTerminal")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: typeof ProviderInstanceId.Type;
      readonly providerTurnId: string;
      readonly state: "completed" | "failed" | "interrupted" | "cancelled";
    }) {
      if (!input.providerTurnId.trim() || input.providerTurnId.length > 512)
        return yield* failure("native-task-reference-conflict");
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const updated = yield* sql<{ readonly attemptId: string }>`
        UPDATE workjet_ctox_crew_starts
        SET provider_terminal_state = ${input.state}, provider_terminal_at_ms = ${now}
        WHERE thread_id = ${input.threadId}
          AND provider_instance_id = ${input.providerInstanceId}
          AND provider_turn_id = ${input.providerTurnId}
          AND (provider_terminal_state IS NULL OR provider_terminal_state = ${input.state})
        RETURNING attempt_id AS "attemptId"
      `.pipe(Effect.mapError(unavailable));
          if (updated.length === 1)
            return { state: "recorded" as const, attemptId: updated[0]!.attemptId };
          const existing = yield* sql<{ readonly terminalState: string | null }>`
        SELECT provider_terminal_state AS "terminalState"
        FROM workjet_ctox_crew_starts
        WHERE thread_id = ${input.threadId}
          AND provider_instance_id = ${input.providerInstanceId}
          AND provider_turn_id = ${input.providerTurnId}
      `.pipe(Effect.mapError(unavailable));
          if (existing.length > 0) return yield* failure("native-task-reference-conflict");
          const pending = yield* sql`
        SELECT 1 FROM workjet_ctox_crew_starts
        WHERE thread_id = ${input.threadId}
          AND provider_instance_id = ${input.providerInstanceId}
          AND provider_turn_id IS NULL LIMIT 1
      `.pipe(Effect.mapError(unavailable));
          if (pending.length === 0) return { state: "unbound" as const };
          yield* sql`
        DELETE FROM workjet_ctox_unbound_provider_terminals
        WHERE terminal_at_ms < ${now - 24 * 60 * 60 * 1000}
      `.pipe(Effect.mapError(unavailable));
          yield* sql`
        INSERT OR IGNORE INTO workjet_ctox_unbound_provider_terminals
          (thread_id, provider_instance_id, provider_turn_id, terminal_state, terminal_at_ms)
        VALUES (${input.threadId}, ${input.providerInstanceId}, ${input.providerTurnId},
                ${input.state}, ${now})
      `.pipe(Effect.mapError(unavailable));
          const buffered = yield* sql<{ readonly terminalState: string }>`
        SELECT terminal_state AS "terminalState"
        FROM workjet_ctox_unbound_provider_terminals
        WHERE thread_id = ${input.threadId}
          AND provider_instance_id = ${input.providerInstanceId}
          AND provider_turn_id = ${input.providerTurnId}
      `.pipe(Effect.mapError(unavailable));
          if (buffered[0]?.terminalState !== input.state)
            return yield* failure("native-task-reference-conflict");
          return { state: "buffered" as const };
        }),
      );
    },
  );

  const readCrewTerminalState = Effect.fn("CtoxNativeRequests.readCrewTerminalState")(function* (
    identity: CtoxNativeRequestIdentity,
    attemptId: string,
  ) {
    yield* load(identity);
    const rows = yield* sql<{
      readonly terminalState: "completed" | "failed" | "interrupted" | "cancelled" | null;
    }>`
        SELECT provider_terminal_state AS "terminalState"
        FROM workjet_ctox_crew_starts
        WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
          AND attempt_id = ${attemptId}
      `.pipe(Effect.mapError(unavailable));
    return rows[0]?.terminalState ?? null;
  });

  const listCrewTerminalOutbox = Effect.fn("CtoxNativeRequests.listCrewTerminalOutbox")(function* (
    afterSequence = 0,
    requestedLimit = 64,
  ) {
    const cursor = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(64, Math.trunc(requestedLimit)))
      : 64;
    const rows = yield* sql<{
      readonly sequence: number;
      readonly threadId: string;
      readonly requestKey: string;
      readonly connectionId: string;
      readonly instanceId: string;
      readonly attemptId: string;
      readonly providerInstanceId: string;
      readonly providerTurnId: string;
      readonly terminalState: "completed" | "failed" | "interrupted" | "cancelled";
      readonly terminalAtMs: number;
    }>`
        SELECT s.rowid AS sequence, s.thread_id AS "threadId",
               s.request_key AS "requestKey", r.connection_id AS "connectionId",
               r.instance_id AS "instanceId", s.attempt_id AS "attemptId",
               s.provider_instance_id AS "providerInstanceId",
               s.provider_turn_id AS "providerTurnId",
               s.provider_terminal_state AS "terminalState",
               s.provider_terminal_at_ms AS "terminalAtMs"
        FROM workjet_ctox_crew_starts AS s
        JOIN workjet_ctox_native_requests AS r
          ON r.thread_id = s.thread_id AND r.request_key = s.request_key
        WHERE s.rowid > ${cursor} AND s.provider_terminal_state IS NOT NULL
          AND s.provider_reported_at_ms IS NULL
        ORDER BY s.rowid LIMIT ${limit}
      `.pipe(Effect.mapError(unavailable));
    return {
      candidates: rows.map((row) => ({
        sequence: row.sequence,
        identity: {
          threadId: ThreadId.make(row.threadId),
          connectionId: WorkjetConnectionId.make(row.connectionId),
          instanceId: row.instanceId,
          requestKey: row.requestKey,
        },
        attemptId: row.attemptId,
        providerInstanceId: ProviderInstanceId.make(row.providerInstanceId),
        providerTurnId: row.providerTurnId,
        terminalState: row.terminalState,
        terminalAtMs: row.terminalAtMs,
      })),
      nextSequence: rows.length === limit ? rows[rows.length - 1]!.sequence : null,
    };
  });

  const markCrewTerminalReported = Effect.fn("CtoxNativeRequests.markCrewTerminalReported")(
    function* (identity: CtoxNativeRequestIdentity, attemptId: string) {
      const now = yield* Clock.currentTimeMillis;
      const updated = yield* sql`
        UPDATE workjet_ctox_crew_starts SET provider_reported_at_ms = ${now}
        WHERE thread_id = ${identity.threadId} AND request_key = ${identity.requestKey}
          AND attempt_id = ${attemptId} AND provider_terminal_state IS NOT NULL
        RETURNING attempt_id
      `.pipe(Effect.mapError(unavailable));
      if (updated.length !== 1) return yield* failure("native-task-reference-conflict");
    },
  );

  /** Reserve BEFORE the remote claim. Only the inserting caller may start fresh.
   * An interrupted/ambiguous claim leaves the reservation intact for explicit
   * recovery; deleting it could cause two external harnesses for one attempt.
   */
  const reserveCrewStart = Effect.fn("CtoxNativeRequests.reserveCrewStart")(function* (
    requestIdentity: CtoxNativeRequestIdentity,
    requestedBinding: typeof CrewStartReservation.Type,
  ) {
    const identity = { ...requestIdentity };
    const binding = yield* Schema.decodeUnknownEffect(CrewStartReservation)({
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
  /** Commit the native intent and its recovery cursor together, before transport.
   * Otherwise a process exit after prepare but before turn registration leaves
   * an unreachable intent that cannot be enumerated on startup.
   */
  const prepareTurn = Effect.fn("CtoxNativeRequests.prepareTurn")(function* (
    identity: CtoxNativeRequestIdentity,
    request: NativeTaskRequest,
    target: CtoxMcpTarget,
    requestId: string,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const nativeKey = yield* prepare(identity, request, target);
          yield* registerNativeTurn(identity, requestId);
          return nativeKey;
        }),
      )
      .pipe(Effect.mapError((error) => (isCtoxNativeRequestError(error) ? error : unavailable())));
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
  /**
   * Page durable Crew intents for the startup reconciler. The event stream is
   * hot, so a submitted native turn can outlive the Workjet process that sent
   * it. This returns candidates, not a claim or permission to start a provider:
   * recovery must re-read native status and obtain a fresh authorized offer.
   */
  const listCrewRecoveryCandidates = Effect.fn("CtoxNativeRequests.listCrewRecoveryCandidates")(
    function* (afterSequence = 0, requestedLimit = 64) {
      const cursor = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(64, Math.trunc(requestedLimit)))
        : 64;
      const rows = yield* sql<{
        readonly sequence: number;
        readonly threadId: string;
        readonly requestId: string;
        readonly requestKey: string;
        readonly connectionId: string;
        readonly instanceId: string;
        readonly intentJson: string;
      }>`
        SELECT t.sequence, t.thread_id AS "threadId",
               t.request_id AS "requestId", t.request_key AS "requestKey",
               r.connection_id AS "connectionId", r.instance_id AS "instanceId",
               r.intent_json AS "intentJson"
        FROM workjet_ctox_native_turns AS t
        JOIN workjet_ctox_native_requests AS r
          ON r.thread_id = t.thread_id AND r.request_key = t.request_key
        WHERE t.sequence > ${cursor}
        ORDER BY t.sequence LIMIT ${limit}
      `.pipe(Effect.mapError(unavailable));
      const candidates: Array<{
        readonly sequence: number;
        readonly requestId: string;
        readonly identity: CtoxNativeRequestIdentity;
      }> = [];
      for (const row of rows) {
        const intent = yield* decodeIntent(row.intentJson).pipe(Effect.mapError(unavailable));
        if (intent.request.operation !== "start_crew_execution") continue;
        candidates.push({
          sequence: row.sequence,
          requestId: row.requestId,
          identity: {
            threadId: ThreadId.make(row.threadId),
            connectionId: WorkjetConnectionId.make(row.connectionId),
            instanceId: row.instanceId,
            requestKey: row.requestKey,
          },
        });
      }
      return {
        candidates,
        nextSequence: rows.length === limit ? rows[rows.length - 1]!.sequence : null,
      };
    },
  );
  return {
    prepare,
    verifyTarget,
    recordReceipt,
    recordObservedTask,
    get,
    readCrewStart,
    reserveCrewStart,
    bindCrewStartProvider,
    reserveCrewRecoveryDispatch,
    bindCrewProviderTurn,
    recordCrewProviderTerminal,
    readCrewTerminalState,
    listCrewTerminalOutbox,
    markCrewTerminalReported,
    registerNativeTurn,
    prepareTurn,
    latestNativeTurn,
    listCrewRecoveryCandidates,
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
