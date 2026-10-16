/**
 * Workjet app data on a V4 instance (E49, slice C part 2). Every function takes the bound V4 app
 * API (`CtoxAppApi` of the kernel, structurally narrowed here so server and web share one
 * implementation without importing the browser kernel). Reads are local queries, writes are
 * `put`/`patch` into Workjet-owned collections, and everything else is a typed command whose
 * terminal state comes from the core. There is no HTTP, MCP or SSH path in this module; a V3
 * instance never reaches it because callers only use it while a kernel client is bound.
 */

export interface CtoxV4Live<T> {
  get(): T;
  subscribe(listener: (value: T) => void): () => void;
}
export interface CtoxV4WriteResult {
  readonly status: string;
  readonly code?: string;
  readonly reason?: string;
}
export interface CtoxV4WriteHandle {
  readonly local: Promise<void>;
  readonly result: Promise<CtoxV4WriteResult>;
}
export interface CtoxV4CommandState {
  readonly status: string;
  readonly result?: unknown;
  readonly error?: string;
}
export interface CtoxV4CommandHandle {
  readonly id: string;
  readonly status: CtoxV4Live<CtoxV4CommandState>;
  readonly local: Promise<void>;
  readonly result: Promise<CtoxV4WriteResult>;
}
export interface CtoxV4Query {
  readonly selector?: Record<string, unknown>;
  readonly sort?: Array<Record<string, "asc" | "desc">>;
  readonly limit?: number;
}
/** The subset of the kernel `CtoxAppApi` (v4.0) Workjet app data needs. */
export interface CtoxV4AppPort {
  readonly actor: { readonly id: string; readonly role: string };
  query<T = unknown>(collection: string, query: CtoxV4Query): CtoxV4Live<T[]>;
  get<T = unknown>(collection: string, id: string): CtoxV4Live<T | null>;
  put<T>(collection: string, doc: T & { id: string }): CtoxV4WriteHandle;
  patch(collection: string, id: string, patch: object): CtoxV4WriteHandle;
  command(
    type: string,
    payload: object,
    options?: { record_id?: string; idempotency_key?: string },
  ): CtoxV4CommandHandle;
}

export class CtoxV4AppError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "CtoxV4AppError";
  }
}

const errorCode = (state: CtoxV4CommandState | CtoxV4WriteResult): string => {
  const typed = (state as { code?: unknown }).code;
  if (typeof typed === "string" && typed) return typed;
  const error = (state as { error?: unknown }).error;
  if (typeof error !== "string" || !error) return "command_failed";
  return /^([a-z][a-z0-9_]*):/.exec(error)?.[1] ?? error;
};

/** Write ACK first (`unknown_command` and `forbidden` reject here, E27.2), then the terminal state. */
export function runCtoxV4Command(
  api: CtoxV4AppPort,
  type: string,
  payload: object,
  options?: { record_id?: string; idempotency_key?: string },
): Promise<unknown> {
  const handle = api.command(type, payload, options);
  return new Promise((resolve, reject) => {
    let settled = false;
    let off: (() => void) | undefined;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      off?.();
      run();
    };
    void handle.result.then((write) => {
      if (write.status === "rejected") finish(() => reject(new CtoxV4AppError(errorCode(write))));
    });
    void handle.local.catch((error: unknown) => finish(() => reject(error)));
    off = handle.status.subscribe((state) => {
      if (state.status === "done") finish(() => resolve(state.result));
      else if (["failed", "cancelled", "rejected"].includes(state.status))
        finish(() => reject(new CtoxV4AppError(errorCode(state))));
    });
    if (settled) off();
  });
}

async function writeOrThrow(handle: CtoxV4WriteHandle): Promise<CtoxV4WriteResult> {
  await handle.local;
  const result = await handle.result;
  if (result.status === "rejected") throw new CtoxV4AppError(result.code ?? "rejected");
  return result;
}

// ---------------------------------------------------------------- 1. Postfach (E49.4)

export const WORKJET_MAILBOX_ENVELOPES = "workjet_mailbox_envelopes";

/** One envelope row; the wire fields are those of today's `/workjet/mailbox/publish` document. */
export interface WorkjetMailboxEnvelopeDocument {
  readonly id: string;
  readonly target_environment_id: string;
  readonly source_workspace_id?: string;
  readonly target_workspace_id?: string;
  readonly source_environment_id?: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly envelope_json: string;
  readonly payload_json: string;
  readonly status: "pending" | "consumed";
  readonly consumed_at_ms?: number;
  readonly consumed_by?: string;
}
export type WorkjetMailboxPublishInput = Omit<
  WorkjetMailboxEnvelopeDocument,
  "status" | "consumed_at_ms" | "consumed_by"
>;

/** Store-and-forward via the core: the row replicates; an existing id is a delivered duplicate. */
export async function publishWorkjetMailboxEnvelope(
  api: CtoxV4AppPort,
  envelope: WorkjetMailboxPublishInput,
): Promise<{ readonly duplicate: boolean }> {
  if (api.get(WORKJET_MAILBOX_ENVELOPES, envelope.id).get() !== null) return { duplicate: true };
  await writeOrThrow(
    api.put<WorkjetMailboxEnvelopeDocument>(WORKJET_MAILBOX_ENVELOPES, {
      ...envelope,
      status: "pending",
    }),
  );
  return { duplicate: false };
}

const pendingFor = (environmentId: string, nowMs: number): CtoxV4Query => ({
  selector: {
    target_environment_id: environmentId,
    status: "pending",
    expires_at_ms: { $gt: nowMs },
  },
  sort: [{ created_at_ms: "asc" }],
});

/** Local read of the pending envelopes for one environment (no network, no cursor). */
export function readPendingWorkjetMailboxEnvelopes(
  api: CtoxV4AppPort,
  environmentId: string,
  nowMs: number,
): WorkjetMailboxEnvelopeDocument[] {
  return api
    .query<WorkjetMailboxEnvelopeDocument>(
      WORKJET_MAILBOX_ENVELOPES,
      pendingFor(environmentId, nowMs),
    )
    .get();
}

/** Live query instead of polling: the listener runs on every replicated change. */
export function watchPendingWorkjetMailboxEnvelopes(
  api: CtoxV4AppPort,
  environmentId: string,
  nowMs: () => number,
  listener: (envelopes: WorkjetMailboxEnvelopeDocument[]) => void,
): () => void {
  return api
    .query<WorkjetMailboxEnvelopeDocument>(
      WORKJET_MAILBOX_ENVELOPES,
      pendingFor(environmentId, nowMs()),
    )
    .subscribe(listener);
}

/** Receipt = `api.patch` on the envelope row; repeated receipts are no-ops. */
export async function acknowledgeWorkjetMailboxEnvelopes(
  api: CtoxV4AppPort,
  envelopeIds: ReadonlyArray<string>,
  consumer: string,
  nowMs: number,
): Promise<number> {
  let consumed = 0;
  for (const id of envelopeIds) {
    const row = api.get<WorkjetMailboxEnvelopeDocument>(WORKJET_MAILBOX_ENVELOPES, id).get();
    if (row === null || row.status === "consumed") continue;
    await writeOrThrow(
      api.patch(WORKJET_MAILBOX_ENVELOPES, id, {
        status: "consumed",
        consumed_at_ms: nowMs,
        consumed_by: consumer,
      }),
    );
    consumed += 1;
  }
  return consumed;
}

// ---------------------------------------------------------------- 2. Luma/Preset (E49.4)

export const WORKJET_LUMA_STATE = "workjet_luma_state";
export const WORKJET_LUMA_STATE_ID = "instance";

export interface WorkjetLumaConfigurationDocument {
  readonly revision: number;
  readonly configuration: Readonly<Record<string, unknown>> | null;
  readonly updatedAtMs: number | null;
}
export type WorkjetLumaSaveResult =
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "conflict"; readonly revision: number };

type LumaRow = {
  id: string;
  revision?: number;
  configured?: boolean;
  updatedAtMs?: number | null;
  [field: string]: unknown;
};
const LUMA_META = new Set(["id", "revision", "configured", "updatedAtMs"]);

export function readWorkjetLumaConfiguration(api: CtoxV4AppPort): WorkjetLumaConfigurationDocument {
  const row = api.get<LumaRow>(WORKJET_LUMA_STATE, WORKJET_LUMA_STATE_ID).get();
  if (row === null) return { revision: 0, configuration: null, updatedAtMs: null };
  const configuration = Object.fromEntries(
    Object.entries(row).filter(([key]) => !LUMA_META.has(key)),
  );
  return {
    revision: row.revision ?? 0,
    configuration: row.configured === false ? null : configuration,
    updatedAtMs: row.updatedAtMs ?? null,
  };
}

/** Same compare-and-set contract as the MCP tool: a stale revision is `conflict` and writes nothing. */
export async function saveWorkjetLumaConfiguration(
  api: CtoxV4AppPort,
  expectedRevision: number,
  configuration: Readonly<Record<string, unknown>>,
  nowMs: number,
): Promise<WorkjetLumaSaveResult> {
  const current = readWorkjetLumaConfiguration(api);
  if (current.revision !== expectedRevision)
    return { status: "conflict", revision: current.revision };
  for (const key of Object.keys(configuration))
    if (LUMA_META.has(key)) throw new CtoxV4AppError("invalid");
  const revision = expectedRevision + 1;
  const fields = { ...configuration, revision, configured: true, updatedAtMs: nowMs };
  const exists = api.get(WORKJET_LUMA_STATE, WORKJET_LUMA_STATE_ID).get() !== null;
  await writeOrThrow(
    exists
      ? api.patch(WORKJET_LUMA_STATE, WORKJET_LUMA_STATE_ID, fields)
      : api.put(WORKJET_LUMA_STATE, { id: WORKJET_LUMA_STATE_ID, ...fields }),
  );
  return { status: "saved", revision };
}

// ---------------------------------------------------------------- 3. decision_hub → Freigabe (E49.4)

export const CTOX_APPROVAL_REQUEST = "threads.ctox_approval.request";
export const CTOX_APPROVAL_REQUESTS = "ctox_task_approval_requests";

export interface WorkjetDecisionRequest {
  readonly decisionKey: string;
  readonly title: string;
  readonly question: string;
  readonly context?: unknown;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label?: string }>;
  readonly reviewerUserId: string;
  readonly threadId: string;
  readonly environmentId: string;
}
export interface WorkjetDecisionResolution {
  readonly decisionId: string;
  readonly status: "open" | "resolved" | "expired";
  readonly selectedOptionId: string | null;
  readonly comment: string | null;
  readonly resolutionVersion: number;
}

/** Stable approval id from the decision key, so a retried escalation reuses the same request. */
export const workjetApprovalId = (decisionKey: string) => `workjet-decision:${decisionKey}`;

export async function requestWorkjetDecision(
  api: CtoxV4AppPort,
  input: WorkjetDecisionRequest,
): Promise<{ readonly decisionId: string; readonly status: "open" }> {
  const approvalId = workjetApprovalId(input.decisionKey);
  await runCtoxV4Command(
    api,
    CTOX_APPROVAL_REQUEST,
    {
      approval_request_id: approvalId,
      title: input.title,
      prompt: input.question,
      reviewer_user_id: input.reviewerUserId,
      // The owner reviews decisions of their own Workjet agents; the core admits this only for admins.
      allow_self_approval_admin_override: input.reviewerUserId === api.actor.id,
      target_module: "workjet",
      target_record_id: input.threadId,
      decision_options: input.options,
      decision_context: input.context ?? null,
      source_context: {
        module: "workjet",
        record_type: "thread",
        record_id: input.threadId,
        label: input.title,
        environment_id: input.environmentId,
      },
    },
    { idempotency_key: approvalId, record_id: input.threadId },
  );
  return { decisionId: approvalId, status: "open" };
}

type ApprovalRow = {
  id: string;
  status?: string;
  decision?: string;
  comment?: string;
  review_comment?: string;
  updated_at_ms?: number;
  resolved_at_ms?: number;
};

/** Collection read of the approval the core projects; the core decides, Workjet only maps. */
export function readWorkjetDecision(
  api: CtoxV4AppPort,
  decisionId: string,
): WorkjetDecisionResolution | null {
  const row = api.get<ApprovalRow>(CTOX_APPROVAL_REQUESTS, decisionId).get();
  if (row === null) return null;
  const status =
    row.status === "approved" || row.status === "rejected"
      ? "resolved"
      : row.status === "cancelled" || row.status === "expired"
        ? "expired"
        : "open";
  return {
    decisionId,
    status,
    selectedOptionId:
      status !== "resolved"
        ? null
        : (row.decision ?? (row.status === "approved" ? "approve" : "reject")),
    comment: row.review_comment ?? row.comment ?? null,
    resolutionVersion: row.updated_at_ms ?? row.resolved_at_ms ?? 0,
  };
}

// ---------------------------------------------------------------- 4. Worker-Dispatch (E54.3b)

/**
 * Workjet app command of the instance module `workjet` (E54.3b). The native
 * `business_os.workjet_worker_dispatch` tool never starts a process: it is an intent queue the
 * dispatcher on the Workjet machine drains. On V4 the queue is Workjet app data
 * (`workjet_worker_dispatch_{sources,intents,outcomes}`, owned by the instance module), the
 * dispatcher reads intents with a live query and reports `complete`/`report_outcome` through this
 * command. The handler on the instance runs every action over `ctx.db`; it needs no capability.
 */
export const WORKJET_WORKER_DISPATCH = "workjet.worker.dispatch";
export const WORKJET_WORKER_DISPATCH_SOURCES = "workjet_worker_dispatch_sources";
export const WORKJET_WORKER_DISPATCH_INTENTS = "workjet_worker_dispatch_intents";
export const WORKJET_WORKER_DISPATCH_OUTCOMES = "workjet_worker_dispatch_outcomes";
export const WORKJET_WORKER_DISPATCH_CONTRACT = "ctox.workjet.worker-dispatch.v1";
/** Native bound of unanswered intents per owner and authority epoch. */
export const WORKJET_WORKER_DISPATCH_PENDING_LIMIT = 128;

/** The seven actions of the native tool (mcp_workjet_worker_dispatch.rs `Request`), 1:1. */
export type WorkjetWorkerDispatchArgs =
  | {
      readonly action: "register_source";
      readonly source_environment_id: string;
      readonly source_supervisor_thread_id: string;
      readonly project_id: string;
      readonly expected_revision?: number;
    }
  | { readonly action: "revoke_source"; readonly registration_id: string; readonly revision: number }
  | { readonly action: "poll"; readonly source_environment_id: string }
  | {
      readonly action: "complete";
      readonly registration_id: string;
      readonly revision: number;
      readonly intent_id: string;
      readonly result: object;
    }
  | {
      readonly action: "report_outcome";
      readonly registration_id: string;
      readonly revision: number;
      readonly intent_id: string;
      readonly receipt: object;
    }
  | {
      readonly action: "dispatch";
      readonly dispatch_key: string;
      readonly task: string;
      readonly title?: string;
      readonly computer_id?: string;
      readonly worker_profile_id?: string;
    }
  | { readonly action: "observe"; readonly limit?: number };
export type WorkjetWorkerDispatchAction = WorkjetWorkerDispatchArgs["action"];
export const WORKJET_WORKER_DISPATCH_ACTIONS: ReadonlyArray<WorkjetWorkerDispatchAction> = [
  "register_source",
  "revoke_source",
  "poll",
  "complete",
  "report_outcome",
  "dispatch",
  "observe",
];

/** Native `Registration` (record_json), camelCase as on the wire. */
export interface WorkjetWorkerSourceRegistration {
  readonly contract: typeof WORKJET_WORKER_DISPATCH_CONTRACT;
  readonly registrationId: string;
  readonly revision: number;
  readonly sourceEnvironmentId: string;
  readonly sourceSupervisorThreadId: string;
  readonly sourceInstanceId: string;
  readonly sourceWorkspaceId: string;
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly authorityEpoch: number;
  readonly state: "active" | "revoked";
}
/** Native `Intent` (intent_json). */
export interface WorkjetWorkerDispatchIntent {
  readonly intentId: string;
  readonly registrationId: string;
  readonly registrationRevision: number;
  readonly sourceEnvironmentId: string;
  readonly sourceSupervisorThreadId: string;
  readonly projectId: string;
  readonly task: string;
  readonly title?: string;
  readonly computerId?: string;
  readonly workerProfileId?: string;
}
/** Row of `workjet_worker_dispatch_sources` (native columns; record_json → `record`). */
export interface WorkjetWorkerDispatchSourceDocument {
  readonly id: string;
  readonly owner_user_id: string;
  readonly project_id: string;
  readonly registration_id: string;
  readonly record: WorkjetWorkerSourceRegistration;
}
/** Row of `workjet_worker_dispatch_intents`; `result` stays `null` until `complete`. */
export interface WorkjetWorkerDispatchIntentDocument {
  readonly id: string;
  readonly intent_id: string;
  readonly registration_id: string;
  readonly registration_revision: number;
  readonly command_id: string;
  readonly dispatch_key: string;
  readonly request_digest: string;
  readonly intent: WorkjetWorkerDispatchIntent;
  readonly result: Readonly<Record<string, unknown>> | null;
}
/** Row of `workjet_worker_dispatch_outcomes` (immutable once written). */
export interface WorkjetWorkerDispatchOutcomeDocument {
  readonly id: string;
  readonly intent_id: string;
  readonly owner_user_id: string;
  readonly project_id: string;
  readonly supervisor_thread_id: string;
  readonly registration_revision: number;
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly accepted_at_ms: number;
}

/** Writes go through the instance handler (idempotent, revision-fenced), never api.put/patch. */
export function dispatchWorkjetWorker(
  api: CtoxV4AppPort,
  args: WorkjetWorkerDispatchArgs,
  /** `record_id` = project of a supervisor `dispatch`/`observe` (replaces the native session). */
  options?: { readonly idempotency_key?: string; readonly record_id?: string },
): Promise<unknown> {
  return runCtoxV4Command(
    api,
    WORKJET_WORKER_DISPATCH,
    args,
    options === undefined ? undefined : { ...options },
  );
}

const pendingIntents = (sourceEnvironmentId: string): CtoxV4Query => ({
  selector: { "intent.sourceEnvironmentId": sourceEnvironmentId, result: null },
  // Intent ids are UUIDv7 from the instance handler: ascending id = queue order (native rowid).
  sort: [{ intent_id: "asc" }],
});

/**
 * `poll` as a local read: the head of the source-wide queue for one environment, at most one
 * intent, skipping intents whose registration was replaced, revoked or moved (native join).
 */
export function readWorkjetWorkerDispatchHead(
  api: CtoxV4AppPort,
  sourceEnvironmentId: string,
): { readonly intents: WorkjetWorkerDispatchIntent[] } {
  const rows = api
    .query<WorkjetWorkerDispatchIntentDocument>(
      WORKJET_WORKER_DISPATCH_INTENTS,
      pendingIntents(sourceEnvironmentId),
    )
    .get();
  for (const row of rows) {
    const source = api
      .get<WorkjetWorkerDispatchSourceDocument>(WORKJET_WORKER_DISPATCH_SOURCES, row.registration_id)
      .get();
    const record = source?.record;
    if (
      record === undefined ||
      record.state !== "active" ||
      record.revision !== row.registration_revision ||
      record.sourceEnvironmentId !== sourceEnvironmentId ||
      row.intent.registrationId !== row.registration_id
    )
      continue;
    return { intents: [row.intent] };
  }
  return { intents: [] };
}

/** Live query instead of the MCP poll timer: fires on every replicated intent change. */
export function watchWorkjetWorkerDispatchIntents(
  api: CtoxV4AppPort,
  sourceEnvironmentId: string,
  listener: () => void,
): () => void {
  return api
    .query(WORKJET_WORKER_DISPATCH_INTENTS, pendingIntents(sourceEnvironmentId))
    .subscribe(() => listener());
}

// ---------------------------------------------------------------- 5. ctox_business_os-Adapter (E49.7)

export type WorkjetBusinessOsRequest =
  | {
      readonly kind: "query";
      readonly collection: string;
      readonly selector?: Record<string, unknown>;
      readonly limit?: number;
    }
  | { readonly kind: "get"; readonly collection: string; readonly id: string }
  | {
      readonly kind: "command";
      readonly type: string;
      readonly payload: object;
      readonly recordId?: string;
    };

const ADAPTER_QUERY_LIMIT = 200;

/** Thin agent adapter over the V4 client: no MCP endpoint, no token, core rights decide. */
export async function callWorkjetBusinessOs(
  api: CtoxV4AppPort,
  request: WorkjetBusinessOsRequest,
): Promise<unknown> {
  switch (request.kind) {
    case "query":
      return api
        .query(request.collection, {
          ...(request.selector === undefined ? {} : { selector: request.selector }),
          limit: Math.min(request.limit ?? ADAPTER_QUERY_LIMIT, ADAPTER_QUERY_LIMIT),
        })
        .get();
    case "get":
      return api.get(request.collection, request.id).get();
    case "command":
      return runCtoxV4Command(
        api,
        request.type,
        request.payload,
        request.recordId === undefined ? undefined : { record_id: request.recordId },
      );
  }
}

// ---------------------------------------------------------------- 6. Wartung (E49.2/6)

export const CTOX_MAINTENANCE_RESTART = "ctox.maintenance.restart";

/**
 * Service restart without SSH. Behind a capability: the launch context must announce the route,
 * the actor must be admin, and a core without the route answers `unknown_command`.
 */
export async function requestCtoxMaintenanceRestart(
  api: CtoxV4AppPort,
  capabilities: ReadonlyArray<string>,
  reason: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }> {
  if (!capabilities.includes(CTOX_MAINTENANCE_RESTART))
    return { ok: false, code: "capability_missing" };
  if (api.actor.role !== "admin") return { ok: false, code: "forbidden" };
  try {
    await runCtoxV4Command(api, CTOX_MAINTENANCE_RESTART, { reason });
    return { ok: true };
  } catch (error) {
    const code = error instanceof CtoxV4AppError ? error.code : "command_failed";
    return { ok: false, code: code === "unknown_command" ? "capability_missing" : code };
  }
}
