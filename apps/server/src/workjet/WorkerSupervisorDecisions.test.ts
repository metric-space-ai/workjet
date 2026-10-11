import * as DateTime from "effect/DateTime";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { remoteWorkerCommandId } from "./RemoteWorkerReceiver.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import { expect, it } from "@effect/vitest";
import {
  ThreadId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { EnvironmentId } from "@workjet/contracts";
import {
  WorkerSupervisorAnswer,
  recordWorkerOwnerActivity,
  recoverWorkerDecisionAnswers,
  retryRetainedWorkerAnswers,
  routeWorkerTerminalQuestion,
  ONE_SHOT_SELF_DECISION,
  WORKER_SUPERVISOR_TIMEOUT_MS,
  answerWorkerDecision,
  deliverWorkerDecisions,
  routeWorkerDecision,
  resumeWorkerDecisionsFromSupervisor,
} from "./WorkerSupervisorDecisions.ts";

const defaultProviders = {
  respondToUserInput: () => Effect.void,
  respondToRequest: () => Effect.void,
} as unknown as ProviderService["Service"];
const defaultEngine = {
  dispatch: () => Effect.succeed({ sequence: 1 }),
} as unknown as OrchestrationEngineService["Service"];
const NOW = "2026-10-11T00:00:00.000Z";
const supervisorId = ThreadId.make("supervisor");
const workerId = ThreadId.make("worker");
const thread = (
  id: ThreadId,
  role: "supervisor" | "specialist" | "worker",
): OrchestrationThreadShell =>
  ({
    id,
    projectId: ProjectId.make("project"),
    deletedAt: null,
    archivedAt: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      team: {
        role,
        threadId: id,
        projectId: ProjectId.make("project"),
        parentThreadId: role === "supervisor" ? null : supervisorId,
        goal: "Verify autonomous routing",
        createdAt: NOW,
      },
    },
  }) as unknown as OrchestrationThreadShell;
const supervisor = thread(supervisorId, "supervisor");
const worker = thread(workerId, "specialist");
const request = (id: string): ProviderRuntimeEvent =>
  ({
    type: "user-input.requested",
    eventId: id,
    requestId: id,
    threadId: workerId,
    createdAt: NOW,
    payload: {
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Which authorised path?",
          multiSelect: false,
          options: [{ label: "Continue", description: "Use the approved plan." }],
        },
      ],
    },
  }) as unknown as ProviderRuntimeEvent;
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES ('project','Autonomy',NULL,'[]',${NOW},${NOW})`;
  for (const t of [supervisor, worker])
    yield* sql`INSERT INTO projection_threads
    (thread_id,project_id,title,model_selection_json,runtime_mode,workjet_config_json,created_at,updated_at)
    VALUES (${t.id},${t.projectId},${t.id},'{}',${t.runtimeMode},${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(t.workjetConfig)},${NOW},${NOW})`;
});
const query = {
  getThreadShellById: (id: ThreadId) =>
    Effect.succeed(
      id === supervisorId
        ? Option.some(supervisor)
        : id === workerId
          ? Option.some(worker)
          : Option.none(),
    ),
} as unknown as ProjectionSnapshotQuery["Service"];

it.effect(
  "resumes from a completed native Supervisor reply and ignores worker text and partial replies",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* routeWorkerDecision(worker, request("native"));
      yield* sql`UPDATE workjet_worker_supervisor_decisions SET notified = 1`;
      const answer = yield* Schema.encodeEffect(Schema.fromJsonString(WorkerSupervisorAnswer))({
        decisionId: "worker:native",
        answers: { choice: "Continue" },
      });
      const text = "<workjet_worker_decision>" + answer + "</workjet_worker_decision>";
      const responses: unknown[] = [];
      const providers = {
        respondToUserInput: (input: unknown) =>
          Effect.sync(() => {
            responses.push(input);
          }),
      } as unknown as ProviderService["Service"];
      const resume = resumeWorkerDecisionsFromSupervisor().pipe(
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(ProviderService, providers),
      );
      yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('worker-answer','worker','assistant',${text},0,${NOW},${NOW})`;
      yield* resume;
      expect(responses).toHaveLength(0);
      yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('supervisor-answer','supervisor','assistant',${text},1,${NOW},${NOW})`;
      yield* resume;
      expect(responses).toHaveLength(0);
      yield* sql`UPDATE projection_thread_messages SET is_streaming=0 WHERE message_id='supervisor-answer'`;
      yield* resume;
      yield* resume;
      expect(responses).toEqual([
        { threadId: workerId, requestId: "native", answers: { choice: "Continue" } },
      ]);
    }).pipe(
      Effect.provideService(ProviderService, defaultProviders),
      Effect.provideService(OrchestrationEngineService, defaultEngine),
      Effect.provide(NodeSqliteClient.layerMemory()),
    ),
);

it.effect(
  "routes persistent questions to Supervisor, defers busy delivery and resumes the original worker",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const commands: OrchestrationCommand[] = [];
      const responses: unknown[] = [];
      const engine = {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: 1 };
          }),
      } as unknown as OrchestrationEngineService["Service"];
      const providers = {
        respondToUserInput: (input: unknown) =>
          Effect.sync(() => {
            responses.push(input);
          }),
      } as unknown as ProviderService["Service"];
      expect(yield* routeWorkerDecision(worker, request("question"))).toBe(true);
      expect(yield* routeWorkerDecision(worker, request("question"))).toBe(true);
      const busy = {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              ...supervisor,
              session: { status: "running" },
            } as OrchestrationThreadShell),
          ),
      } as unknown as ProjectionSnapshotQuery["Service"];
      yield* deliverWorkerDecisions().pipe(
        Effect.provideService(ProjectionSnapshotQuery, busy),
        Effect.provideService(OrchestrationEngineService, engine),
      );
      expect(commands).toHaveLength(0);
      yield* deliverWorkerDecisions().pipe(
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(OrchestrationEngineService, engine),
      );
      expect(commands).toHaveLength(1);
      expect(commands[0]?.type === "thread.turn.start" && commands[0].threadId).toBe(supervisorId);
      expect(commands[0]?.type === "thread.turn.start" && commands[0].message.text).toContain(
        "Which authorised path?",
      );
      yield* deliverWorkerDecisions().pipe(
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(OrchestrationEngineService, engine),
      );
      expect(commands).toHaveLength(1);
      const answer = { decisionId: "worker:question", answers: { choice: "Continue" } };
      expect(
        (yield* answerWorkerDecision(workerId, answer).pipe(
          Effect.provideService(ProjectionSnapshotQuery, query),
          Effect.provideService(ProviderService, providers),
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(responses).toHaveLength(0);
      yield* answerWorkerDecision(supervisorId, answer).pipe(
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(ProviderService, providers),
      );
      expect(responses).toEqual([
        { threadId: workerId, requestId: "question", answers: { choice: "Continue" } },
      ]);
      const sql = yield* SqlClient.SqlClient;
      expect((yield* sql`SELECT status FROM workjet_worker_supervisor_decisions`)[0]?.status).toBe(
        "resolved",
      );
      expect(
        yield* routeWorkerDecision(thread(workerId, "worker"), request("one-shot")).pipe(
          Effect.provideService(ProviderService, providers),
        ),
      ).toBe(true);
      expect(responses.at(-1)).toEqual({
        threadId: workerId,
        requestId: "one-shot",
        answers: { choice: ONE_SHOT_SELF_DECISION },
      });
    }).pipe(
      Effect.provideService(ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("isolated")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provideService(ProviderService, defaultProviders),
      Effect.provideService(OrchestrationEngineService, defaultEngine),
      Effect.provide(NodeSqliteClient.layerMemory()),
    ),
);

it.effect(
  "only actual client turns enable direct questions; imports and automatic continuations do not",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* OrchestrationEventStore.pipe(
        Effect.provide(OrchestrationEventStoreLive),
      );
      // Actual WorkerDispatch UUID shape and the RemoteWorkerReceiver constructor.
      for (const commandId of [
        CommandId.make("6402e2fd-3357-46b4-ad5e-bdb9b44a5e69"),
        remoteWorkerCommandId("remote-initial", "turn"),
      ]) {
        yield* store.append({
          type: "thread.turn-start-requested",
          eventId: EventId.make(String(commandId)),
          aggregateKind: "thread",
          aggregateId: workerId,
          occurredAt: NOW,
          commandId,
          correlationId: commandId,
          causationEventId: null,
          metadata: {},
          payload: {
            threadId: workerId,
            messageId: MessageId.make(String(commandId)),
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: NOW,
          },
        });
        expect(
          (yield* sql`SELECT actor_kind FROM orchestration_events WHERE command_id=${commandId}`)[0]
            ?.actor_kind,
        ).toBe("client");
        expect(yield* routeWorkerDecision(worker, request(String(commandId)))).toBe(true);
      }
      const personal: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
        type: "thread.turn.start",
        commandId: CommandId.make("client-ui-message"),
        threadId: workerId,
        message: {
          messageId: MessageId.make("ui-message"),
          role: "user",
          text: "Continue with my decision.",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: NOW,
      };
      yield* recordWorkerOwnerActivity(personal);
      expect(yield* routeWorkerDecision(worker, request("personal"))).toBe(false);
      expect(yield* routeWorkerDecision(supervisor, request("supervisor"))).toBe(false);
    }).pipe(
      Effect.provideService(ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("isolated")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provideService(ProviderService, defaultProviders),
      Effect.provideService(OrchestrationEngineService, defaultEngine),
      Effect.provide(NodeSqliteClient.layerMemory()),
    ),
);

it.effect(
  "keeps unattended approval requests away from the user and supports Supervisor approval",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const event = {
        ...request("approval"),
        type: "request.opened",
        payload: { requestType: "command_execution_approval", detail: "Run the project check" },
      } as unknown as ProviderRuntimeEvent;
      expect(yield* routeWorkerDecision(worker, event)).toBe(true);
      let resumed = false;
      const providers = {
        respondToRequest: () =>
          Effect.sync(() => {
            resumed = true;
          }),
      } as unknown as ProviderService["Service"];
      yield* answerWorkerDecision(supervisorId, {
        decisionId: "worker:approval",
        decision: "accept",
      }).pipe(
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(ProviderService, providers),
      );
      expect(resumed).toBe(true);
    }).pipe(
      Effect.provideService(ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("isolated")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provideService(ProviderService, defaultProviders),
      Effect.provideService(OrchestrationEngineService, defaultEngine),
      Effect.provide(NodeSqliteClient.layerMemory()),
    ),
);

it.effect(
  "recovers an answering decision at startup and retries its retained reply exactly once",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* routeWorkerDecision(worker, request("recover"));
      const answer = { decisionId: "worker:recover", answers: { choice: "Continue" } };
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(WorkerSupervisorAnswer))(
        answer,
      );
      yield* sql`UPDATE workjet_worker_supervisor_decisions SET status='answering',answer_json=${encoded}`;
      yield* recoverWorkerDecisionAnswers();
      const replies: unknown[] = [];
      yield* retryRetainedWorkerAnswers().pipe(
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(ProviderService, {
          respondToUserInput: (input: unknown) =>
            Effect.sync(() => {
              replies.push(input);
            }),
        } as unknown as ProviderService["Service"]),
      );
      yield* recoverWorkerDecisionAnswers();
      expect(replies).toHaveLength(1);
      expect((yield* sql`SELECT status FROM workjet_worker_supervisor_decisions`)[0]?.status).toBe(
        "resolved",
      );
    }).pipe(
      Effect.provideService(ProviderService, defaultProviders),
      Effect.provideService(OrchestrationEngineService, defaultEngine),
      Effect.provide(NodeSqliteClient.layerMemory()),
    ),
);

it.effect(
  "a project without Supervisor has a visible missing binding and expires after five minutes",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_threads WHERE thread_id='supervisor'`;
      const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* routeWorkerDecision(worker, { ...request("unbound"), createdAt: now });
      const commands: OrchestrationCommand[] = [];
      const delivery = deliverWorkerDecisions().pipe(
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: 1 };
            }),
        } as unknown as OrchestrationEngineService["Service"]),
      );
      yield* delivery;
      expect(
        (yield* sql`SELECT supervisor_thread_id,status FROM workjet_worker_supervisor_decisions`)[0],
      ).toMatchObject({ supervisor_thread_id: null, status: "pending" });
      yield* TestClock.adjust(WORKER_SUPERVISOR_TIMEOUT_MS + 1);
      yield* delivery;
      expect(
        (yield* sql`SELECT status,failure FROM workjet_worker_supervisor_decisions`)[0],
      ).toMatchObject({
        status: "timed-out",
        failure: "Projekt ohne Supervisor: Wartezeit abgelaufen",
      });
      expect(commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(0);
    }).pipe(
      Effect.provideService(ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("isolated")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provideService(ProviderService, defaultProviders),
      Effect.provideService(OrchestrationEngineService, defaultEngine),
      Effect.provide(NodeSqliteClient.layerMemory()),
    ),
);

for (const harness of [
  "claudeAgent",
  "codex",
  "opencode",
  "grok",
  "pi",
  "cursor",
  "minimax",
  "greppy",
  "ctox",
] as const) {
  it.effect(
    `routes ${harness} normalised question, elicitation and approval through the same role fallback`,
    () =>
      Effect.gen(function* () {
        yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const replies: unknown[] = [];
        const providers = {
          respondToUserInput: (input: unknown) =>
            Effect.sync(() => {
              replies.push(input);
            }),
          respondToRequest: (input: unknown) =>
            Effect.sync(() => {
              replies.push(input);
            }),
        } as unknown as ProviderService["Service"];
        for (const kind of ["question", "elicitation", "approval"] as const) {
          const id = harness + "-" + kind;
          const event =
            kind === "question"
              ? request(id)
              : ({
                  ...request(id),
                  type: "request.opened",
                  payload: {
                    requestType:
                      kind === "approval" ? "command_execution_approval" : "mcp_elicitation",
                    detail: "Choose an authorised action",
                  },
                } as unknown as ProviderRuntimeEvent);
          expect(yield* routeWorkerDecision(worker, event)).toBe(true);
          yield* sql`INSERT INTO workjet_worker_owner_engagement VALUES ('worker','ui-real','ui-message',${NOW}) ON CONFLICT DO NOTHING`;
          expect(
            yield* routeWorkerDecision(thread(workerId, "worker"), event).pipe(
              Effect.provideService(ProviderService, providers),
            ),
          ).toBe(true);
          yield* sql`DELETE FROM workjet_worker_owner_engagement`;
        }
        expect(replies).toHaveLength(3);
        expect(
          (yield* sql`SELECT count(*) AS n FROM workjet_worker_supervisor_decisions`)[0]?.n,
        ).toBe(3);
        expect(
          yield* routeWorkerTerminalQuestion(
            worker,
            "Which implementation should I use?",
            harness + "-plain",
          ),
        ).toBe(true);
        expect(
          (yield* sql`SELECT request_json FROM workjet_worker_supervisor_decisions WHERE request_id=${"text:" + harness + "-plain"}`)[0]
            ?.request_json,
        ).toContain('"transport":"text"');
      }).pipe(
        Effect.provideService(ProviderService, defaultProviders),
        Effect.provideService(OrchestrationEngineService, defaultEngine),
        Effect.provideService(ProjectionSnapshotQuery, query),
        Effect.provide(NodeSqliteClient.layerMemory()),
      ),
  );
}

it.effect("an unsupported One-Shot question callback ends the run with an open-point report", () =>
  Effect.gen(function* () {
    yield* setup;
    let stopped = 0;
    const commands: OrchestrationCommand[] = [];
    const providers = {respondToUserInput:() => Effect.fail(new Error("Native callback unavailable")),stopSession:() => Effect.sync(() => {stopped++})} as unknown as ProviderService["Service"];
    yield* routeWorkerDecision(thread(workerId,"worker"),request("unsupported")).pipe(
      Effect.provideService(ProviderService,providers),
      Effect.provideService(OrchestrationEngineService,{dispatch:(command:OrchestrationCommand)=>Effect.sync(()=>{commands.push(command);return {sequence:1}})} as unknown as OrchestrationEngineService["Service"]));
    expect(stopped).toBe(1);
    expect(commands.some(command=>command.type==="thread.activity.append" && command.activity.kind==="worker.result")).toBe(true);
    expect((yield* (yield* SqlClient.SqlClient)`SELECT count(*) AS n FROM workjet_worker_supervisor_decisions`)[0]?.n).toBe(0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()))
);
it.effect("a repeated terminal One-Shot question finishes instead of asking or looping", () =>
  Effect.gen(function* () {
    yield* setup;
    let stopped = 0;
    const oneShot=thread(workerId,"worker");
    expect(yield* routeWorkerTerminalQuestion(oneShot,"Proceed?","first").pipe(Effect.provideService(ProviderService,{stopSession:()=>Effect.sync(()=>{stopped++})} as unknown as ProviderService["Service"]))).toBe(true);
    expect(yield* routeWorkerTerminalQuestion(oneShot,"Weiter?","second").pipe(Effect.provideService(ProviderService,{stopSession:()=>Effect.sync(()=>{stopped++})} as unknown as ProviderService["Service"]))).toBe(true);
    expect(stopped).toBe(1);
  }).pipe(Effect.provideService(OrchestrationEngineService,defaultEngine),Effect.provideService(ProjectionSnapshotQuery,query),Effect.provide(NodeSqliteClient.layerMemory()))
);
