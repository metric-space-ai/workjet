import { CtoxWorkjetSessionProjection } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { useMemo } from "react";
import { getCtoxClient, subscribeCtoxClients, type CtoxAppApi } from "./ctoxClient";
import { useCtoxQuery } from "./hooks";
import type { SessionCalendarSnapshot } from "../calendar/sessionCalendar";

/** Existing ctox-owned workjet_sessions schema; optional native IDs stay null, never inferred. */
export interface CtoxSessionDocument {
  readonly id: string;
  readonly project_id: string;
  readonly working_copy_id: string;
  readonly computer_id: string;
  readonly thread_id?: string;
  readonly coding_session_id?: string;
  readonly run_status: CtoxWorkjetSessionProjection["runStatus"];
  readonly fence_epoch: number;
  readonly active_transfer_id?: string;
  readonly updated_at_ms: number;
  readonly created_at_ms: number;
  readonly is_deleted: boolean;
}
const decodeSession = Schema.decodeUnknownSync(CtoxWorkjetSessionProjection);
const sessionQuery = { selector: { is_deleted: { $ne: true } } } as const;
export function projectCtoxSession(row: CtoxSessionDocument): CtoxWorkjetSessionProjection {
  return decodeSession({
    id: row.id,
    projectId: row.project_id,
    workingCopyId: row.working_copy_id,
    computerId: row.computer_id,
    threadId: row.thread_id ?? null,
    codingSessionId: row.coding_session_id ?? null,
    runStatus: row.run_status,
    fenceEpoch: row.fence_epoch,
    activeTransferId: row.active_transfer_id ?? null,
    updatedAtMs: row.updated_at_ms,
    createdAtMs: row.created_at_ms,
  });
}
export function readCtoxSessions(api: CtoxAppApi) {
  return api
    .query<CtoxSessionDocument>("workjet_sessions", sessionQuery)
    .get()
    .map(projectCtoxSession);
}
export function useCtoxSessions(instanceId: string | null) {
  const rows = useCtoxQuery<CtoxSessionDocument>(instanceId, "workjet_sessions", sessionQuery);
  return useMemo(() => rows.map(projectCtoxSession), [rows]);
}

/** Default calendar source: local subscription, including offline updates and actor rebinding. */
export function createCtoxSessionCalendarReader(
  instanceId: string,
  publish: (value: SessionCalendarSnapshot) => void,
) {
  let disposed = false;
  let started = false;
  let offRows = () => {};
  let offClients = () => {};
  let boundApi: CtoxAppApi | null | undefined;
  const bind = () => {
    if (disposed) return;
    const api = getCtoxClient(instanceId);
    if (api === boundApi) return;
    boundApi = api;
    offRows();
    offRows = () => {};
    if (!api) {
      publish({ status: "unavailable", sessions: [] });
      return;
    }
    offRows = api.query<CtoxSessionDocument>("workjet_sessions", sessionQuery).subscribe((rows) => {
      if (disposed || getCtoxClient(instanceId) !== api) return;
      try {
        publish({ status: "ready", sessions: rows.map(projectCtoxSession) });
      } catch {
        publish({ status: "unavailable", sessions: [] });
      }
    });
  };
  return {
    refresh: async () => {
      if (disposed) return;
      if (!started) {
        started = true;
        offClients = subscribeCtoxClients(bind);
      }
      bind();
    },
    dispose: () => {
      disposed = true;
      offRows();
      offClients();
    },
  };
}
