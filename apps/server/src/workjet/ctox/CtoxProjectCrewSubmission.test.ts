import { expect, it } from "@effect/vitest";
import { ThreadId, WorkjetConnectionId, WorkjetCtoxCrewRequest } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration60 from "../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration61 from "../../persistence/Migrations/061_WorkjetCtoxNativeTurns.ts";
import { CtoxNativeRequests } from "./CtoxNativeRequests.ts";
import { CtoxMcpTransportError, type makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import { makeCtoxNativeTaskClient } from "./CtoxNativeTaskClient.ts";

it.effect("recovers project submission after a lost receipt and rejects another private chat", () =>
  Effect.gen(function* () {
    yield* migration60;
    yield* migration61;
    const scope = {
      threadId: ThreadId.make("dev-thread"),
      connectionId: WorkjetConnectionId.make("connection"),
      instanceId: "instance",
    };
    const task = {
      thread_id: "workjet_private_chat",
      title: "Implement",
      instruction: "Implement the task",
      harness: "codex" as const,
      timeout_seconds: 60,
    };
    const sent: string[] = [];
    let lose = true;
    let wrongChat = false;
    let offerIdentity = { command: "command", executor: "computer", harness: "codex" };
    let contextReads = 0;
    let contextMember = "crew";
    let planCommand = "command";
    let planWrites = 0;
    let reports = 0;
    let expectedCandidate: { reply: string } | { error: string } = { reply: "Candidate" };
    let receiptAttempt = "attempt";
    const transport: ReturnType<typeof makeCtoxMcpTransport> = {
      probe: (destination, names, fields) =>
        Effect.sync(() => {
          if (
            names[0] === "business_os.report_crew_execution" ||
            names[0] === "business_os.get_crew_context" ||
            names[0] === "business_os.update_crew_plan"
          ) {
            expect(destination).toEqual({
              endpoint: "https://ctox.example/mcp",
              token: "signed-session",
            });
            return undefined;
          }
          if (names[0] === "business_os.claim_crew_execution") return undefined;
          if (names[0] === "business_os.list_crew_executions") {
            expect(names).toEqual(["business_os.list_crew_executions"]);
            return undefined;
          }
          expect(names).toEqual(["business_os.start_crew_execution"]);
          expect(fields).toEqual({ "business_os.start_crew_execution": ["idempotency_key"] });
          return undefined;
        }),
      callTool: (destination, name, args) =>
        Effect.gen(function* () {
          if (name === "business_os.update_crew_plan") {
            planWrites++;
            expect(destination).toEqual({
              endpoint: "https://ctox.example/mcp",
              token: "signed-session",
            });
            expect(args).toEqual({ steps: [{ label: "Work", status: "completed" }] });
            return {
              structuredContent: {
                version: 1,
                revision: 1,
                command_id: planCommand,
                task_id: "task",
                percent: 90,
                phase: "review",
                review: { status: "pending" },
              },
            };
          }
          if (name === "business_os.get_crew_context") {
            contextReads++;
            expect(destination).toEqual({
              endpoint: "https://ctox.example/mcp",
              token: "signed-session",
            });
            expect(args).toEqual({ attempt_id: "attempt" });
            return {
              structuredContent: {
                schema: "ctox.crew_context.v1",
                command_id: "command",
                attempt_id: "attempt",
                task_id: "task",
                module_id: "ctox",
                member_id: contextMember,
                member_name: "Crew",
                persona: "Native persona",
                memory_block: "Updated knowledge",
                execution_plan: { steps: [] },
                context_version: "v2",
              },
            };
          }
          if (name === "business_os.report_crew_execution") {
            reports++;
            expect(destination).toEqual({
              endpoint: "https://ctox.example/mcp",
              token: "signed-session",
            });
            expect(args).toEqual(expectedCandidate);
            return {
              structuredContent: {
                accepted: true,
                attempt_id: receiptAttempt,
                review_status: "pending",
              },
            };
          }
          if (name === "business_os.claim_crew_execution") {
            expect(args).toEqual({
              command_id: "command",
              executor_id: "computer",
              attempt_id: "attempt",
            });
            return {
              structuredContent: {
                schema: "ctox.external_crew_offer.v1",
                command_id: "command",
                executor_id: "computer",
                attempt_id: "attempt",
                harness: "codex",
                deadline_ms: 1_000_000_000_000_000,
                command_session: "signed-session",
                prompt: "Task",
                instructions: "Report candidate",
                crew_context: {
                  schema: "ctox.crew_context.v1",
                  command_id: "command",
                  attempt_id: "attempt",
                  task_id: "task",
                  module_id: "ctox",
                  member_id: "crew",
                  member_name: "Crew",
                  persona: "Persona",
                  memory_block: null,
                  execution_plan: null,
                  context_version: "v1",
                },
              },
            };
          }
          if (name === "business_os.list_crew_executions") {
            expect(args).toEqual({ command_id: "command", executor_id: "computer" });
            return {
              structuredContent: {
                schema: "ctox.external_crew_executions.v1",
                command_id: offerIdentity.command,
                executor_id: offerIdentity.executor,
                offers: [
                  {
                    attempt_id: "attempt",
                    harness: offerIdentity.harness,
                    deadline_ms: 10_000,
                    state: "offered",
                  },
                ],
              },
            };
          }
          expect(name).toBe("business_os.start_crew_execution");
          const request = yield* Schema.decodeUnknownEffect(WorkjetCtoxCrewRequest)({
            ...args,
            operation: "start_crew_execution",
          }).pipe(Effect.orDie);
          expect(args).not.toHaveProperty("module_id");
          expect(args).not.toHaveProperty("crew_member_id");
          expect(args).not.toHaveProperty("executor_id");
          sent.push(request.idempotency_key);
          if (lose) {
            lose = false;
            return yield* new CtoxMcpTransportError({ reason: "connection-unavailable" });
          }
          return {
            structuredContent: {
              schema: "ctox.project_crew_request.v1",
              command_id: "command",
              task_id: "task",
              thread_id: wrongChat ? "workjet_private_other" : request.thread_id,
              crew_member_id: "crew",
              executor_id: "computer",
              status: "accepted",
            },
          };
        }),
    };
    let target = { endpoint: "https://ctox.example/mcp", token: "fixture" };
    const connections = { resolveReadyTarget: () => Effect.succeed(target) };
    const open = CtoxNativeRequests.pipe(Effect.provide(CtoxNativeRequests.layer));
    const first = makeCtoxNativeTaskClient({ requests: yield* open, connections, transport });
    expect(yield* Effect.flip(first.submitProjectTurn(scope, "event-1", task))).toMatchObject({
      reason: "connection-unavailable",
    });
    expect(sent).toHaveLength(1);
    const pending = yield* first.latestNativeTurn(scope);
    expect(pending?.reference.commandId).toBeNull();
    const restarted = makeCtoxNativeTaskClient({ requests: yield* open, connections, transport });
    const result = yield* restarted.submitProjectTurn(scope, "event-1", task);
    expect(sent[1]).toBe(sent[0]);
    expect(result.reference).toMatchObject({
      commandId: "command",
      taskId: "task",
      request: { thread_id: task.thread_id },
    });
    expect(
      yield* Effect.flip(
        restarted.submitProjectTurn(scope, "event-1", { ...task, instruction: "Changed" }),
      ),
    ).toMatchObject({ reason: "native-request-conflict" });
    expect(sent).toHaveLength(2);
    const identity = { ...scope, requestKey: result.reference.request.idempotency_key };
    for (const changed of [
      { endpoint: target.endpoint, token: "another-principal" },
      { endpoint: "https://other.example/mcp", token: "fixture" },
    ]) {
      target = changed;
      expect(yield* Effect.flip(restarted.readStatus(identity))).toMatchObject({
        reason: "native-request-credentials-changed",
      });
      expect(sent).toHaveLength(2);
    }
    target = { endpoint: "https://ctox.example/mcp", token: "fixture" };
    const discovered = yield* restarted.discoverProjectOffers(identity, "computer");
    expect(discovered).toMatchObject({ state: "observed", offers: [{ attempt_id: "attempt" }] });
    for (const invalid of [
      { command: "other-command", executor: "computer", harness: "codex" },
      { command: "command", executor: "other-computer", harness: "codex" },
      { command: "command", executor: "computer", harness: "claude" },
    ]) {
      offerIdentity = invalid;
      expect(
        yield* Effect.flip(restarted.discoverProjectOffers(identity, "computer")),
      ).toMatchObject({
        reason: "native-response-invalid",
      });
    }
    const claimed = yield* restarted.claimProjectOffer(identity, "computer", "attempt");
    expect(JSON.stringify(claimed)).not.toContain("signed-session");
    const plan = { steps: [{ label: "Work", status: "completed" as const }] };
    expect(yield* claimed.updatePlan(plan)).toMatchObject({
      percent: 90,
      review: { status: "pending" },
    });
    planCommand = "other";
    expect(yield* Effect.flip(claimed.updatePlan(plan))).toMatchObject({
      reason: "native-response-invalid",
    });
    expect(planWrites).toBe(2);
    expect(yield* claimed.refreshContext()).toMatchObject({
      member_id: "crew",
      memory_block: "Updated knowledge",
      context_version: "v2",
    });
    contextMember = "foreign-crew";
    expect(yield* Effect.flip(claimed.refreshContext())).toMatchObject({
      reason: "native-response-invalid",
    });
    expect(contextReads).toBe(2);

    expect(yield* claimed.report({ reply: "Candidate" })).toEqual({
      accepted: true,
      attempt_id: "attempt",
      review_status: "pending",
    });
    receiptAttempt = "foreign-attempt";
    expect(yield* Effect.flip(claimed.report({ reply: "Candidate" }))).toMatchObject({
      reason: "native-response-invalid",
    });
    expect(reports).toBe(2);
    for (const candidate of [{ reply: " " }, { error: "" }, { reply: "😀".repeat(65_536) }]) {
      expect(yield* Effect.flip(claimed.report(candidate))).toMatchObject({
        reason: "native-request-conflict",
      });
    }
    expect(reports).toBe(2);
    target = { ...target, token: "rotated" };
    expect(yield* Effect.flip(claimed.refreshContext())).toMatchObject({
      reason: "native-request-credentials-changed",
    });
    expect(contextReads).toBe(2);
    expect(yield* Effect.flip(claimed.report({ reply: "Candidate" }))).toMatchObject({
      reason: "native-request-credentials-changed",
    });
    expect(reports).toBe(2);
    target = { endpoint: "https://ctox.example/mcp", token: "fixture" };
    expectedCandidate = { error: "Harness failed" };
    receiptAttempt = "attempt";
    expect(yield* claimed.report(expectedCandidate)).toMatchObject({ review_status: "pending" });
    expect(reports).toBe(3);
    wrongChat = true;
    expect(yield* Effect.flip(restarted.submitProjectTurn(scope, "event-2", task))).toMatchObject({
      reason: "native-response-invalid",
    });
    expect((yield* restarted.latestNativeTurn(scope))?.reference.commandId).toBeNull();
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
