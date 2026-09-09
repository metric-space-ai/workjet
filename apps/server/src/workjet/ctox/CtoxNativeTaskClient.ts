// @effect-diagnostics nodeBuiltinImport:off -- Deterministic server-side turn identity, not a new request per retry.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import type { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import type { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
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
    );
  });

  return { submit, submitTurn, recover: dependencies.requests.get };
}
