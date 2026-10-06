import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WorkjetCtoxCrewRequest,
  WorkjetThreadCtoxCrewChat,
} from "@workjet/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";

import { CtoxCrewSessionBootstrap } from "../../mcp/CtoxCrewSessionBootstrap.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import { makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import { CtoxNativeRequestError, CtoxNativeRequests } from "./CtoxNativeRequests.ts";
import { makeCtoxNativeTaskClient, nativeTurnKeyForRequestId } from "./CtoxNativeTaskClient.ts";

type CrewTask = Omit<WorkjetCtoxCrewRequest, "operation" | "idempotency_key">;
const encodeNativeReply = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ reply: Schema.String, error: Schema.Null })),
);

/** Server-side handoff from a persisted Workjet turn to a native Crew offer.
 * The claim and command-session token never enter a renderer or persisted event.
 */
const make = Effect.gen(function* () {
  const requests = yield* CtoxNativeRequests;
  const projection = yield* ProjectionSnapshotQuery;
  const connections = yield* DecisionHubConnectionRegistry;
  const transport = makeCtoxMcpTransport(yield* HttpClient.HttpClient);
  const native = makeCtoxNativeTaskClient({ requests, connections, transport });
  const terminalReportMutex = yield* Semaphore.make(1);
  let terminalAfterSequence = 0;

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
    const result = yield* native.prepareProjectExecution(scope, input.requestId, {
      ...input.task,
      thread_id: input.binding.chatId,
    });
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
    readonly codexResumeThreadId: string | null;
    readonly providerDriverKind: ProviderDriverKind;
    readonly providerResumeIdentity: string;
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
      !saved ||
      saved.providerInstanceId !== input.providerInstanceId ||
      saved.providerThreadId !== input.providerThreadId ||
      saved.codexResumeThreadId !== input.codexResumeThreadId ||
      saved.providerDriverKind !== input.providerDriverKind ||
      saved.providerResumeIdentity !== input.providerResumeIdentity
    )
      return yield* new CtoxNativeRequestError({ reason: "native-task-reference-conflict" });
    const reissued = yield* native.reissueClaimedProjectOffer(candidate.identity, input.attemptId);
    if (
      reissued.reservation.providerInstanceId !== input.providerInstanceId ||
      reissued.reservation.providerThreadId !== input.providerThreadId ||
      reissued.reservation.codexResumeThreadId !== input.codexResumeThreadId ||
      reissued.reservation.providerDriverKind !== input.providerDriverKind ||
      reissued.reservation.providerResumeIdentity !== input.providerResumeIdentity
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
      readonly codexResumeThreadId: string | null;
      readonly providerDriverKind: ProviderDriverKind;
      readonly providerResumeIdentity: string;
    }) {
      const reservation = yield* requests.readCrewStart(input.identity, input.attemptId);
      if (!reservation)
        return yield* new CtoxNativeRequestError({ reason: "native-task-reference-conflict" });
      return yield* requests.bindCrewStartProvider(
        input.identity,
        reservation,
        input.providerInstanceId,
        input.providerThreadId,
        input.codexResumeThreadId,
        input.providerDriverKind,
        input.providerResumeIdentity,
      );
    },
  );

  const reserveContinuation = Effect.fn("CtoxCrewTurnAdmission.reserveContinuation")(
    function* (input: {
      readonly identity: Parameters<typeof requests.readCrewStart>[0];
      readonly attemptId: string;
      readonly providerInstanceId: ProviderInstanceId;
      readonly providerThreadId: ThreadId;
    }) {
      return yield* requests.reserveCrewRecoveryDispatch(
        input.identity,
        input.attemptId,
        input.providerInstanceId,
        input.providerThreadId,
      );
    },
  );

  const bindProviderTurn = Effect.fn("CtoxCrewTurnAdmission.bindProviderTurn")(function* (input: {
    readonly identity: Parameters<typeof requests.readCrewStart>[0];
    readonly attemptId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerThreadId: ThreadId;
    readonly providerTurnId: string;
  }) {
    yield* requests.bindCrewProviderTurn(
      input.identity,
      input.attemptId,
      input.providerInstanceId,
      input.providerThreadId,
      input.providerTurnId,
    );
  });

  const recordProviderTerminal = Effect.fn("CtoxCrewTurnAdmission.recordProviderTerminal")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly providerTurnId: string;
      readonly state: "completed" | "failed" | "interrupted" | "cancelled";
    }) {
      return yield* requests.recordCrewProviderTerminal(input);
    },
  );

  const reconcileTerminalOutbox = Effect.fn("CtoxCrewTurnAdmission.reconcileTerminalOutbox")(
    function* () {
      return yield* terminalReportMutex.withPermits(1)(
        Effect.gen(function* () {
          let afterSequence = terminalAfterSequence;
          let reported = 0;
          let deferred = 0;
          let pending = 0;
          for (let pageNumber = 0; pageNumber < 16; pageNumber++) {
            const page = yield* requests.listCrewTerminalOutbox(afterSequence);
            for (const candidate of page.candidates) {
              yield* Effect.gen(function* () {
                const saved = yield* requests.readCrewStart(
                  candidate.identity,
                  candidate.attemptId,
                );
                if (
                  !saved ||
                  saved.providerInstanceId !== candidate.providerInstanceId ||
                  saved.providerThreadId !== candidate.identity.threadId
                )
                  return yield* new CtoxNativeRequestError({
                    reason: "native-task-reference-conflict",
                  });
                const detail = Option.getOrUndefined(
                  yield* projection.getThreadDetailById(candidate.identity.threadId),
                );
                if (!detail && candidate.terminalState === "completed") {
                  deferred += 1;
                  return;
                }
                const reply =
                  detail?.messages
                    .filter(
                      (message) =>
                        message.role === "assistant" &&
                        message.turnId === candidate.providerTurnId &&
                        !message.streaming,
                    )
                    .at(-1)
                    ?.text.trim() ?? "";
                const now = yield* Clock.currentTimeMillis;
                if (
                  candidate.terminalState === "completed" &&
                  reply.length === 0 &&
                  now - candidate.terminalAtMs < 30_000
                ) {
                  deferred += 1;
                  return;
                }
                const result =
                  candidate.terminalState === "completed" &&
                  reply.length > 0 &&
                  new TextEncoder().encode(encodeNativeReply({ reply, error: null })).byteLength <=
                    256 * 1024
                    ? ({ reply } as const)
                    : ({
                        error:
                          candidate.terminalState === "completed"
                            ? reply.length > 0
                              ? "Provider reply exceeded the native result size limit."
                              : "Provider completed without a final assistant reply."
                            : `Provider turn ${candidate.terminalState}.`,
                      } as const);
                yield* native.reportClaimedProviderResult(
                  candidate.identity,
                  candidate.attemptId,
                  result,
                );
                yield* requests.markCrewTerminalReported(candidate.identity, candidate.attemptId);
                reported += 1;
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.sync(() => {
                        pending += 1;
                      }).pipe(
                        Effect.andThen(
                          Effect.logWarning("native Crew terminal report remains pending", {
                            threadId: candidate.identity.threadId,
                            attemptId: candidate.attemptId,
                            cause: Cause.pretty(cause),
                          }),
                        ),
                      ),
                ),
              );
            }
            if (page.nextSequence === null) {
              terminalAfterSequence = 0;
              return { reported, deferred, pending, truncated: false };
            }
            afterSequence = page.nextSequence;
            terminalAfterSequence = afterSequence;
          }
          return { reported, deferred, pending, truncated: true };
        }),
      );
    },
  );

  return {
    prepare,
    recover,
    reissueClaimed,
    bindProviderSession,
    reserveContinuation,
    bindProviderTurn,
    recordProviderTerminal,
    readTerminalState: requests.readCrewTerminalState,
    reconcileTerminalOutbox,
    listRecoveryCandidates: requests.listCrewRecoveryCandidates,
    listPendingAdmissionCandidates: requests.listPendingCrewAdmissionCandidates,
    listUnresolvedStartedCandidates: requests.listUnresolvedStartedCrewCandidates,
    markAdmissionTerminal: requests.markCrewAdmissionTerminal,
    subscribeConnectionChanges: connections.subscribeChanges,
  };
});

export class CtoxCrewTurnAdmission extends Context.Service<
  CtoxCrewTurnAdmission,
  Effect.Success<typeof make>
>()("workjet/workjet/ctox/CtoxCrewTurnAdmission") {
  static readonly layer = Layer.effect(this, make);
}
