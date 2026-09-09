import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CtoxNativeRequestError, type NativeTaskReference } from "./CtoxNativeRequests.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Status = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const CommandStatusResponse = Schema.Struct({
  ok: Schema.Literal(true),
  record: Schema.Struct({
    id: Id,
    collection: Schema.Literal("business_commands"),
    status: Schema.optionalKey(Status),
    data: Schema.Struct({
      command_id: Id,
      task_id: Schema.optionalKey(Schema.NullOr(Id)),
      module: Schema.optionalKey(Id),
      record_id: Schema.optionalKey(Schema.NullOr(Id)),
      command_type: Schema.optionalKey(Id),
      status: Status,
      task_status: Schema.optionalKey(Status),
      status_note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_000))),
      result: Schema.optionalKey(Schema.Unknown),
    }),
  }),
});
const decode = Schema.decodeUnknownEffect(CommandStatusResponse);
export type CtoxNativeTaskState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

/** Mirrors CTOX's public normalized queue states; new states never imply success. */
function taskState(value: string): CtoxNativeTaskState {
  switch (value) {
    case "accepted":
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "blocked":
    case "waiting_dependencies":
    case "retry_wait":
      return "waiting";
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "unknown";
  }
}

/** Validate the real BusinessOsMcpRecordResponse against the locally pinned
 * native ids. This observation does not copy remote execution state into the
 * request ledger or infer completion from a successful HTTP response.
 */
export const decodeCtoxNativeTaskStatus = Effect.fn("decodeCtoxNativeTaskStatus")(function* (
  reference: NativeTaskReference,
  value: unknown,
) {
  const { record } = yield* decode(value).pipe(
    Effect.mapError(() => new CtoxNativeRequestError({ reason: "native-response-invalid" })),
  );
  // App development commands belong to the native Creator module; their
  // record_id identifies the app. General delegation belongs to its own module.
  const request = reference.request;
  const nativeModule = request.operation === "delegate_task" ? request.module_id : "creator";
  const commandType =
    request.operation === "delegate_task"
      ? "ctox.delegate_task"
      : request.operation === "create_app"
        ? "ctox.business_os.app.create"
        : "ctox.business_os.app.modify";
  const recordId =
    request.operation === "delegate_task" ? (request.record_id ?? null) : request.module_id;
  if (
    !reference.commandId ||
    record.id !== reference.commandId ||
    record.data.command_id !== reference.commandId ||
    (record.data.task_id ?? null) !== reference.taskId ||
    (record.data.module !== undefined && record.data.module !== nativeModule) ||
    (record.data.record_id !== undefined && record.data.record_id !== recordId) ||
    (record.data.command_type !== undefined && record.data.command_type !== commandType) ||
    (record.status !== undefined && record.status !== record.data.status)
  ) {
    return yield* new CtoxNativeRequestError({ reason: "native-response-invalid" });
  }
  // pull_business_command_status_record overlays the native queue state on
  // the compatibility command record. task_status is authoritative when present.
  const status = record.data.task_status ?? record.data.status;
  return {
    reference,
    state: taskState(status),
    status,
    note: record.data.status_note ?? null,
    result: record.data.result ?? null,
  };
});
