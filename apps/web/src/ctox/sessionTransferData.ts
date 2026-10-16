import * as Schema from "effect/Schema";
import {
  CtoxWorkjetSessionTransferEvent,
  CtoxWorkjetTransferOutcome,
  type CtoxWorkjetSessionControlRequest,
  type CtoxWorkjetSessionTransferNotification,
} from "@workjet/contracts";
import { getCtoxClient, subscribeCtoxClients, type CtoxAppApi } from "./ctoxClient";
import { CtoxLocalReadError } from "./projectReadData";
import { useCtoxQuery } from "./hooks";

const Transfer = Schema.Struct({
  id: Schema.NonEmptyString,
  session_id: Schema.NonEmptyString,
  state: Schema.NonEmptyString,
  retryable: Schema.Boolean,
  error_code: Schema.NullOr(Schema.String),
  updated_at_ms: Schema.Number,
});
export type CtoxSessionTransfer = typeof Transfer.Type;
const decodeTransfer = Schema.decodeUnknownSync(Transfer);
const decodeEvent = Schema.decodeUnknownSync(CtoxWorkjetSessionTransferEvent);
export function readCtoxSessionTransfer(
  api: CtoxAppApi,
  request: Extract<CtoxWorkjetSessionControlRequest, { action: "session.transfer.status" }>,
) {
  if (!request.transferId && !request.sessionId)
    throw new CtoxLocalReadError("invalid", "transfer_scope_missing", "workjet_session_transfers");
  const rows = api
    .query("workjet_session_transfers", {
      selector: {
        ...(request.transferId ? { id: request.transferId } : {}),
        ...(request.sessionId ? { session_id: request.sessionId } : {}),
        is_deleted: { $ne: true },
      },
    })
    .get()
    .map((row) => decodeTransfer(row));
  if (rows.length !== 1)
    throw new CtoxLocalReadError("not_found", "transfer_not_unique", "workjet_session_transfers");
  const row = rows[0]!;
  return Schema.decodeUnknownSync(CtoxWorkjetTransferOutcome)({
    ok: true,
    transferId: row.id,
    state: row.state,
    retryable: row.retryable,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  });
}
export function useCtoxSessionTransfers(instanceId: string | null) {
  return useCtoxQuery<CtoxSessionTransfer>(instanceId, "workjet_session_transfers", {
    selector: { is_deleted: { $ne: true } },
  });
}
/** Only a Core-issued, still-pending client action may be replayed after a client reconnect. */
export function subscribeCtoxSessionTransferEvents(
  instanceId: string,
  computerIds: readonly string[],
  receive: (event: CtoxWorkjetSessionTransferNotification) => void,
) {
  let offRows = () => {};
  const bind = () => {
    offRows();
    offRows = () => {};
    const api = getCtoxClient(instanceId);
    if (!api || computerIds.length === 0) return;
    const seen = new Set<string>();
    offRows = api
      .query<Record<string, unknown>>("workjet_session_transfer_events", {
        selector: { sourceComputerId: { $in: computerIds }, action_required: true },
      })
      .subscribe((rows) => {
        if (getCtoxClient(instanceId) !== api) return;
        for (const row of rows) {
          const event = decodeEvent(row);
          const key = JSON.stringify([
            event.transferId,
            event.fenceEpoch,
            event.state,
            event.updatedAtMs,
          ]);
          if (seen.has(key)) continue;
          seen.add(key);
          receive({ instanceId, event });
        }
      });
  };
  const offClients = subscribeCtoxClients(bind);
  bind();
  return () => {
    offRows();
    offClients();
  };
}
