/**
 * Test replica of the `workjet.worker.dispatch` handler of the instance module `workjet` (E54.3b).
 * Shell v4 owns the production handler; this one follows the same contract so the fake-core tests
 * exercise Workjet against it. Rebuilt 1:1 from ctox `mcp_workjet_worker_dispatch.rs` at the
 * kernel pin eca39cf84 (`Request` :82-118, `execute` :323-587, `dispatch_in_native_scope`
 * :591-698, `observe` :703-826, `retain_outcome` :830-941, `validate_result` :1037-1176):
 * seven actions over `ctx.get/read/put/patch`, idempotent replays (dispatch_key digest, immutable
 * completion and outcome), revision/epoch fences and the pending bound of 128. No capability.
 *
 * V4 differences, all from E54.3b: the owner is `command.actor.id`; the supervisor binding comes
 * from the ctox-owned `workjet_projects` row (`owner_user_id`, `supervisor_thread_id`,
 * `authority_epoch`; a foreign session is `forbidden`); `dispatch`/`observe` take the project from
 * `command.record_id` instead of the native supervisor session; the instance id is the module's
 * own; uniqueness of `(command_id, dispatch_key)` uses the supervisor scope as command id.
 */
export function workerDispatchHandlerSource(instanceId: string): string {
  return `const INSTANCE_ID = ${JSON.stringify(instanceId)};
const CONTRACT = "ctox.workjet.worker-dispatch.v1";
const SOURCES = "workjet_worker_dispatch_sources";
const INTENTS = "workjet_worker_dispatch_intents";
const OUTCOMES = "workjet_worker_dispatch_outcomes";
const FAILURES = ["role-not-authorized","parent-unavailable","parent-not-orchestrator","duplicate-capabilities","capability-escalation","computer-unavailable","worker-profile-unavailable","remote-dispatch-unavailable","remote-dispatch-failed","worktree-failed","create-failed","turn-start-failed","rollback-failed"];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const text = (value, max) => { if (typeof value !== "string" || !value || value.length > max || value !== value.trim() || value.includes("\\0")) fail("invalid", "invalid worker dispatch value"); };
const revision = (value) => { if (!Number.isInteger(value) || value < 1) fail("invalid", "invalid source revision"); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ARGS = {
  register_source: ["source_environment_id","source_supervisor_thread_id","project_id","expected_revision"],
  revoke_source: ["registration_id","revision"],
  poll: ["source_environment_id"],
  complete: ["registration_id","revision","intent_id","result"],
  report_outcome: ["registration_id","revision","intent_id","receipt"],
  dispatch: ["dispatch_key","task","title","computer_id","worker_profile_id"],
  observe: ["limit"],
};
async function currentProject(ctx, owner, project, thread) {
  const row = await ctx.get("workjet_projects", project);
  if (!row || row.is_deleted === true || row._deleted === true) fail("forbidden", "project not owned");
  if (row.owner_user_id !== undefined && row.owner_user_id !== owner) fail("forbidden", "project not owned");
  if (row.supervisor_thread_id !== thread) fail("forbidden", "source supervisor is not registered natively");
  return Number.isInteger(row.authority_epoch) ? row.authority_epoch : 1;
}
async function load(ctx, owner, id) {
  text(id, 128);
  const doc = await ctx.get(SOURCES, id);
  if (!doc || doc.owner_user_id !== owner) fail("not_found", "worker source registration unavailable");
  const record = doc.record;
  if (record.contract !== CONTRACT || record.ownerUserId !== owner || record.registrationId !== id || !(record.revision > 0)) fail("invalid", "invalid worker source registration");
  return record;
}
async function checkSource(ctx, owner, record, rev) {
  if (record.state !== "active" || record.revision !== rev || record.sourceInstanceId !== INSTANCE_ID) fail("conflict", "worker source is stale or revoked");
  const epoch = await currentProject(ctx, owner, record.projectId, record.sourceSupervisorThreadId);
  if (epoch !== record.authorityEpoch) fail("conflict", "worker source authority changed; explicit registration required");
}
async function save(ctx, record) {
  const doc = { id: record.registrationId, owner_user_id: record.ownerUserId, project_id: record.projectId, registration_id: record.registrationId, record };
  if (await ctx.get(SOURCES, doc.id)) await ctx.patch(SOURCES, doc.id, { record }); else await ctx.put(SOURCES, doc);
}
async function intentRow(ctx, intentId, registrationId, rev) {
  text(intentId, 128);
  const row = await ctx.get(INTENTS, intentId);
  if (!row || row.registration_id !== registrationId || row.registration_revision !== rev) fail("not_found", "worker dispatch intent unavailable");
  return row;
}
function validateResult(intent, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid", "dispatch result must be an object");
  if (JSON.stringify(value).length > 32768 || value.schemaVersion !== 1) fail("invalid", "invalid dispatch result schema/bound");
  if (value.status === "dispatched") {
    const allowed = ["schemaVersion","status","environmentId","workerThreadId","computerId","branch","worktreePath","parent","modelSelection","enabledCapabilityIds"];
    if (Object.keys(value).some((key) => !allowed.includes(key))) fail("invalid", "unknown dispatch result field");
    for (const field of ["environmentId","workerThreadId","computerId","branch","worktreePath"]) text(value[field], 2048);
    if (value.workerThreadId !== intent.intentId || value.parent?.environmentId !== intent.sourceEnvironmentId || value.parent?.threadId !== intent.sourceSupervisorThreadId || Object.keys(value.parent).length !== 2) fail("invalid", "dispatch result identity differs from intent");
    if (intent.computerId !== undefined && value.computerId !== intent.computerId) fail("invalid", "dispatch computer differs");
    const model = value.modelSelection;
    if (!model || Object.keys(model).some((key) => !["instanceId","model","options"].includes(key))) fail("invalid", "unknown model selection field");
    text(model.instanceId, 256); text(model.model, 256);
    const caps = value.enabledCapabilityIds;
    if (!Array.isArray(caps) || caps.length > 64 || new Set(caps).size !== caps.length) fail("invalid", "dispatch capabilities invalid");
    for (const cap of caps) text(cap, 256);
    return;
  }
  if (value.status === "failed") {
    if (Object.keys(value).length !== 3 || !FAILURES.includes(value.reason)) fail("invalid", "invalid terminal dispatch failure");
    return;
  }
  fail("invalid", "pending or unsupported dispatch result is not terminal");
}
async function readOutcome(ctx, owner, project, supervisor, intentId) {
  const row = await ctx.get(OUTCOMES, intentId);
  if (!row || row.owner_user_id !== owner || row.project_id !== project || row.supervisor_thread_id !== supervisor) return null;
  if (row.receipt.worker_thread_id !== intentId) fail("invalid", "persisted worker outcome identity differs");
  return { provenance: "authenticated_source_report", accepted_at_ms: row.accepted_at_ms, registration_revision: row.registration_revision, receipt: row.receipt };
}
async function boundProject(command, ctx, owner) {
  const project = command.record_id;
  text(project, 128);
  const row = await ctx.get("workjet_projects", project);
  if (!row) fail("forbidden", "dispatch outside a bound supervisor project");
  const thread = row.supervisor_thread_id;
  const epoch = await currentProject(ctx, owner, project, thread);
  return { project, thread, epoch };
}
async function sha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export default async function handle(command, ctx) {
  const p = { ...command.payload };
  delete p._context;
  const owner = command.actor?.id;
  if (!owner) fail("forbidden", "actor missing");
  const known = ARGS[p.action];
  if (!known) fail("invalid", "unknown worker dispatch action");
  for (const key of Object.keys(p)) if (key !== "action" && !known.includes(key)) fail("invalid", "unknown field " + key);
  switch (p.action) {
    case "register_source": {
      text(p.source_environment_id, 256); text(p.source_supervisor_thread_id, 36); text(p.project_id, 128);
      if (p.expected_revision !== undefined) revision(p.expected_revision);
      const epoch = await currentProject(ctx, owner, p.project_id, p.source_supervisor_thread_id);
      const existing = (await ctx.read(SOURCES, { selector: { owner_user_id: owner, project_id: p.project_id } }))[0];
      let record = existing?.record;
      if (!record) {
        if (p.expected_revision !== undefined) fail("not_found", "source registration does not exist");
        record = { contract: CONTRACT, registrationId: ctx.uuid(), revision: 1, sourceEnvironmentId: p.source_environment_id, sourceSupervisorThreadId: p.source_supervisor_thread_id, sourceInstanceId: INSTANCE_ID, sourceWorkspaceId: "workjet", projectId: p.project_id, ownerUserId: owner, authorityEpoch: epoch, state: "active" };
      }
      const unchanged = record.state === "active" && record.sourceEnvironmentId === p.source_environment_id && record.sourceSupervisorThreadId === p.source_supervisor_thread_id && record.sourceInstanceId === INSTANCE_ID && record.authorityEpoch === epoch;
      if (unchanged) {
        if (p.expected_revision !== undefined && p.expected_revision !== record.revision && p.expected_revision + 1 !== record.revision) fail("conflict", "source registration revision stale");
      } else {
        if (p.expected_revision !== record.revision) fail("conflict", "source replacement needs exact revision");
        record = { ...record, revision: record.revision + 1, sourceEnvironmentId: p.source_environment_id, sourceSupervisorThreadId: p.source_supervisor_thread_id, sourceInstanceId: INSTANCE_ID, authorityEpoch: epoch, state: "active" };
      }
      await save(ctx, record);
      return record;
    }
    case "revoke_source": {
      revision(p.revision);
      let record = await load(ctx, owner, p.registration_id);
      if (record.sourceInstanceId !== INSTANCE_ID) fail("forbidden", "source instance differs");
      if (record.state === "revoked") {
        if (p.revision !== record.revision && p.revision + 1 !== record.revision) fail("conflict", "source revision stale");
      } else {
        if (p.revision !== record.revision) fail("conflict", "source revocation needs exact revision");
        record = { ...record, revision: record.revision + 1, state: "revoked" };
      }
      await save(ctx, record);
      return record;
    }
    case "poll": {
      text(p.source_environment_id, 256);
      const rows = await ctx.read(INTENTS, { selector: { "intent.sourceEnvironmentId": p.source_environment_id, result: null }, sort: [{ intent_id: "asc" }] });
      for (const row of rows) {
        const source = await ctx.get(SOURCES, row.registration_id);
        const record = source?.record;
        if (!record || source.owner_user_id !== owner || record.state !== "active" || record.revision !== row.registration_revision || record.sourceInstanceId !== INSTANCE_ID || record.sourceEnvironmentId !== p.source_environment_id) continue;
        await checkSource(ctx, owner, record, row.registration_revision);
        return { contract: CONTRACT, intents: [row.intent], registration: record };
      }
      return { contract: CONTRACT, intents: [], registration: null };
    }
    case "complete": {
      revision(p.revision);
      const record = await load(ctx, owner, p.registration_id);
      await checkSource(ctx, owner, record, p.revision);
      const row = await intentRow(ctx, p.intent_id, p.registration_id, p.revision);
      validateResult(row.intent, p.result);
      if (row.result !== null && row.result !== undefined) {
        if (!equal(row.result, p.result)) fail("conflict", "dispatch completion differs from prior result");
      } else await ctx.patch(INTENTS, row.id, { result: p.result });
      return { contract: CONTRACT, intentId: p.intent_id, registrationId: p.registration_id, revision: p.revision, result: p.result };
    }
    case "report_outcome": {
      revision(p.revision); text(p.registration_id, 128); text(p.intent_id, 128);
      const receipt = p.receipt;
      if (!receipt || receipt.schema !== "ctox.workjet.worker-outcome.v1" || receipt.execution_stopped !== true) fail("invalid", "invalid worker outcome receipt");
      const source = await load(ctx, owner, p.registration_id);
      await checkSource(ctx, owner, source, p.revision);
      const row = await intentRow(ctx, p.intent_id, p.registration_id, p.revision);
      const intent = row.intent;
      if (intent.projectId !== source.projectId || intent.sourceSupervisorThreadId !== source.sourceSupervisorThreadId || intent.sourceEnvironmentId !== source.sourceEnvironmentId) fail("forbidden", "worker outcome source scope differs");
      const startup = row.result;
      if (!startup) fail("conflict", "worker has no startup acknowledgement");
      validateResult(intent, startup);
      if (startup.status !== "dispatched" || receipt.worker_thread_id !== intent.intentId || startup.workerThreadId !== receipt.worker_thread_id || startup.environmentId !== receipt.environment_id || startup.computerId !== receipt.computer_id || startup.branch !== receipt.branch || receipt.branch !== "workjet/worker/" + receipt.worker_thread_id) fail("invalid", "worker outcome does not match a stopped, acknowledged isolated worker");
      const pr = receipt.pull_request ?? {};
      if (!new RegExp("^https://github\\\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/" + pr.number + "$").test(pr.url) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pr.head_oid)) fail("invalid", "worker pull request identity or head is invalid");
      if (JSON.stringify(receipt).length > 16384) fail("invalid", "worker outcome exceeds bound");
      const prior = await ctx.get(OUTCOMES, p.intent_id);
      if (prior) {
        if (!equal(prior.receipt, receipt)) fail("conflict", "worker terminal outcome differs from its immutable prior receipt");
      } else await ctx.put(OUTCOMES, { id: p.intent_id, intent_id: p.intent_id, owner_user_id: owner, project_id: source.projectId, supervisor_thread_id: source.sourceSupervisorThreadId, registration_revision: p.revision, receipt, accepted_at_ms: ctx.now() });
      return readOutcome(ctx, owner, source.projectId, source.sourceSupervisorThreadId, p.intent_id);
    }
    case "dispatch": {
      text(p.dispatch_key, 128); text(p.task, 16384);
      if (p.title !== undefined) text(p.title, 200);
      for (const value of [p.computer_id, p.worker_profile_id]) if (value !== undefined) text(value, 256);
      const { project, thread, epoch } = await boundProject(command, ctx, owner);
      const executionKey = project + "/" + thread;
      const source = (await ctx.read(SOURCES, { selector: { owner_user_id: owner, project_id: project } }))[0];
      if (!source) fail("not_found", "no Workjet source registered for this supervisor");
      const record = source.record;
      if (record.state !== "active" || record.authorityEpoch !== epoch || record.sourceSupervisorThreadId !== thread) fail("conflict", "Workjet source binding stale");
      const digest = await sha256({ registrationId: record.registrationId, revision: record.revision, task: p.task, title: p.title ?? null, computerId: p.computer_id ?? null, workerProfileId: p.worker_profile_id ?? null });
      const prior = (await ctx.read(INTENTS, { selector: { command_id: executionKey, dispatch_key: p.dispatch_key } }))[0];
      if (prior) {
        if (prior.request_digest !== digest) fail("conflict", "dispatch_key reused with different scope or task");
        return { contract: CONTRACT, state: prior.result ? "completed" : "pending", intent: prior.intent, result: prior.result ?? null };
      }
      const pending = (await ctx.read(INTENTS, { selector: { result: null } })).filter((row) => row.intent.projectId !== undefined);
      let open = 0;
      for (const row of pending) {
        const s = await ctx.get(SOURCES, row.registration_id);
        if (s?.owner_user_id === owner && s.record.state === "active" && s.record.revision === row.registration_revision && s.record.authorityEpoch === epoch) open += 1;
      }
      if (open >= 128) fail("quota", "worker dispatch pending-intent capacity exceeded");
      const intent = { intentId: ctx.uuid(), registrationId: record.registrationId, registrationRevision: record.revision, sourceEnvironmentId: record.sourceEnvironmentId, sourceSupervisorThreadId: thread, projectId: project, task: p.task, ...(p.title === undefined ? {} : { title: p.title }), ...(p.computer_id === undefined ? {} : { computerId: p.computer_id }), ...(p.worker_profile_id === undefined ? {} : { workerProfileId: p.worker_profile_id }) };
      await ctx.put(INTENTS, { id: intent.intentId, intent_id: intent.intentId, registration_id: record.registrationId, registration_revision: record.revision, command_id: executionKey, dispatch_key: p.dispatch_key, request_digest: digest, intent, result: null });
      return { contract: CONTRACT, state: "pending", intent, result: null };
    }
    case "observe": {
      const limit = p.limit ?? 16;
      if (!Number.isInteger(limit) || limit < 1 || limit > 32) fail("invalid", "observe limit must be 1..32");
      const { project, thread, epoch } = await boundProject(command, ctx, owner);
      const rows = (await ctx.read(INTENTS, { selector: { "intent.projectId": project, "intent.sourceSupervisorThreadId": thread }, sort: [{ intent_id: "desc" }] }));
      const observations = [];
      let truncated = false;
      for (const row of rows) {
        const source = await ctx.get(SOURCES, row.registration_id);
        if (!source || source.owner_user_id !== owner) continue;
        if (observations.length === limit) { truncated = true; break; }
        const result = row.result;
        let acknowledgement = null;
        if (result) {
          validateResult(row.intent, result);
          acknowledgement = Object.fromEntries(["status","reason","workerThreadId","environmentId","computerId","branch"].filter((key) => key in result).map((key) => [key, result[key]]));
        }
        const record = source.record;
        observations.push({ intentId: row.intent_id, executionKey: row.command_id, dispatchKey: row.dispatch_key, registrationRevision: row.registration_revision,
          registrationCurrent: record.state === "active" && record.revision === row.registration_revision && record.authorityEpoch === epoch && record.sourceSupervisorThreadId === thread,
          title: row.intent.title ?? null, taskPreview: row.intent.task.slice(0, 256), computerId: row.intent.computerId ?? null, workerProfileId: row.intent.workerProfileId ?? null,
          acknowledgement, execution: null, reportedOutcome: await readOutcome(ctx, owner, project, thread, row.intent_id) });
      }
      return { contract: CONTRACT, projectId: project, supervisorThreadId: thread, observations, truncated };
    }
  }
}
`;
}
