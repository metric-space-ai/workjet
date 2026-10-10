import {
  WorkjetGatewayInferenceError,
  WorkjetGatewayInferenceInput,
  type WorkjetGatewayInferenceProtocol,
  type WorkjetGatewayInferenceResult,
  WorkjetGatewayAdmissionInput,
  WorkjetRemoteWorkerPermit,
  type EnvironmentId,
  type WorkjetGatewayBindModelInput,
  type WorkjetGatewayModelBinding,
  type WorkjetGatewayScopedCatalog,
  type WorkjetGatewayGrantTarget,
  type WorkjetConfiguration,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isGatewayFailure = Schema.is(WorkjetGatewayInferenceError);
const decodePermit = Schema.decodeUnknownEffect(WorkjetRemoteWorkerPermit);
const decodeAdmission = Schema.decodeUnknownEffect(WorkjetGatewayAdmissionInput);
const decodeInference = Schema.decodeUnknownEffect(WorkjetGatewayInferenceInput);
const samePermit = Schema.toEquivalence(WorkjetRemoteWorkerPermit);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const failure = (reason: WorkjetGatewayInferenceError["reason"]) =>
  new WorkjetGatewayInferenceError({ reason });

// A lifecycle heartbeat must not extend an already dispatched model turn.
export const SOURCE_GATEWAY_TURN_TIMEOUT_MS = 120_000;

export const gatewayTargetForWorker = (binding: WorkjetRemoteWorkerPermit["binding"]) => ({
  connectionId: binding.targetConnectionId,
  instanceId: binding.targetInstanceId,
  computerId: binding.targetComputerId,
});

/** Exact source identity intersection; model aliases, pool fallback and labels confer no access. */
export function requireScopedGatewayModel(
  catalog: WorkjetGatewayScopedCatalog,
  selected: WorkjetGatewayModelBinding,
  sourceEnvironmentId: EnvironmentId,
): void {
  const sameTarget = (left: WorkjetGatewayGrantTarget, right: WorkjetGatewayGrantTarget) =>
    left.connectionId === right.connectionId &&
    left.instanceId === right.instanceId &&
    left.computerId === right.computerId;
  if (
    !sameTarget(catalog.target, selected.target) ||
    selected.credentialRef.environmentId !== sourceEnvironmentId ||
    selected.providerRef.environmentId !== sourceEnvironmentId ||
    selected.modelRef.environmentId !== sourceEnvironmentId ||
    selected.providerRef.provider !== selected.modelRef.provider
  )
    throw failure("binding-mismatch");
  const matches = catalog.accounts.filter(
    (account) =>
      account.credentialRef.environmentId === sourceEnvironmentId &&
      account.credentialRef.accountId === selected.credentialRef.accountId &&
      account.providerRef.environmentId === sourceEnvironmentId &&
      account.providerRef.provider === selected.providerRef.provider &&
      account.modelRefs.some(
        (model) =>
          model.environmentId === sourceEnvironmentId &&
          model.provider === selected.modelRef.provider &&
          model.modelId === selected.modelRef.modelId,
      ),
  );
  if (matches.length !== 1) throw failure("grant-unavailable");
}

export function makeSourceGatewayInference(dependencies: {
  readonly environmentId: Effect.Effect<EnvironmentId>;
  readonly configuration: Effect.Effect<WorkjetConfiguration, WorkjetGatewayInferenceError>;
  readonly requireSourceInstance: (
    instanceId: WorkjetGatewayBindModelInput["modelSelection"]["instanceId"],
  ) => Effect.Effect<void, WorkjetGatewayInferenceError>;
  readonly scopedCatalog: (
    target: WorkjetGatewayGrantTarget,
    environmentId: EnvironmentId,
  ) => Effect.Effect<WorkjetGatewayScopedCatalog, WorkjetGatewayInferenceError>;
  readonly revalidate: (
    input: WorkjetGatewayAdmissionInput,
  ) => Effect.Effect<unknown, WorkjetGatewayInferenceError>;
  readonly forward: (
    selected: WorkjetGatewayModelBinding,
    requestJson: string,
    deadlineMs: number,
  ) => Effect.Effect<string, WorkjetGatewayInferenceError>;
  readonly forwardProtocol?: (
    selected: WorkjetGatewayModelBinding,
    requestJson: string,
    deadlineMs: number,
    protocol: WorkjetGatewayInferenceProtocol,
  ) => Effect.Effect<WorkjetGatewayInferenceResult, WorkjetGatewayInferenceError>;
  readonly now: Effect.Effect<number>;
}) {
  const bindModel = Effect.fn("SourceGatewayInference.bindModel")(function* (
    input: WorkjetGatewayBindModelInput,
  ) {
    const environmentId = yield* dependencies.environmentId;
    const configuration = yield* dependencies.configuration;
    yield* dependencies.requireSourceInstance(input.modelSelection.instanceId);
    const routes = configuration.llmRoutes.filter(
      (route) => input.routeId === undefined || route.id === input.routeId,
    );
    if (routes.length === 0 || (input.routeId !== undefined && routes.length !== 1))
      return yield* failure("binding-mismatch");
    const accountsInRoutes = new Set(routes.map((route) => route.gatewayAccountId));
    const catalog = yield* dependencies.scopedCatalog(input.target, environmentId);
    const accounts = catalog.accounts.filter(
      (account) =>
        accountsInRoutes.has(account.credentialRef.accountId) &&
        account.modelRefs.some((model) => model.modelId === input.modelSelection.model),
    );
    const account = accounts.length === 1 ? accounts[0] : undefined;
    const modelRef = account?.modelRefs.find(
      (model) => model.modelId === input.modelSelection.model,
    );
    if (account === undefined || modelRef === undefined) return yield* failure("grant-unavailable");
    const selected = {
      target: input.target,
      credentialRef: account.credentialRef,
      providerRef: account.providerRef,
      modelRef,
    };
    yield* Effect.try({
      try: () => requireScopedGatewayModel(catalog, selected, environmentId),
      catch: () => failure("grant-unavailable"),
    });
    return selected;
  });

  const requireAuthority = Effect.fn("SourceGatewayInference.requireAuthority")(function* (
    input: WorkjetGatewayAdmissionInput,
  ) {
    const environmentId = yield* dependencies.environmentId;
    const binding = input.permit.binding;
    if (
      binding.sourceEnvironmentId !== environmentId ||
      binding.targetEnvironmentId === environmentId ||
      binding.workspaceKey !== binding.requestId
    )
      return yield* failure("binding-mismatch");
    const selected = {
      target: gatewayTargetForWorker(binding),
      credentialRef: binding.credentialRef,
      providerRef: binding.providerRef,
      modelRef: binding.modelRef,
    };
    const catalog = yield* dependencies.scopedCatalog(selected.target, environmentId);
    yield* Effect.try({
      try: () => requireScopedGatewayModel(catalog, selected, environmentId),
      catch: (error) => (isGatewayFailure(error) ? error : failure("grant-unavailable")),
    });
    const receipt = yield* dependencies.revalidate(input).pipe(
      Effect.flatMap(decodePermit),
      Effect.mapError((error) =>
        isGatewayFailure(error) ? error : failure("native-admission-rejected"),
      ),
    );
    const { renewalSequence: previousSequence, expiresAtMs: previousExpiry } = input.permit;
    const { renewalSequence, expiresAtMs } = receipt;
    if (
      !samePermit(receipt, { ...input.permit, renewalSequence, expiresAtMs }) ||
      renewalSequence < previousSequence ||
      (renewalSequence === previousSequence
        ? expiresAtMs !== previousExpiry
        : expiresAtMs <= previousExpiry) ||
      receipt.expiresAtMs <= (yield* dependencies.now)
    )
      return yield* failure("native-admission-rejected");
    return { selected, permit: receipt };
  });

  const admit = Effect.fn("SourceGatewayInference.admit")(function* (
    raw: WorkjetGatewayAdmissionInput,
  ) {
    const input = yield* decodeAdmission(raw).pipe(
      Effect.mapError(() => failure("invalid-request")),
    );
    yield* requireAuthority(input);
    return {};
  });

  const infer = Effect.fn("SourceGatewayInference.infer")(function* (
    raw: WorkjetGatewayInferenceInput,
  ) {
    // Snapshot all nested input before asynchronous authority calls.
    const input = yield* decodeInference(raw).pipe(
      Effect.mapError(() => failure("invalid-request")),
    );
    const binding = input.permit.binding;
    // Restrict the protocol at the source boundary; arbitrary URLs/headers never pass through.
    yield* Effect.try({
      try: () => {
        if (new TextEncoder().encode(input.requestJson).byteLength > 256 * 1024) throw new Error();
        const body: unknown = decodeJson(input.requestJson);
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
        const request = body as Record<string, unknown>;
        if (
          request.model !== binding.modelRef.modelId ||
          (request.stream !== undefined && (input.protocol === undefined ? request.stream !== false : typeof request.stream !== "boolean")) ||
          (request.background !== undefined && request.background !== false) ||
          request.previous_response_id !== undefined ||
          request.conversation !== undefined ||
          (input.protocol === "messages" || input.protocol === "chat-completions"
            ? !Array.isArray(request.messages)
            : request.input === undefined)
        )
          throw new Error();
      },
      catch: () => failure("invalid-request"),
    });
    const authority = yield* requireAuthority(input);
    if (authority.permit.expiresAtMs - (yield* dependencies.now) < SOURCE_GATEWAY_TURN_TIMEOUT_MS)
      return yield* failure("native-admission-rejected");
    const result = input.protocol === undefined
      ? { requestJson: yield* dependencies.forward(authority.selected, input.requestJson, authority.permit.expiresAtMs) }
      : dependencies.forwardProtocol === undefined
        ? yield* failure("gateway-unavailable")
        : yield* dependencies.forwardProtocol(authority.selected, input.requestJson, authority.permit.expiresAtMs, input.protocol);
    // A revoked/expired grant or native permit also prevents publication after the await.
    yield* requireAuthority({ ...input, permit: authority.permit });
    return result;
  });
  return { bindModel, admit, infer };
}
