import { useCallback, useMemo, useSyncExternalStore } from "react";
import * as Schema from "effect/Schema";
import {
  CtoxWorkjetProjectControlResponse,
  WorkjetJourFixeMeeting,
  WorkjetPresentationManifest,
  isWorkjetSupervisorReceiptForRequest,
  type CtoxWorkjetProjectControlRequest,
  type CtoxWorkjetProjectControlResult,
} from "@workjet/contracts";
import type { CtoxAppApi, Query, Selector } from "./ctoxClient";
import { useCtoxClient } from "./hooks";
import { createLiveStore } from "./liveStore";

export const PROJECT_READ_COLLECTIONS = {
  "project.gallery.order.read": "workjet_gallery_orders",
  "project.exit_model.read": "workjet_exit_assessments",
  "project.jour_fixe.meeting.read": "workjet_jour_fixe_meetings",
  "project.presentation.read": "workjet_presentations",
  "project.presentation.content.read": "workjet_presentations",
  "project.jour_fixe.narration.read": "workjet_jour_fixe_meetings",
  "project.supervisor.turn.capabilities": "workjet_supervisor_capabilities",
  "project.supervisor.turn.watch": "workjet_supervisor_turns",
  "project.supervisor.route.capabilities.v1": "workjet_supervisor_routes",
  "project.supervisor.route.capabilities.v2": "workjet_supervisor_routes",
  "project.supervisor.route.read.v1": "workjet_supervisor_routes",
  "project.supervisor.route.read.v2": "workjet_supervisor_routes",
  "instance.providers.read": "workjet_provider_registry",
  "instance.grok.read": "workjet_grok_status",
  "instance.grok.poll": "workjet_grok_status",
  "speech.settings.read": "workjet_speech_settings",
  "speech.settings.voices": "workjet_speech_settings",
  "speech.settings.playback": "workjet_speech_settings",
  "project.calendar.accounts.read": "workjet_calendar_accounts",
  "project.calendar.events.read": "workjet_calendar_events",
} as const;
export type LocalProjectReadAction = keyof typeof PROJECT_READ_COLLECTIONS;
export class CtoxLocalReadError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
    readonly path: string,
  ) {
    super(reason);
    this.name = "CtoxLocalReadError";
  }
}
export function isLocalProjectRead(request: CtoxWorkjetProjectControlRequest): boolean {
  return request.action in PROJECT_READ_COLLECTIONS;
}
type Row = Readonly<Record<string, unknown>> & { id: string };
const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse);
const decodeMeeting = Schema.decodeUnknownSync(WorkjetJourFixeMeeting);
const decodePresentation = Schema.decodeUnknownSync(WorkjetPresentationManifest);
function required<T>(value: T | undefined | null, path: string): T {
  if (value == null) throw new CtoxLocalReadError("not_found", "projection_missing", path);
  return value;
}
function definition(api: CtoxAppApi, request: CtoxWorkjetProjectControlRequest) {
  const action = request.action as LocalProjectReadAction;
  const collection = PROJECT_READ_COLLECTIONS[action];
  if (!collection) throw new CtoxLocalReadError("invalid", "read_action_unknown", request.action);
  const selector: Selector = { is_deleted: { $ne: true } };
  if ("projectId" in request) selector.project_id = request.projectId;
  if ("threadId" in request) selector.thread_id = request.threadId;
  if ("targetCommandId" in request) selector.command_id = request.targetCommandId;
  if ("meetingId" in request && request.meetingId !== undefined)
    selector[action.startsWith("project.presentation.") ? "meeting_id" : "id"] = request.meetingId;
  if (action.startsWith("project.supervisor.route.")) selector.view = action;
  if (action === "instance.grok.read" || action === "instance.grok.poll")
    selector.owner_user_id = api.actor.id;
  if (request.action === "instance.grok.poll") selector.login_id = request.loginId;
  if (action === "project.gallery.order.read") selector.owner_user_id = api.actor.id;
  if (request.action === "project.calendar.events.read") selector.account_id = request.accountId;
  if (request.action === "project.jour_fixe.meeting.read" && request.meetingId === undefined)
    selector.is_current = true;
  const query: Query = { selector };
  return { collection, query };
}
function boundedRow(row: Row, collection: string) {
  if (new TextEncoder().encode(JSON.stringify(row)).byteLength > 204_800)
    throw new CtoxLocalReadError("invalid", "projection_budget_exceeded", collection);
  for (const key of [
    "audioBase64",
    "bytesBase64",
    "data_base64",
    "secret",
    "api_key",
    "access_token",
    "refresh_token",
  ])
    if (key in row)
      throw new CtoxLocalReadError("invalid", "forbidden_projection_field", `${collection}.${key}`);
  return row;
}
function readRows(api: CtoxAppApi, request: CtoxWorkjetProjectControlRequest) {
  const { collection, query } = definition(api, request);
  const rows = api
    .query<Row>(collection, query)
    .get()
    .map((row) => boundedRow(row, collection));
  return { collection, rows };
}
function domainResponse(api: CtoxAppApi, request: CtoxWorkjetProjectControlRequest) {
  const { collection, rows } = readRows(api, request);
  const action = request.action;
  const correlation = {
    action,
    ...("commandId" in request ? { commandId: request.commandId } : {}),
    ...("operationId" in request ? { operationId: request.operationId, version: 1 } : {}),
    ...("projectId" in request ? { projectId: request.projectId } : {}),
    ...("threadId" in request ? { threadId: request.threadId } : {}),
  };
  let facts: object;
  if (action === "project.gallery.order.read") {
    if (rows.length !== 1)
      throw new CtoxLocalReadError("not_found", "projection_not_unique", collection);
    facts = { contract: "ctox.workjet.project_gallery_order.v1", order: rows[0] };
  } else if (action === "project.exit_model.read") {
    if (rows.length !== 1)
      throw new CtoxLocalReadError("not_found", "projection_not_unique", collection);
    facts = { assessment: rows[0] };
  } else if (action === "project.jour_fixe.meeting.read") {
    if (rows.length > 1)
      throw new CtoxLocalReadError("conflict", "projection_not_unique", collection);
    const meeting = rows[0] ? decodeMeeting(rows[0]) : null;
    facts = { contract: "ctox.workjet.jour_fixe.v1", meeting };
  } else if (action === "project.presentation.read") {
    if (rows.length > 1)
      throw new CtoxLocalReadError("conflict", "projection_not_unique", collection);
    facts = {
      contract: "ctox.workjet.presentation.v1",
      meetingId: request.meetingId,
      presentation: rows[0] ? decodePresentation(rows[0]) : null,
    };
  } else if (action === "project.calendar.accounts.read") {
    const meta = required(
      api.get<Row>("workjet_calendar_state", "accounts").get(),
      "workjet_calendar_state/accounts",
    );
    facts = { calendar: { ok: true, truncated: meta.truncated, accounts: rows } };
  } else if (action === "project.calendar.events.read") {
    const meta = required(
      api.get<Row>("workjet_calendar_state", request.accountId).get(),
      "workjet_calendar_state",
    );
    facts = {
      accountId: request.accountId,
      startMs: request.startMs,
      endMs: request.endMs,
      calendar: {
        ok: true,
        truncated: meta.truncated,
        synced_at_ms: meta.synced_at_ms,
        events: rows.filter(
          (row) =>
            typeof row.start_ms === "number" &&
            typeof row.end_ms === "number" &&
            row.start_ms < request.endMs &&
            row.end_ms > request.startMs,
        ),
      },
    };
  } else if (action === "instance.providers.read") {
    if (rows.length !== 1)
      throw new CtoxLocalReadError(
        rows.length ? "conflict" : "not_found",
        "projection_not_unique",
        collection,
      );
    const registry = required(rows[0], collection);
    facts = {
      registry: {
        ...registry,
        accounts: api
          .query<Row>("workjet_provider_accounts", { selector: { is_deleted: { $ne: true } } })
          .get()
          .map((row) => boundedRow(row, "workjet_provider_accounts")),
        providers: api.query<Row>("workjet_provider_selections", {}).get(),
      },
    };
  } else {
    if (rows.length > 1)
      throw new CtoxLocalReadError("conflict", "projection_not_unique", collection);
    const row = required(rows[0], collection);
    if (
      "projectId" in request &&
      row.projectId !== undefined &&
      row.projectId !== request.projectId
    )
      throw new CtoxLocalReadError("invalid", "projection_scope_mismatch", collection);
    if (action === "project.supervisor.turn.watch") {
      const { executionContract: _contract, executionPage: _page, ...metadata } = row;
      facts = { ...metadata, contract: "ctox.workjet.supervisor_turn.v1" };
      if (request.action === "project.supervisor.turn.watch" && request.executionPage !== undefined)
        facts = {
          ...facts,
          executionContract: "ctox.workjet.supervisor_execution.v1",
          executionPage: executionPage(api, request, row),
        };
    } else if (action === "project.supervisor.turn.capabilities") {
      const {
        inputContract: _inputContract,
        inputDelivery: _inputDelivery,
        maxInputChars: _maxInputChars,
        ...base
      } = row;
      facts = {
        ...(request.action === action && request.includeInput === true ? row : base),
        contract: "ctox.workjet.supervisor_turn_capabilities.v1",
      };
    } else if (action.startsWith("project.supervisor.route.")) {
      const version = action.endsWith(".v2") ? "v2" : "v1";
      const kind = action.includes(".capabilities.") ? "route-capabilities" : "route-display";
      facts = { ...row, contract: `ctox.workjet.supervisor.${kind}.${version}` };
    } else if (action === "speech.settings.playback") {
      const settings = decode({
        ...row,
        action: "speech.settings.read",
        ...("commandId" in request ? { commandId: request.commandId } : {}),
      });
      if (settings.action !== "speech.settings.read")
        throw new CtoxLocalReadError("invalid", "projection_schema_invalid", collection);
      facts = { rate: settings.status.config.rate };
    } else facts = row;
  }
  const response = decode({ ...facts, ...correlation });
  if (!isWorkjetSupervisorReceiptForRequest(request, response))
    throw new CtoxLocalReadError("invalid", "projection_scope_mismatch", collection);
  return response;
}

function executionPage(
  api: CtoxAppApi,
  request: Extract<CtoxWorkjetProjectControlRequest, { action: "project.supervisor.turn.watch" }>,
  row: Row,
) {
  const input = request.executionPage!;
  const currentAttempt = row.attempt as { attempt_id?: string } | undefined;
  const attemptId = input.attempt_id ?? currentAttempt?.attempt_id;
  if (!attemptId)
    throw new CtoxLocalReadError(
      "not_found",
      "execution_attempt_missing",
      "workjet_supervisor_attempts",
    );
  const attempts = api
    .query<Row>("workjet_supervisor_attempts", {
      selector: { attempt_id: attemptId, command_id: request.targetCommandId },
    })
    .get();
  if (attempts.length !== 1)
    throw new CtoxLocalReadError(
      "conflict",
      "execution_attempt_not_unique",
      "workjet_supervisor_attempts",
    );
  const attempt = attempts[0]!;
  const selector: Selector = { command_id: request.targetCommandId, attempt_id: attemptId };
  if (input.cursor) {
    const anchor = api
      .query<Row>("workjet_supervisor_execution_events", {
        selector: {
          ...selector,
          id: input.cursor.after_event_id,
          sequence: input.cursor.after_sequence,
        },
      })
      .get()[0];
    if (!anchor)
      throw new CtoxLocalReadError(
        "conflict",
        "execution_cursor_missing",
        "workjet_supervisor_execution_events",
      );
    selector.sequence = { $gt: input.cursor.after_sequence };
  }
  const excluded = [];
  if (input.include_public_text !== true) excluded.push("worker.assistant_text");
  if (input.include_native_message_text !== true) excluded.push("worker.native_message_text");
  if (excluded.length) selector.kind = { $nin: excluded };
  const limit = input.limit ?? 50;
  const events = api
    .query<Row>("workjet_supervisor_execution_events", {
      selector,
      sort: [{ sequence: "asc" }],
      limit: limit + 1,
    })
    .get();
  const shown = events.slice(0, limit);
  const last = shown.at(-1);
  return {
    command_id: request.targetCommandId,
    task_id: attempt.task_id,
    attempt,
    events: shown,
    has_more: events.length > limit,
    ...(last ? { next_cursor: { after_sequence: last.sequence, after_event_id: last.id } } : {}),
    public_text_supported: row.public_text_supported,
    native_message_text_supported: row.native_message_text_supported,
  };
}

export { readRows as readProjectRows };

/** Metadata reads are synchronous and local. File bodies use the kernel CAS API, never a read command. */
export function readLocalProjectControl(
  api: CtoxAppApi,
  request: CtoxWorkjetProjectControlRequest,
) {
  return domainResponse(api, request);
}
export function normalizeCtoxReadError(error: unknown, path = "workjet"): CtoxLocalReadError {
  if (error instanceof CtoxLocalReadError) return error;
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    [
      "invalid",
      "forbidden",
      "not_found",
      "conflict",
      "revoked",
      "expired",
      "quota",
      "unavailable",
      "stale_base",
      "migration_required",
      "locally_modified",
      "token_expired",
      "token_used",
    ].includes(error.code)
  ) {
    const sourcePath =
      "path" in error && typeof error.path === "string" ? error.path.slice(0, 512) : path;
    const reason =
      "reason" in error &&
      typeof error.reason === "string" &&
      /^[a-z0-9_.:-]{1,128}$/.test(error.reason)
        ? error.reason
        : "ctox_api_rejected";
    return new CtoxLocalReadError(error.code, reason, sourcePath);
  }
  return new CtoxLocalReadError("invalid", "projection_schema_invalid", path);
}
export function localReadFailure(error: unknown): CtoxWorkjetProjectControlResult {
  const failure = normalizeCtoxReadError(error);
  return {
    _tag: "failed",
    code: "unsupported",
    error: {
      code: failure.code,
      reason: failure.reason,
      path: failure.path,
    },
  };
}

/** UI/UX consumes this live source; no request/retry timer or guest is involved. */
export function useCtoxProjectRead(
  instanceId: string | null,
  request: CtoxWorkjetProjectControlRequest,
) {
  const api = useCtoxClient(instanceId);
  const key = JSON.stringify(request);
  const source = useMemo(() => {
    if (api === null) return null;
    const input: CtoxWorkjetProjectControlRequest = JSON.parse(key);
    try {
      const { collection, query } = definition(api, input);
      const lives = [api.query(collection, query)];
      if (input.action === "instance.providers.read")
        lives.push(
          api.query("workjet_provider_accounts", {}),
          api.query("workjet_provider_selections", {}),
        );
      if (input.action.startsWith("project.calendar."))
        lives.push(api.query("workjet_calendar_state", {}));
      if (input.action === "project.supervisor.turn.watch")
        lives.push(
          api.query("workjet_supervisor_execution_events", {}),
          api.query("workjet_supervisor_attempts", {}),
        );
      const read = (): CtoxWorkjetProjectControlResult => {
        try {
          return { _tag: "completed", response: domainResponse(api, input) };
        } catch (error) {
          return localReadFailure(error);
        }
      };
      return createLiveStore({
        get: read,
        subscribe: (notify: (value: CtoxWorkjetProjectControlResult) => void) => {
          const offs = lives.map((live) => live.subscribe(() => notify(read())));
          return () => offs.forEach((off) => off());
        },
      });
    } catch (error) {
      const failure = localReadFailure(error);
      return createLiveStore({ get: () => failure, subscribe: () => () => {} });
    }
  }, [api, key]);
  const empty = useCallback(() => null, []);
  const noSubscription = useCallback(() => () => {}, []);
  return useSyncExternalStore(
    source?.subscribe ?? noSubscription,
    source?.getSnapshot ?? empty,
    source?.getSnapshot ?? empty,
  );
}
