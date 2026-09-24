import type {
  ProviderInstanceId,
  ThreadId,
  WorkjetCtoxCrewRequest,
  WorkjetThreadCtoxCrewChat,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import { CtoxCrewSessionBootstrap } from "../../mcp/CtoxCrewSessionBootstrap.ts";
import { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import { CtoxNativeRequestError, CtoxNativeRequests } from "./CtoxNativeRequests.ts";
import { makeCtoxNativeTaskClient, nativeTurnKeyForRequestId } from "./CtoxNativeTaskClient.ts";

type CrewTask = Omit<WorkjetCtoxCrewRequest, "operation" | "idempotency_key">;

/** Server-side handoff from a persisted Workjet turn to a native Crew offer.
 * The claim and command-session token never enter a renderer or persisted event.
 */
const make = Effect.gen(function* () {
  const requests = yield* CtoxNativeRequests;
  const connections = yield* DecisionHubConnectionRegistry;
  const transport = makeCtoxMcpTransport(yield* HttpClient.HttpClient);
  const native = makeCtoxNativeTaskClient({ requests, connections, transport });

  const prepare = Effect.fn("CtoxCrewTurnAdmission.prepare")(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly binding: WorkjetThreadCtoxCrewChat;
    readonly providerInstanceId: ProviderInstanceId;
    readonly task: Omit<CrewTask, "thread_id">;
  }) {
    const scope = {
      threadId: input.threadId,
      connectionId: input.binding.connectionId,
      instanceId: input.binding.instanceId,
    };
    const result = yield* native.prepareProjectExecution(
      scope,
      input.requestId,
      { ...input.task, thread_id: input.binding.chatId },
    );
    if (result.state !== "ready") return result;
    const claim = result.claim;
    return {
      ...result,
      bootstrap: CtoxCrewSessionBootstrap.of({
        binding: input.binding,
        nativeInstructions: claim.instructions,
        capability: {
          threadId: input.threadId,
          providerInstanceId: input.providerInstanceId,
          attemptId: claim.attemptId,
          refreshContext: claim.refreshContext,
          updatePlan: claim.updatePlan,
          report: claim.report,
        },
      }),
    };
  });

  const recover = Effect.fn("CtoxCrewTurnAdmission.recover")(function* (input: {
    readonly candidate: {
      readonly identity: {
        readonly threadId: ThreadId;
        readonly connectionId: WorkjetThreadCtoxCrewChat["connectionId"];
        readonly instanceId: string;
        readonly requestKey: string;
      };
      readonly requestId: string;
    };
    readonly binding: WorkjetThreadCtoxCrewChat;
    readonly providerInstanceId: ProviderInstanceId;
    readonly harness: WorkjetCtoxCrewRequest["harness"];
  }) {
    const { candidate, binding } = input;
    if (
      candidate.identity.connectionId !== binding.connectionId ||
      candidate.identity.instanceId !== binding.instanceId
    )
      return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
    const reference = yield* requests.get(candidate.identity);
    if (
      reference.request.operation !== "start_crew_execution" ||
      reference.request.thread_id !== binding.chatId ||
      reference.request.harness !== input.harness
    )
      return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
    const result = yield* native.prepareRecoveredProjectExecution(candidate);
    if (result.state !== "ready") return result;
    const claim = result.claim;
    return {
      ...result,
      bootstrap: CtoxCrewSessionBootstrap.of({
        binding,
        nativeInstructions: claim.instructions,
        capability: {
          threadId: candidate.identity.threadId,
          providerInstanceId: input.providerInstanceId,
          attemptId: claim.attemptId,
          refreshContext: claim.refreshContext,
          updatePlan: claim.updatePlan,
          report: claim.report,
        },
      }),
    };
  });

  const reissueClaimed = Effect.fn("CtoxCrewTurnAdmission.reissueClaimed")(function* (input: {
    readonly candidate: {
      readonly identity: {
        readonly threadId: ThreadId;
        readonly connectionId: WorkjetThreadCtoxCrewChat["connectionId"];
        readonly instanceId: string;
        readonly requestKey: string;
      };
      readonly requestId: string;
    };
    readonly binding: WorkjetThreadCtoxCrewChat;
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerThreadId: ThreadId;
    readonly harness: WorkjetCtoxCrewRequest["harness"];
    readonly attemptId: string;
  }) {
    const { candidate, binding } = input;
    if (!candidate.requestId.trim() || candidate.requestId.length > 512)
      return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
    const requestKey = nativeTurnKeyForRequestId(candidate.requestId);
    if (
      candidate.identity.requestKey !== requestKey ||
      candidate.identity.connectionId !== binding.connectionId ||
      candidate.identity.instanceId !== binding.instanceId ||
      candidate.identity.threadId !== input.providerThreadId
    )
      return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
    const reference = yield* requests.get(candidate.identity);
    if (
      reference.request.operation !== "start_crew_execution" ||
      reference.request.thread_id !== binding.chatId ||
      reference.request.harness !== input.harness
    )
      return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
    const saved = yield* requests.readCrewStart(candidate.identity, input.attemptId);
    if (
      saved?.providerInstanceId !== input.providerInstanceId ||
      saved.providerThreadId !== input.providerThreadId
    )
      return yield* new CtoxNativeRequestError({ reason: "native-task-reference-conflict" });
    const reissued = yield* native.reissueClaimedProjectOffer(
      candidate.identity,
      input.attemptId,
    );
    if (
      reissued.reservation.providerInstanceId !== input.providerInstanceId ||
      reissued.reservation.providerThreadId !== input.providerThreadId
    )
      return yield* new CtoxNativeRequestError({ reason: "native-task-reference-conflict" });
    const claim = reissued.claim;
    return {
      ...reissued,
      bootstrap: CtoxCrewSessionBootstrap.of({
        binding,
        nativeInstructions: claim.instructions,
        capability: {
          threadId: candidate.identity.threadId,
          providerInstanceId: input.providerInstanceId,
          attemptId: claim.attemptId,
          refreshContext: claim.refreshContext,
          updatePlan: claim.updatePlan,
          report: claim.report,
        },
      }),
    };
  });

  const bindProviderSession = Effect.fn("CtoxCrewTurnAdmission.bindProviderSession")(
    function* (input: {
      readonly identity: Parameters<typeof requests.readCrewStart>[0];
      readonly attemptId: string;
      readonly providerInstanceId: ProviderInstanceId;
      /** Workjet's durable provider-session route, not an unverified external cursor. */
      readonly providerThreadId: ThreadId;
    }) {
      const reservation = yield* requests.readCrewStart(input.identity, input.attemptId);
      if (!reservation)
        return yield* new CtoxNativeRequestError({ reason: "native-task-reference-conflict" });
      return yield* requests.bindCrewStartProvider(
        input.identity,
        reservation,
        input.providerInstanceId,
        input.providerThreadId,
      );
    },
  );

  return {
    prepare,
    recover,
    reissueClaimed,
    bindProviderSession,
    listRecoveryCandidates: requests.listCrewRecoveryCandidates,
  };
});

export class CtoxCrewTurnAdmission extends Context.Service<
  CtoxCrewTurnAdmission,
  Effect.Success<typeof make>
>()("workjet/workjet/ctox/CtoxCrewTurnAdmission") {
  static readonly layer = Layer.effect(this, make);
}
