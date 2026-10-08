import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkjetComputerId, WorkjetWorkerProfileId } from "./workjet.ts";
import { RemoteWorkerResult } from "./remoteWorker.ts";

export const NATIVE_SUPERVISOR_WORKER_CONTRACT = "ctox.workjet.worker-dispatch.v1";
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const IntentId = ThreadId.check(Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/));
export const NativeSupervisorSource = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceSupervisorThreadId: ThreadId,
  projectId: ProjectId,
});
export type NativeSupervisorSource = typeof NativeSupervisorSource.Type;
export const NativeSupervisorSourceRegistration = Schema.Struct({
  contract: Schema.Literal(NATIVE_SUPERVISOR_WORKER_CONTRACT),
  registrationId: TrimmedNonEmptyString,
  revision: Revision,
  ownerUserId: TrimmedNonEmptyString,
  sourceInstanceId: TrimmedNonEmptyString,
  authorityEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.Literal("active"),
  ...NativeSupervisorSource.fields,
});
export type NativeSupervisorSourceRegistration = typeof NativeSupervisorSourceRegistration.Type;
export const NativeSupervisorWorkerIntent = Schema.Struct({
  intentId: IntentId,
  registrationId: TrimmedNonEmptyString,
  registrationRevision: Revision,
  ...NativeSupervisorSource.fields,
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  computerId: Schema.optional(WorkjetComputerId),
  workerProfileId: Schema.optional(WorkjetWorkerProfileId),
});
export type NativeSupervisorWorkerIntent = typeof NativeSupervisorWorkerIntent.Type;
export const NativeSupervisorWorkerFailureReason = Schema.Literals([
  "role-not-authorized", "parent-unavailable", "parent-not-orchestrator",
  "duplicate-capabilities", "capability-escalation", "computer-unavailable",
  "worker-profile-unavailable", "remote-dispatch-unavailable", "remote-dispatch-failed",
  "worktree-failed", "create-failed", "turn-start-failed", "rollback-failed",
]);
/** A pending source request is never a terminal failure or a second worker. */
export const NativeSupervisorWorkerCompletion = Schema.Union([
  RemoteWorkerResult,
  Schema.Struct({ schemaVersion: Schema.Literal(1), status: Schema.Literal("failed"), reason: NativeSupervisorWorkerFailureReason }),
]);
export type NativeSupervisorWorkerCompletion = typeof NativeSupervisorWorkerCompletion.Type;
