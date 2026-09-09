// @effect-diagnostics nodeBuiltinImport:off -- Deterministic server-side turn identity, not a new request per retry.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
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

  const readStatus = Effect.fn("CtoxNativeTaskClient.readStatus")(function* (
    identity: CtoxNativeRequestIdentity,
  ) {
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
    return yield* decodeCtoxNativeTaskStatus(reference, response.structuredContent);
  });

  return {
    submit,
    submitTurn,
    submitProjectTurn,
    readStatus,
    recover: dependencies.requests.get,
    latestNativeTurn: dependencies.requests.latestNativeTurn,
  };
}
