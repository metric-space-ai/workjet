import * as Schema from "effect/Schema";
import { ModelSelection } from "./orchestration.ts";
import { RemoteWorkerRequest } from "./remoteWorker.ts";
import { EnvironmentId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  WorkjetConnectionId,
  WorkjetLlmRouteId,
  WorkjetGatewayGrantTarget,
  WorkjetGatewayCredentialRef,
  WorkjetGatewayProviderRef,
  WorkjetGatewayModelRef,
} from "./workjet.ts";

/** References selected at source. This is a binding, never an inference permission. */
export const WorkjetGatewayModelBinding = Schema.Struct({
  target: WorkjetGatewayGrantTarget,
  credentialRef: WorkjetGatewayCredentialRef,
  providerRef: WorkjetGatewayProviderRef,
  modelRef: WorkjetGatewayModelRef,
});
export type WorkjetGatewayModelBinding = typeof WorkjetGatewayModelBinding.Type;
export const WorkjetGatewayBindModelInput = Schema.Struct({
  target: WorkjetGatewayGrantTarget,
  modelSelection: ModelSelection,
  /** Optional explicit configured route; ambiguity otherwise fails closed. */
  routeId: Schema.optionalKey(WorkjetLlmRouteId),
});
export type WorkjetGatewayBindModelInput = typeof WorkjetGatewayBindModelInput.Type;

const Identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
/** CTOX native remote-worker admission contract; the source MCP owns its policy. */
export const WorkjetRemoteWorkerBinding = Schema.Struct({
  requestId: Identifier,
  requestDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sourceEnvironmentId: EnvironmentId,
  sourceSupervisorThreadId: ThreadId,
  sourceInstanceId: Identifier,
  projectId: Identifier,
  targetEnvironmentId: EnvironmentId,
  targetConnectionId: WorkjetConnectionId,
  targetInstanceId: Identifier,
  targetComputerId: WorkjetGatewayGrantTarget.fields.computerId,
  repositoryUrl: Identifier,
  repositoryHead: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  workspaceKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  credentialRef: WorkjetGatewayCredentialRef,
  providerRef: WorkjetGatewayProviderRef,
  modelRef: WorkjetGatewayModelRef,
  capabilities: Schema.Array(
    Schema.Literals(["repository_read", "repository_write", "run_checks", "open_pull_request"]),
  ),
});
export type WorkjetRemoteWorkerBinding = typeof WorkjetRemoteWorkerBinding.Type;

export const WorkjetRemoteWorkerPermit = Schema.Struct({
  contract: Schema.Literal("ctox.workjet.remote-worker-admission.v1"),
  permitId: Identifier,
  ownerUserId: Identifier,
  authorityEpoch: NonNegativeInt,
  authorityFingerprint: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  expiresAtMs: NonNegativeInt,
  binding: WorkjetRemoteWorkerBinding,
  state: Schema.Literal("claimed"),
  renewalSequence: NonNegativeInt,
  executionId: Identifier,
});
export type WorkjetRemoteWorkerPermit = typeof WorkjetRemoteWorkerPermit.Type;

/** Only the source-side managed bridge calls this. No source bearer is a worker credential. */
export const WorkjetGatewayAdmissionInput = Schema.Struct({
  sourceConnectionId: WorkjetConnectionId,
  workerRequest: RemoteWorkerRequest,
  permit: WorkjetRemoteWorkerPermit,
});
export type WorkjetGatewayAdmissionInput = typeof WorkjetGatewayAdmissionInput.Type;
export const WorkjetGatewayInferenceProtocol = Schema.Literals(["responses", "messages", "chat-completions"]);
export type WorkjetGatewayInferenceProtocol = typeof WorkjetGatewayInferenceProtocol.Type;
export const WorkjetGatewayInferenceInput = Schema.Struct({
  ...WorkjetGatewayAdmissionInput.fields,
  /** Absent retains the original non-streaming Responses worker contract. */
  protocol: Schema.optionalKey(WorkjetGatewayInferenceProtocol),
  // Bounded native protocol body. No URL or header injection.
  requestJson: Schema.String.check(Schema.isMaxLength(256 * 1024)),
});
export type WorkjetGatewayInferenceInput = typeof WorkjetGatewayInferenceInput.Type;
export const WorkjetGatewayInferenceResult = Schema.Struct({
  requestJson: Schema.String.check(Schema.isMaxLength(1024 * 1024)),
  contentType: Schema.optionalKey(Schema.Literals(["application/json", "text/event-stream"])),
});
export type WorkjetGatewayInferenceResult = typeof WorkjetGatewayInferenceResult.Type;

export class WorkjetGatewayInferenceError extends Schema.TaggedErrorClass<WorkjetGatewayInferenceError>()(
  "WorkjetGatewayInferenceError",
  {
    reason: Schema.Literals([
      "binding-mismatch",
      "grant-unavailable",
      "native-admission-unavailable",
      "native-admission-rejected",
      "gateway-unavailable",
      "invalid-request",
      "inference-failed",
    ]),
  },
) {}
