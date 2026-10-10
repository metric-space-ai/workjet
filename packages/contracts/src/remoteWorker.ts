import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RepositoryIdentity } from "./environment.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import {
  WorkjetCapabilityId,
  WorkjetComputerId,
  WorkjetParentThreadReference,
  WorkjetWorkerProfileId,
  WorkjetLlmRouteId,
} from "./workjet.ts";

/** Prepared by the source server from its live orchestrator, relayed by an
 * authenticated client connection. Never contains source paths or credentials. */
export const RemoteWorkerHarness = Schema.Literals(["codex-cli", "claude-code", "grok-cli", "opencode", "greppy", "minimax-code", "pi-code"]);
export type RemoteWorkerHarness = typeof RemoteWorkerHarness.Type;
export const RemoteWorkerRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requestId: ThreadId,
  targetEnvironmentId: EnvironmentId,
  computerId: WorkjetComputerId,
  workerProfileId: Schema.optional(WorkjetWorkerProfileId),
  /** Absent in existing Codex requests; part of the immutable request digest. */
  harness: Schema.optional(RemoteWorkerHarness),
  llmRouteId: Schema.optional(WorkjetLlmRouteId),
  parent: WorkjetParentThreadReference,
  parentTeamRole: Schema.optional(Schema.Literals(["supervisor", "specialist"])),
  parentCapabilityIds: Schema.Array(WorkjetCapabilityId),
  managedInstructions: Schema.String,
  project: Schema.Struct({
    id: ProjectId,
    title: TrimmedNonEmptyString,
    repository: RepositoryIdentity,
  }),
  revision: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  enabledCapabilityIds: Schema.Array(WorkjetCapabilityId),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type RemoteWorkerRequest = typeof RemoteWorkerRequest.Type;

export const RemoteWorkerResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal("dispatched"),
  environmentId: EnvironmentId,
  workerThreadId: ThreadId,
  computerId: WorkjetComputerId,
  branch: TrimmedNonEmptyString,
  harness: Schema.optional(RemoteWorkerHarness),
  hostname: Schema.optional(TrimmedNonEmptyString),
  worktreePath: TrimmedNonEmptyString,
  parent: WorkjetParentThreadReference,
  modelSelection: ModelSelection,
  enabledCapabilityIds: Schema.Array(WorkjetCapabilityId),
});
export type RemoteWorkerResult = typeof RemoteWorkerResult.Type;

export const RemoteWorkerFailureReason = Schema.Literals([
  "invalid-request",
  "request-conflict",
  "source-unavailable",
  "computer-unavailable",
  "project-unavailable",
  "worktree-failed",
  "create-failed",
  "turn-start-failed",
  "rollback-failed",
]);
export class RemoteWorkerDispatchError extends Schema.TaggedErrorClass<RemoteWorkerDispatchError>()(
  "RemoteWorkerDispatchError",
  { reason: RemoteWorkerFailureReason },
) {
  override get message(): string {
    return `Remote worker dispatch failed: ${this.reason}.`;
  }
}
export const RemoteWorkerResponse = Schema.Struct({
  requestId: ThreadId,
  outcome: Schema.Union([
    Schema.Struct({ status: Schema.Literal("dispatched"), result: RemoteWorkerResult }),
    Schema.Struct({ status: Schema.Literal("failed"), reason: RemoteWorkerFailureReason }),
  ]),
});
export type RemoteWorkerResponse = typeof RemoteWorkerResponse.Type;
