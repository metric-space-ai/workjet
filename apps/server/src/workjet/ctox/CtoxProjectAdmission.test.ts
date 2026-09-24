import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  WorkjetConnectionId,
  type WorkjetCtoxCrewOffers,
} from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration60 from "../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration61 from "../../persistence/Migrations/061_WorkjetCtoxNativeTurns.ts";
import migration62 from "../../persistence/Migrations/062_WorkjetCtoxCrewStarts.ts";
import migration63 from "../../persistence/Migrations/063_WorkjetCtoxCrewProviderBinding.ts";
import migration67 from "../../persistence/Migrations/067_WorkjetCtoxCrewRecoveryDispatch.ts";
import migration68 from "../../persistence/Migrations/068_WorkjetCtoxCrewTerminalOutbox.ts";
import migration69 from "../../persistence/Migrations/069_WorkjetCtoxCrewResumeCursor.ts";
import migration70 from "../../persistence/Migrations/070_WorkjetCtoxCrewAdmissionRedrive.ts";
import { CtoxNativeRequests } from "./CtoxNativeRequests.ts";
import { makeCtoxNativeTaskClient } from "./CtoxNativeTaskClient.ts";
import { CtoxMcpTransportError, type makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";

it.effect("keeps pending, review and resume separate and claims only one new native offer", () =>
  Effect.gen(function* () {
    yield* migration60;
    yield* migration61;
    yield* migration62;
    yield* migration63;
    yield* migration67;
    yield* migration68;
    yield* migration69;
    yield* migration70;
    const requests = yield* CtoxNativeRequests.pipe(Effect.provide(CtoxNativeRequests.layer));
    const sql = yield* SqlClient.SqlClient;
    const scope = {
      threadId: ThreadId.make("dev"),
      connectionId: WorkjetConnectionId.make("connection"),
      instanceId: "instance",
    };
    const task = {
      thread_id: "workjet_private_chat",
      title: "Work",
      instruction: "Work",
      harness: "codex" as const,
      timeout_seconds: 60,
    };
    const deadline = (yield* Clock.currentTimeMillis) + 60_000;
    let taskId: string | null = null;
    let status = "accepted";
    let offers: Array<(typeof WorkjetCtoxCrewOffers.Type)["offers"][number]> = [];
    let memberId = "crew";
    let attemptId = "attempt";
    let loseClaimResponse = false;
    let claims = 0;
    let reports = 0;
    const sentKeys: string[] = [];
    const transport: ReturnType<typeof makeCtoxMcpTransport> = {
      probe: () => Effect.succeed(undefined),
      callTool: (_, name, args) =>
        Effect.gen(function* () {
          if (name === "business_os.start_crew_execution") {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ idempotency_key: Schema.String }),
            )(args).pipe(Effect.orDie);
            sentKeys.push(input.idempotency_key);
            return {
              structuredContent: {
                schema: "ctox.project_crew_request.v1",
                command_id: "command",
                thread_id: task.thread_id,
                crew_member_id: "crew",
                executor_id: "computer",
                status: "accepted",
                task_id: null,
              },
            };
          }
          if (name === "business_os.get_command_status")
            return {
              structuredContent: {
                ok: true,
                record: {
                  id: "command",
                  collection: "business_commands",
                  status,
                  data: {
                    command_id: "command",
                    task_id: taskId,
                    module: "ctox",
                    command_type: "business_os.chat.task",
                    payload: { thread_id: task.thread_id },
                    status,
                  },
                },
              },
            };
          if (name === "business_os.list_crew_executions") {
            expect(args).toEqual({ command_id: "command", executor_id: "computer" });
            return {
              structuredContent: {
                schema: "ctox.external_crew_executions.v1",
                command_id: "command",
                executor_id: "computer",
                offers,
              },
            };
          }
          if (name === "business_os.report_crew_execution") {
            reports++;
            return {
              structuredContent: {
                accepted: true,
                attempt_id: attemptId,
                review_status: "pending",
              },
            };
          }
          expect(name).toBe("business_os.claim_crew_execution");
          expect(args).toEqual({
            command_id: "command",
            executor_id: "computer",
            attempt_id: attemptId,
          });
          claims++;
          if (loseClaimResponse)
            return yield* new CtoxMcpTransportError({ reason: "connection-unavailable" });
          return {
            structuredContent: {
              schema: "ctox.external_crew_offer.v1",
              command_id: "command",
              attempt_id: attemptId,
              executor_id: "computer",
              harness: "codex",
              deadline_ms: deadline,
              command_session: "signed",
              prompt: "Native work",
              instructions: "Native rules",
              crew_context: {
                schema: "ctox.crew_context.v1",
                command_id: "command",
                attempt_id: attemptId,
                task_id: "task",
                module_id: "ctox",
                member_id: memberId,
                member_name: "Crew",
                persona: "Persona",
                memory_block: null,
                execution_plan: null,
                context_version: "v1",
              },
            },
          };
        }),
    };
    const client = makeCtoxNativeTaskClient({
      requests,
      transport,
      connections: {
        resolveReadyTarget: () =>
          Effect.succeed({ endpoint: "https://ctox.example/mcp", token: "token" }),
      },
    });
    const prepare = () => client.prepareProjectExecution(scope, "persisted-event", task);
    expect((yield* prepare()).state).toBe("awaiting-native-task");
    taskId = "task";
    expect((yield* prepare()).state).toBe("awaiting-native-offer");
    const offered = {
      attempt_id: "attempt",
      harness: "codex" as const,
      deadline_ms: deadline,
      state: "offered" as const,
    };
    offers = [{ ...offered, state: "reported" }];
    expect((yield* prepare()).state).toBe("awaiting-native-review");
    offers = [{ ...offered, state: "claimed" }];
    expect((yield* prepare()).state).toBe("resume-required");
    offers = [offered, { ...offered, attempt_id: "second" }];
    expect(yield* Effect.flip(prepare())).toMatchObject({ reason: "native-response-invalid" });
    expect(claims).toBe(0);
    offers = [offered];
    const competing = yield* Effect.all([prepare(), prepare()], { concurrency: 2 });
    expect(competing.map((result) => result.state).sort()).toEqual(["ready", "resume-required"]);
    const admitted = competing.find((result) => result.state === "ready");
    if (!admitted) return yield* Effect.die("Expected one native admission");
    expect(admitted.state).toBe("ready");
    if (admitted.state !== "ready") return yield* Effect.die("Expected native admission");
    expect(admitted.claim.context.member_id).toBe("crew");
    expect(admitted.observed.reference.taskId).toBe("task");
    expect(claims).toBe(1);
    const submittedBeforeSecondTurn = sentKeys.length;
    expect(
      yield* Effect.flip(client.prepareProjectExecution(scope, "another-event", task)),
    ).toMatchObject({ reason: "native-task-reference-conflict" });
    expect(sentKeys).toHaveLength(submittedBeforeSecondTurn);
    const restoredRequests = yield* CtoxNativeRequests.pipe(
      Effect.provide(CtoxNativeRequests.layer),
    );
    const binding = yield* restoredRequests.readCrewStart(admitted.identity, attemptId);
    expect(binding).toEqual({
      attemptId,
      commandId: "command",
      taskId: "task",
      executorId: "computer",
      memberId: "crew",
      providerInstanceId: null,
      providerThreadId: null,
      codexResumeThreadId: null,
    });
    if (!binding) return yield* Effect.die("Expected persisted start binding");
    expect(
      yield* Effect.flip(client.reissueClaimedProjectOffer(admitted.identity, attemptId)),
    ).toMatchObject({ reason: "native-task-reference-conflict" });
    const providerInstanceId = ProviderInstanceId.make("codex_work");
    const providerThreadId = "provider-thread";
    const assigned = yield* restoredRequests.bindCrewStartProvider(
      admitted.identity,
      binding,
      providerInstanceId,
      providerThreadId,
      "original-codex-thread",
    );
    expect(assigned).toMatchObject({ providerInstanceId, providerThreadId });
    expect((yield* restoredRequests.listPendingCrewAdmissionCandidates()).candidates).toHaveLength(
      0,
    );
    expect(
      yield* restoredRequests.recordCrewProviderTerminal({
        threadId: scope.threadId,
        providerInstanceId,
        providerTurnId: "provider-turn",
        state: "completed",
      }),
    ).toMatchObject({ state: "buffered" });
    expect(
      yield* restoredRequests.reserveCrewRecoveryDispatch(
        admitted.identity,
        attemptId,
        providerInstanceId,
        providerThreadId,
      ),
    ).toMatchObject({ state: "reserved" });
    expect(
      yield* restoredRequests.reserveCrewRecoveryDispatch(
        admitted.identity,
        attemptId,
        providerInstanceId,
        providerThreadId,
      ),
    ).toMatchObject({ state: "existing" });
    yield* restoredRequests.bindCrewProviderTurn(
      admitted.identity,
      attemptId,
      providerInstanceId,
      providerThreadId,
      "provider-turn",
    );
    yield* restoredRequests.bindCrewProviderTurn(
      admitted.identity,
      attemptId,
      providerInstanceId,
      providerThreadId,
      "provider-turn",
    );
    expect(
      yield* Effect.flip(
        restoredRequests.bindCrewProviderTurn(
          admitted.identity,
          attemptId,
          providerInstanceId,
          providerThreadId,
          "another-provider-turn",
        ),
      ),
    ).toMatchObject({ reason: "native-task-reference-conflict" });
    expect(
      yield* restoredRequests.bindCrewStartProvider(
        admitted.identity,
        binding,
        providerInstanceId,
        providerThreadId,
        "original-codex-thread",
      ),
    ).toEqual(assigned);
    expect(
      yield* Effect.flip(
        restoredRequests.bindCrewStartProvider(
          admitted.identity,
          binding,
          ProviderInstanceId.make("claude_agent"),
          "other-provider-thread",
        ),
      ),
    ).toMatchObject({ reason: "native-task-reference-conflict" });
    expect(yield* restoredRequests.readCrewStart(admitted.identity, attemptId)).toEqual(assigned);
    expect(
      yield* Effect.flip(
        restoredRequests.reserveCrewStart(admitted.identity, { ...binding, memberId: "foreign" }),
      ),
    ).toMatchObject({ reason: "native-task-reference-conflict" });
    expect(
      yield* Effect.flip(
        restoredRequests.readCrewStart(
          { ...admitted.identity, connectionId: WorkjetConnectionId.make("foreign") },
          attemptId,
        ),
      ),
    ).toMatchObject({ reason: "native-request-conflict" });
    const restored = makeCtoxNativeTaskClient({
      requests: restoredRequests,
      transport,
      connections: {
        resolveReadyTarget: () =>
          Effect.succeed({ endpoint: "https://ctox.example/mcp", token: "token" }),
      },
    });
    const recoveryPage = yield* restoredRequests.listCrewRecoveryCandidates();
    expect(recoveryPage.candidates).toHaveLength(1);
    const recoveryCandidate = recoveryPage.candidates[0]!;
    expect(recoveryCandidate.requestId).toBe("persisted-event");
    expect((yield* restored.prepareRecoveredProjectExecution(recoveryCandidate)).state).toBe(
      "resume-required",
    );
    expect(
      yield* Effect.flip(
        restored.prepareRecoveredProjectExecution({
          ...recoveryCandidate,
          requestId: "forged-event",
        }),
      ),
    ).toMatchObject({ reason: "native-request-conflict" });
    expect((yield* restored.prepareProjectExecution(scope, "persisted-event", task)).state).toBe(
      "resume-required",
    );
    expect(claims).toBe(1);
    offers = [{ ...offered, state: "claimed" }];
    const reissued = yield* restored.reissueClaimedProjectOffer(admitted.identity, attemptId);
    expect(reissued.reservation).toEqual(assigned);
    expect(reissued.claim.attemptId).toBe(attemptId);
    expect(reissued.claim.context.member_id).toBe("crew");
    expect(claims).toBe(2);
    yield* TestClock.adjust(Duration.millis(2));
    offers = [{ ...offered, state: "claimed", deadline_ms: (yield* Clock.currentTimeMillis) - 1 }];
    expect(
      yield* Effect.flip(restored.reissueClaimedProjectOffer(admitted.identity, attemptId)),
    ).toMatchObject({ reason: "native-task-reference-conflict" });
    offers = [{ ...offered, state: "reported" }];
    expect(
      yield* Effect.flip(restored.reissueClaimedProjectOffer(admitted.identity, attemptId)),
    ).toMatchObject({ reason: "native-task-reference-conflict" });
    expect(claims).toBe(2);

    // A different native attempt may be offered after native review/retry.
    attemptId = "wrong-member";
    offers = [{ ...offered, attempt_id: attemptId }];
    memberId = "other-crew";
    expect(yield* Effect.flip(prepare())).toMatchObject({ reason: "native-response-invalid" });
    expect((yield* prepare()).state).toBe("resume-required");
    expect(claims).toBe(3);

    attemptId = "ambiguous-claim";
    offers = [{ ...offered, attempt_id: attemptId }];
    memberId = "crew";
    loseClaimResponse = true;
    expect(yield* Effect.flip(prepare())).toMatchObject({ reason: "connection-unavailable" });
    loseClaimResponse = false;
    expect((yield* restored.prepareProjectExecution(scope, "persisted-event", task)).state).toBe(
      "resume-required",
    );
    expect(claims).toBe(4);
    status = "completed";
    expect((yield* prepare()).state).toBe("native-terminal");
    expect(claims).toBe(4);
    expect(new Set(sentKeys).size).toBe(1);

    const secondAttempt = "second-provider";
    const secondReservation = yield* restoredRequests.reserveCrewStart(admitted.identity, {
      ...binding,
      attemptId: secondAttempt,
    });
    expect(secondReservation.state).toBe("reserved");
    const concurrentBindings = yield* Effect.all(
      [
        Effect.result(
          restoredRequests.bindCrewStartProvider(
            admitted.identity,
            secondReservation.binding,
            ProviderInstanceId.make("codex_a"),
            "provider-thread-a",
          ),
        ),
        Effect.result(
          restoredRequests.bindCrewStartProvider(
            admitted.identity,
            secondReservation.binding,
            ProviderInstanceId.make("codex_b"),
            "provider-thread-b",
          ),
        ),
      ],
      { concurrency: 2 },
    );
    expect(concurrentBindings.filter(Result.isSuccess)).toHaveLength(1);
    expect(concurrentBindings.filter(Result.isFailure)).toHaveLength(1);
    expect(
      yield* restoredRequests.recordCrewProviderTerminal({
        threadId: scope.threadId,
        providerInstanceId,
        providerTurnId: "provider-turn",
        state: "completed",
      }),
    ).toMatchObject({ state: "recorded", attemptId: "attempt" });
    expect((yield* restoredRequests.listCrewTerminalOutbox()).candidates).toMatchObject([
      { attemptId: "attempt", providerTurnId: "provider-turn", terminalState: "completed" },
    ]);
    expect(
      yield* Effect.flip(
        restoredRequests.recordCrewProviderTerminal({
          threadId: scope.threadId,
          providerInstanceId,
          providerTurnId: "provider-turn",
          state: "failed",
        }),
      ),
    ).toMatchObject({ reason: "native-task-reference-conflict" });
    yield* restoredRequests.markCrewTerminalReported(admitted.identity, "attempt");
    expect((yield* restoredRequests.listCrewTerminalOutbox()).candidates).toHaveLength(0);
    yield* sql`
      UPDATE workjet_ctox_crew_starts
      SET provider_instance_id = NULL
      WHERE thread_id = ${admitted.identity.threadId}
        AND request_key = ${admitted.identity.requestKey}
        AND attempt_id = ${secondAttempt}
    `;
    expect(
      yield* Effect.flip(restoredRequests.readCrewStart(admitted.identity, secondAttempt)),
    ).toMatchObject({ reason: "native-task-reference-conflict" });
    attemptId = "attempt";
    status = "accepted";
    offers = [{ ...offered, state: "claimed" }];
    expect(
      yield* restored.reportClaimedProviderResult(admitted.identity, attemptId, { reply: "done" }),
    ).toMatchObject({ state: "reported", receipt: { attempt_id: "attempt" } });
    expect(reports).toBe(1);
    offers = [{ ...offered, state: "reported" }];
    expect(
      yield* restored.reportClaimedProviderResult(admitted.identity, attemptId, { reply: "done" }),
    ).toMatchObject({ state: "already-reported" });
    expect(reports).toBe(1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
