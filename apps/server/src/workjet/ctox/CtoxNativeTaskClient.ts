// @effect-diagnostics nodeBuiltinImport:off -- Deterministic server-side turn identity, not a new request per retry.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Redacted from "effect/Redacted";
import { decodeCtoxCrewClaim, decodeCtoxCrewContext } from "./CtoxCrewClaim.ts";
import { reportCtoxCrewResult, type CtoxCrewResultCandidate } from "./CtoxCrewReport.ts";
import * as Schema from "effect/Schema";
import { CtoxCrewPlanInput, CtoxCrewPlanReceipt, decodeCtoxCrewPlanInput } from "./CtoxCrewPlan.ts";
import { WorkjetCtoxCrewOffers, WorkjetCtoxCrewReceipt } from "@workjet/contracts";
import type { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import type { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import { decodeCtoxNativeTaskStatus } from "./CtoxNativeTaskStatus.ts";
import {
  CtoxNativeRequestError,
  type CtoxNativeRequestIdentity,
  type CtoxNativeRequests,
  type NativeTaskRequest,
} from "./CtoxNativeRequests.ts";

/** Native harness and external MCP delegation share the same durable dispatch.
 * This client never owns the daemon or retries writes automatically. Closing
 * its caller leaves native work intact. The caller supplies a persisted intent
 * key and an immutable thread/connection/instance binding.
 */
export function makeCtoxNativeTaskClient(dependencies: {
  readonly connections: Pick<DecisionHubConnectionRegistry["Service"], "resolveReadyTarget">;
  readonly requests: CtoxNativeRequests["Service"];
  readonly transport: ReturnType<typeof makeCtoxMcpTransport>;
}) {
  const submit = Effect.fn("CtoxNativeTaskClient.submit")(function* (
    identity: CtoxNativeRequestIdentity,
    request: NativeTaskRequest,
    nativeRequestId?: string,
  ) {
    const target = yield* dependencies.connections.resolveReadyTarget(
      identity.connectionId,
      identity.instanceId,
    );
    const { operation, ...arguments_ } = request;
    const name =
      operation === "delegate_task" ? "business_os.execute_action" : `business_os.${operation}`;
    yield* dependencies.transport.probe(target, [name], { [name]: ["idempotency_key"] });
    const nativeKey = yield* dependencies.requests.prepare(identity, request, target);
    if (nativeRequestId !== undefined)
      yield* dependencies.requests.registerNativeTurn(identity, nativeRequestId);
    const result = yield* dependencies.transport.callTool(target, name, {
      ...arguments_,
      ...(operation === "delegate_task" ? { action_id: "ctox.delegate_task" } : {}),
      idempotency_key: nativeKey,
    });
    if (result.isError || result.structuredContent === undefined) {
      return yield* new CtoxNativeRequestError({ reason: "ctox-operation-rejected" });
    }
    yield* dependencies.requests.recordReceipt(identity, result.structuredContent);
    return {
      reference: yield* dependencies.requests.get(identity),
      result: result.structuredContent,
    };
  });

  const submitTurn = Effect.fn("CtoxNativeTaskClient.submitTurn")(function* (
    scope: Omit<CtoxNativeRequestIdentity, "requestKey">,
    requestId: string,
    task: Omit<
      Extract<NativeTaskRequest, { readonly operation: "delegate_task" }>,
      "operation" | "idempotency_key"
    >,
  ) {
    if (!requestId.trim() || requestId.length > 512)
      return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
    // Command/event ids are persisted before provider dispatch. Hashing only
    // that identity keeps retries stable and still detects changed task intent
    // in the ledger. Identical text in distinct commands remains distinct work.
    const requestKey = `turn_${NodeCrypto.createHash("sha256").update(requestId).digest("hex")}`;
    return yield* submit(
      { ...scope, requestKey },
      {
        ...task,
        operation: "delegate_task",
        idempotency_key: requestKey,
      },
      requestId,
    );
  });

  const submitProjectTurn = Effect.fn("CtoxNativeTaskClient.submitProjectTurn")(function* (
    scope: Omit<CtoxNativeRequestIdentity, "requestKey">,
    requestId: string,
    task: Omit<
      Extract<NativeTaskRequest, { readonly operation: "start_crew_execution" }>,
      "operation" | "idempotency_key"
    >,
  ) {
    if (!requestId.trim() || requestId.length > 512)
      return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
    const requestKey = `turn_${NodeCrypto.createHash("sha256").update(requestId).digest("hex")}`;
    // This uses the same durable turn/intent ledger as native delegation. A
    // request id cannot silently switch from a native to an external execution.
    return yield* submit(
      { ...scope, requestKey },
      { ...task, operation: "start_crew_execution", idempotency_key: requestKey },
      requestId,
    );
  });

  const discoverProjectOffers = Effect.fn("CtoxNativeTaskClient.discoverProjectOffers")(function* (
    identity: CtoxNativeRequestIdentity,
    executorId: string,
  ) {
    const reference = yield* dependencies.requests.get(identity);
    const request = reference.request;
    if (request.operation !== "start_crew_execution")
      return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
    if (!reference.commandId) return { reference, state: "awaiting-command" as const, offers: [] };
    const target = yield* dependencies.connections.resolveReadyTarget(
      identity.connectionId,
      identity.instanceId,
    );
    yield* dependencies.requests.verifyTarget(identity, target);
    const name = "business_os.list_crew_executions";
    yield* dependencies.transport.probe(target, [name]);
    const response = yield* dependencies.transport.callTool(target, name, {
      command_id: reference.commandId,
      executor_id: executorId,
    });
    if (response.isError || response.structuredContent === undefined)
      return yield* new CtoxNativeRequestError({ reason: "ctox-operation-rejected" });
    const result = yield* Schema.decodeUnknownEffect(WorkjetCtoxCrewOffers)(
      response.structuredContent,
    ).pipe(
      Effect.mapError(() => new CtoxNativeRequestError({ reason: "native-response-invalid" })),
    );
    if (
      result.command_id !== reference.commandId ||
      result.executor_id !== executorId ||
      result.offers.some((offer) => offer.harness !== request.harness)
    )
      return yield* new CtoxNativeRequestError({ reason: "native-response-invalid" });
    return { reference, state: "observed" as const, offers: result.offers };
  });

  const claimProjectOffer = Effect.fn("CtoxNativeTaskClient.claimProjectOffer")(function* (
    requestIdentity: CtoxNativeRequestIdentity,
    executorId: string,
    attemptId: string,
  ) {
    const identity = { ...requestIdentity };
    const reference = yield* dependencies.requests.get(identity);
    if (
      reference.request.operation !== "start_crew_execution" ||
      !reference.commandId ||
      !reference.taskId
    )
      return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
    const target = yield* dependencies.connections.resolveReadyTarget(
      identity.connectionId,
      identity.instanceId,
    );
    yield* dependencies.requests.verifyTarget(identity, target);
    const name = "business_os.claim_crew_execution";
    yield* dependencies.transport.probe(target, [name]);
    const response = yield* dependencies.transport.callTool(target, name, {
      command_id: reference.commandId,
      executor_id: executorId,
      attempt_id: attemptId,
    });
    if (response.isError || response.structuredContent === undefined)
      return yield* new CtoxNativeRequestError({ reason: "ctox-operation-rejected" });
    const claim = yield* decodeCtoxCrewClaim(
      reference,
      executorId,
      attemptId,
      yield* Clock.currentTimeMillis,
      response.structuredContent,
    );
    const boundIdentity = { ...identity };
    const boundContext = { ...claim.context };
    const boundTaskId = boundContext.task_id;
    // Keep the report capability bound to this successful claim. Callers cannot
    // substitute a command session, endpoint, attempt or request identity.
    const resolveClaimTarget = Effect.fn("CtoxNativeTaskClient.resolveClaimTarget")(function* () {
      const current = yield* dependencies.requests.get(boundIdentity);
      if (
        current.commandId !== claim.commandId ||
        current.taskId !== boundTaskId ||
        current.request.operation !== "start_crew_execution" ||
        current.request.harness !== claim.harness
      )
        return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
      const currentTarget = yield* dependencies.connections.resolveReadyTarget(
        boundIdentity.connectionId,
        boundIdentity.instanceId,
      );
      yield* dependencies.requests.verifyTarget(boundIdentity, currentTarget);
      return currentTarget;
    });
    const refreshContext = Effect.fn("CtoxNativeTaskClient.refreshProjectCrewContext")(
      function* () {
        const currentTarget = yield* resolveClaimTarget();
        const sessionTarget = {
          endpoint: currentTarget.endpoint,
          token: Redacted.value(claim.commandSession),
        };
        const name = "business_os.get_crew_context";
        yield* dependencies.transport.probe(sessionTarget, [name]);
        const response = yield* dependencies.transport.callTool(sessionTarget, name, {
          attempt_id: claim.attemptId,
        });
        if (response.isError || response.structuredContent === undefined)
          return yield* new CtoxNativeRequestError({ reason: "ctox-operation-rejected" });
        return yield* decodeCtoxCrewContext(boundContext, response.structuredContent);
      },
    );
    const updatePlan = Effect.fn("CtoxNativeTaskClient.updateProjectCrewPlan")(function* (
      candidate: typeof CtoxCrewPlanInput.Type,
    ) {
      const input = yield* decodeCtoxCrewPlanInput(candidate);
      const currentTarget = yield* resolveClaimTarget();
      const sessionTarget = {
        endpoint: currentTarget.endpoint,
        token: Redacted.value(claim.commandSession),
      };
      const name = "business_os.update_crew_plan";
      yield* dependencies.transport.probe(sessionTarget, [name]);
      const response = yield* dependencies.transport.callTool(sessionTarget, name, input);
      if (response.isError || response.structuredContent === undefined)
        return yield* new CtoxNativeRequestError({ reason: "ctox-operation-rejected" });
      const receipt = yield* Schema.decodeUnknownEffect(CtoxCrewPlanReceipt)(
        response.structuredContent,
      ).pipe(
        Effect.mapError(() => new CtoxNativeRequestError({ reason: "native-response-invalid" })),
      );
      if (receipt.command_id !== claim.commandId || receipt.task_id !== boundTaskId)
        return yield* new CtoxNativeRequestError({ reason: "native-response-invalid" });
      return receipt;
    });
    const report = Effect.fn("CtoxNativeTaskClient.reportProjectOffer")(function* (
      candidate: CtoxCrewResultCandidate,
    ) {
      const currentTarget = yield* resolveClaimTarget();
      // Native verifies the current lease and supports identical report retries.
      // Do not reject locally just because an accepted report's deadline passed.
      return yield* reportCtoxCrewResult(dependencies.transport, currentTarget, claim, candidate);
    });
    return { ...claim, refreshContext, updatePlan, report };
  });

  const readStatus = Effect.fn("CtoxNativeTaskClient.readStatus")(function* (
    requestIdentity: CtoxNativeRequestIdentity,
  ) {
    const identity = { ...requestIdentity };
    const reference = yield* dependencies.requests.get(identity);
    if (!reference.commandId)
      return {
        reference,
        state: "unresolved" as const,
        status: null,
        note: null,
        result: null,
      };
    const target = yield* dependencies.connections.resolveReadyTarget(
      identity.connectionId,
      identity.instanceId,
    );
    yield* dependencies.requests.verifyTarget(identity, target);
    const name = "business_os.get_command_status";
    yield* dependencies.transport.probe(target, [name]);
    const response = yield* dependencies.transport.callTool(target, name, {
      command_id: reference.commandId,
    });
    if (response.isError || response.structuredContent === undefined)
      return yield* new CtoxNativeRequestError({ reason: "ctox-operation-rejected" });
    const observed = yield* decodeCtoxNativeTaskStatus(reference, response.structuredContent);
    if (reference.taskId === null && observed.reference.taskId !== null) {
      yield* dependencies.requests.recordObservedTask(
        identity,
        reference.commandId,
        observed.reference.taskId,
      );
      return { ...observed, reference: yield* dependencies.requests.get(identity) };
    }
    return observed;
  });

  /** One bounded admission observation. Waiting is data, never an implicit local fallback. */
  const prepareProjectExecution = Effect.fn("CtoxNativeTaskClient.prepareProjectExecution")(
    function* (
      requestScope: Omit<CtoxNativeRequestIdentity, "requestKey">,
      requestId: string,
      task: Omit<
        Extract<NativeTaskRequest, { readonly operation: "start_crew_execution" }>,
        "operation" | "idempotency_key"
      >,
    ) {
      const scope = { ...requestScope };
      const submitted = yield* submitProjectTurn(scope, requestId, { ...task });
      const receipt = yield* Schema.decodeUnknownEffect(WorkjetCtoxCrewReceipt)(
        submitted.result,
      ).pipe(
        Effect.mapError(() => new CtoxNativeRequestError({ reason: "native-response-invalid" })),
      );
      const identity = { ...scope, requestKey: submitted.reference.request.idempotency_key };
      const observed = yield* readStatus(identity);
      if (
        observed.state === "completed" ||
        observed.state === "failed" ||
        observed.state === "cancelled"
      )
        return { state: "native-terminal" as const, identity, observed };
      if (
        !observed.reference.taskId ||
        observed.state === "unknown" ||
        observed.state === "unresolved"
      )
        return { state: "awaiting-native-task" as const, identity, observed };
      const discovered = yield* discoverProjectOffers(identity, receipt.executor_id);
      const now = yield* Clock.currentTimeMillis;
      const active = discovered.offers.filter(
        (offer) => offer.state !== "reported" && offer.deadline_ms > now,
      );
      if (active.length > 1)
        return yield* new CtoxNativeRequestError({ reason: "native-response-invalid" });
      const offer = active[0];
      if (!offer)
        return {
          state: discovered.offers.some((offer) => offer.state === "reported")
            ? ("awaiting-native-review" as const)
            : ("awaiting-native-offer" as const),
          identity,
          observed,
        };
      // Reclaiming an existing attempt requires a controller's durable resume binding.
      // A fresh start must not run a second local harness for an already claimed offer.
      if (offer.state === "claimed")
        return {
          state: "resume-required" as const,
          identity,
          observed,
          attemptId: offer.attempt_id,
        };
      const reservation = yield* dependencies.requests.reserveCrewStart(identity, {
        attemptId: offer.attempt_id,
        commandId: receipt.command_id,
        taskId: observed.reference.taskId,
        executorId: receipt.executor_id,
        memberId: receipt.crew_member_id,
      });
      if (reservation.state === "existing")
        return {
          state: "resume-required" as const,
          identity,
          observed,
          attemptId: offer.attempt_id,
        };
      const claim = yield* claimProjectOffer(identity, receipt.executor_id, offer.attempt_id);
      if (claim.context.member_id !== receipt.crew_member_id)
        return yield* new CtoxNativeRequestError({ reason: "native-response-invalid" });
      return { state: "ready" as const, identity, observed, claim };
    },
  );

  return {
    prepareProjectExecution,
    submit,
    submitTurn,
    submitProjectTurn,
    discoverProjectOffers,
    claimProjectOffer,
    readStatus,
    recover: dependencies.requests.get,
    latestNativeTurn: dependencies.requests.latestNativeTurn,
  };
}
