// @effect-diagnostics nodeBuiltinImport:off -- Hashes the immutable wire request; no credential material is transported.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  RemoteWorkerDispatchError,
  RemoteWorkerRequest,
  WorkjetConnectionId,
  WorkjetComputerId,
  WorkjetGatewayCredentialRef,
  WorkjetGatewayModelRef,
  WorkjetGatewayProviderRef,
  type WorkjetGatewayGrantTarget,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProviderGatewayService } from "../../providerGateway/ProviderGatewayService.ts";
import type { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import type { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const RemoteWorkerNativeBinding = Schema.Struct({
  requestId: Id,
  requestDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sourceEnvironmentId: Id,
  sourceSupervisorThreadId: Id,
  sourceInstanceId: Id,
  projectId: Id,
  targetEnvironmentId: Id,
  targetConnectionId: Id,
  targetInstanceId: Id,
  targetComputerId: Id,
  repositoryUrl: Id,
  repositoryHead: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  workspaceKey: Id,
  credentialRef: WorkjetGatewayCredentialRef,
  providerRef: WorkjetGatewayProviderRef,
  modelRef: WorkjetGatewayModelRef,
  capabilities: Schema.Array(Schema.Literals([
    "repository_read", "repository_write", "run_checks", "open_pull_request",
  ])),
});
export type RemoteWorkerNativeBinding = typeof RemoteWorkerNativeBinding.Type;
export const RemoteWorkerNativeReceipt = Schema.Struct({
  contract: Schema.Literal("ctox.workjet.remote-worker-admission.v1"),
  permitId: Id,
  ownerUserId: Id,
  authorityEpoch: Schema.Int,
  authorityFingerprint: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  expiresAtMs: Schema.Int,
  binding: RemoteWorkerNativeBinding,
  state: Schema.Literals(["issued", "claimed", "revoked"]),
  executionId: Schema.NullOr(Id),
});
export type RemoteWorkerNativeReceipt = typeof RemoteWorkerNativeReceipt.Type;
export interface RemoteWorkerNativeScope {
  readonly connectionId: WorkjetConnectionId;
  readonly instanceId: string;
}
export interface RemoteWorkerModelReferences {
  readonly credentialRef: typeof WorkjetGatewayCredentialRef.Type;
  readonly providerRef: typeof WorkjetGatewayProviderRef.Type;
  readonly modelRef: typeof WorkjetGatewayModelRef.Type;
}
const failure = (reason: RemoteWorkerDispatchError["reason"]) =>
  new RemoteWorkerDispatchError({ reason });

/** Key ordering cannot change a request identity. Array ordering remains part
 * of the immutable wire request, including the explicitly delegated grants. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};
export const remoteWorkerRequestDigest = (request: RemoteWorkerRequest) =>
  Schema.encodeEffect(RemoteWorkerRequest)(request).pipe(
    Effect.map((wire) => NodeCrypto.createHash("sha256").update(canonicalJson(wire)).digest("hex")),
    Effect.mapError(() => failure("invalid-request")),
  );

/** This is a source-server client, never an offline permit verifier. The
 * target must return through its authenticated source environment connection.
 * Each operation resolves current source authority and intersects the current
 * account grant. Neither MCP bearer nor gateway secrets are returned. */
export function makeCtoxRemoteWorkerAdmissionClient(dependencies: {
  readonly connections: Pick<DecisionHubConnectionRegistry["Service"], "resolveReadyTarget">;
  readonly gateway: Pick<ProviderGatewayService["Service"], "scopedCatalog">;
  readonly transport: ReturnType<typeof makeCtoxMcpTransport>;
}) {
  const validate = Effect.fn("CtoxRemoteWorkerAdmission.validate")(function* (
    scope: RemoteWorkerNativeScope,
    request: RemoteWorkerRequest,
    binding: RemoteWorkerNativeBinding,
  ) {
    if (
      binding.requestId !== request.requestId ||
      binding.workspaceKey !== request.requestId ||
      binding.requestDigest !== (yield* remoteWorkerRequestDigest(request)) ||
      binding.sourceEnvironmentId !== request.parent.environmentId ||
      binding.sourceSupervisorThreadId !== request.parent.threadId ||
      binding.sourceInstanceId !== scope.instanceId ||
      binding.projectId !== request.project.id ||
      binding.targetEnvironmentId !== request.targetEnvironmentId ||
      binding.repositoryHead !== request.revision ||
      binding.modelRef.modelId !== request.modelSelection.model ||
      binding.sourceEnvironmentId === binding.targetEnvironmentId ||
      binding.credentialRef.environmentId !== binding.sourceEnvironmentId ||
      binding.providerRef.environmentId !== binding.sourceEnvironmentId ||
      binding.modelRef.environmentId !== binding.sourceEnvironmentId ||
      binding.providerRef.provider !== binding.modelRef.provider ||
      new Set(binding.capabilities).size !== binding.capabilities.length ||
      binding.capabilities.length === 0
    ) return yield* failure("invalid-request");
    let repository: URL;
    try { repository = new URL(binding.repositoryUrl); }
    catch { return yield* failure("invalid-request"); }
    // The canonical repository key is verified by native ownership policy too.
    const normalize = (url: URL) => `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "").replace(/\.git$/, "")}`;
    let requestRepository: URL;
    try {
      requestRepository = new URL(request.project.repository.locator.remoteUrl.replace(
        /^git@([A-Za-z0-9.-]+):/, "https://$1/",
      ));
    } catch { return yield* failure("invalid-request"); }
    if (repository.protocol !== "https:" || repository.username || repository.password ||
      repository.search || repository.hash || normalize(repository) !== normalize(requestRepository)) {
      return yield* failure("invalid-request");
    }
    const target: WorkjetGatewayGrantTarget = {
      connectionId: WorkjetConnectionId.make(binding.targetConnectionId),
      instanceId: binding.targetInstanceId,
      computerId: WorkjetComputerId.make(binding.targetComputerId),
    };
    // Native computer IDs can differ from the UI catalog ID. The exact native
    // assignment, not a hostname/display chip, scopes the source gateway grant.
    const catalog = yield* dependencies.gateway.scopedCatalog(
      target,
      request.parent.environmentId,
    ).pipe(Effect.mapError(() => failure("computer-unavailable")));
    if (!catalog.accounts.some((account) =>
      NodeUtil.isDeepStrictEqual(account.credentialRef, binding.credentialRef) &&
      NodeUtil.isDeepStrictEqual(account.providerRef, binding.providerRef) &&
      account.modelRefs.some((model) => NodeUtil.isDeepStrictEqual(model, binding.modelRef))
    )) return yield* failure("computer-unavailable");
  });
  const execute = Effect.fn("CtoxRemoteWorkerAdmission.execute")(function* (
    scope: RemoteWorkerNativeScope,
    request: RemoteWorkerRequest,
    binding: RemoteWorkerNativeBinding,
    action: "issue" | "claim" | "revalidate" | "revoke",
    permitId?: string,
    executionId?: string,
  ) {
    yield* validate(scope, request, binding);
    const target = yield* dependencies.connections.resolveReadyTarget(
      scope.connectionId, scope.instanceId,
    ).pipe(Effect.mapError(() => failure("source-unavailable")));
    const name = "business_os.remote_worker_admission";
    yield* dependencies.transport.probe(target, [name])
      .pipe(Effect.mapError(() => failure("source-unavailable")));
    const response = yield* dependencies.transport.callTool(target, name, {
      action, binding,
      ...(action === "issue" ? { ttl_seconds: 300 } : { permit_id: permitId }),
      ...(executionId === undefined ? {} : { execution_id: executionId }),
    }).pipe(Effect.mapError(() => failure("source-unavailable")));
    if (response.isError || response.structuredContent === undefined)
      return yield* failure("computer-unavailable");
    const receipt = yield* Schema.decodeUnknownEffect(RemoteWorkerNativeReceipt)(
      response.structuredContent,
    ).pipe(Effect.mapError(() => failure("invalid-request")));
    if (!NodeUtil.isDeepStrictEqual(receipt.binding, binding) ||
      (permitId !== undefined && receipt.permitId !== permitId) ||
      ((action === "claim" || action === "revalidate") &&
        (receipt.state !== "claimed" || receipt.executionId !== executionId)) ||
      (action === "revoke" && receipt.state !== "revoked") ||
      (action === "issue" && receipt.state !== "issued" && receipt.state !== "claimed")
    ) return yield* failure("invalid-request");
    return receipt;
  });
  return { execute };
}

