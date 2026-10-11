import { expect, it } from "@effect/vitest";
import { ThreadId, ProjectId, DEFAULT_WORKJET_THREAD_CONFIG, type OrchestrationCommand, type OrchestrationThreadShell, type ProviderRuntimeEvent } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { answerWorkerDecision, deliverWorkerDecisions, routeWorkerDecision } from "./WorkerSupervisorDecisions.ts";

const NOW = "2026-10-11T00:00:00.000Z";
const supervisorId = ThreadId.make("supervisor");
const workerId = ThreadId.make("worker");
const thread = (id: ThreadId, role: "supervisor" | "specialist" | "worker"): OrchestrationThreadShell => ({
  id, projectId: ProjectId.make("project"), deletedAt: null, archivedAt: null,
  runtimeMode: "full-access", interactionMode: "default", session: null,
  workjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, team: {
    role, threadId: id, projectId: ProjectId.make("project"), parentThreadId: role === "supervisor" ? null : supervisorId,
    goal: "Verify autonomous routing", createdAt: NOW,
  } },
} as OrchestrationThreadShell);
const supervisor = thread(supervisorId, "supervisor");
const worker = thread(workerId, "specialist");
const request = (id: string): ProviderRuntimeEvent => ({
  type: "user-input.requested", eventId: id, requestId: id, threadId: workerId, createdAt: NOW,
  payload: { questions: [{ id: "choice", header: "Choice", question: "Which authorised path?", multiSelect: false,
    options: [{ label: "Continue", description: "Use the approved plan." }] }] },
} as unknown as ProviderRuntimeEvent);
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES ('project','Autonomy',NULL,'[]',${NOW},${NOW})`;
  for (const t of [supervisor, worker]) yield* sql`INSERT INTO projection_threads
    (thread_id,project_id,title,model_selection_json,runtime_mode,workjet_config_json,created_at,updated_at)
    VALUES (${t.id},${t.projectId},${t.id},'{}',${t.runtimeMode},${JSON.stringify(t.workjetConfig)},${NOW},${NOW})`;
});
const query = { getThreadShellById: (id: ThreadId) => Effect.succeed(
  id === supervisorId ? Option.some(supervisor) : id === workerId ? Option.some(worker) : Option.none(),
) } as unknown as ProjectionSnapshotQuery["Service"];

it.effect("routes persistent and one-shot questions to Supervisor, defers busy delivery and resumes the original worker", () =>
  Effect.gen(function* () {
    yield* setup;
    const commands: OrchestrationCommand[] = [];
    const responses: unknown[] = [];
    const engine = { dispatch: (command: OrchestrationCommand) => Effect.sync(() => { commands.push(command); return { sequence: 1 }; }) } as unknown as OrchestrationEngineService["Service"];
    const providers = { respondToUserInput: (input: unknown) => Effect.sync(() => { responses.push(input); }) } as unknown as ProviderService["Service"];
    expect(yield* routeWorkerDecision(worker, request("question"))).toBe(true);
    expect(yield* routeWorkerDecision(worker, request("question"))).toBe(true);
    const busy = { getThreadShellById: () => Effect.succeed(Option.some({ ...supervisor, session: { status: "running" } } as OrchestrationThreadShell)) } as unknown as ProjectionSnapshotQuery["Service"];
    yield* deliverWorkerDecisions().pipe(Effect.provideService(ProjectionSnapshotQuery, busy), Effect.provideService(OrchestrationEngineService, engine));
    expect(commands).toHaveLength(0);
    yield* deliverWorkerDecisions().pipe(Effect.provideService(ProjectionSnapshotQuery, query), Effect.provideService(OrchestrationEngineService, engine));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type === "thread.turn.start" && commands[0].threadId).toBe(supervisorId);
    expect(commands[0]?.type === 'thread.turn.start' && commands[0].message.text).toContain('Which authorised path?');
    yield* deliverWorkerDecisions().pipe(Effect.provideService(ProjectionSnapshotQuery, query), Effect.provideService(OrchestrationEngineService, engine));
    expect(commands).toHaveLength(1);
    const answer = { decisionId: 'worker:question', answers: { choice: 'Continue' } };
    expect((yield* answerWorkerDecision(workerId, answer).pipe(Effect.provideService(ProjectionSnapshotQuery, query), Effect.provideService(ProviderService, providers), Effect.result))._tag).toBe('Failure');
    expect(responses).toHaveLength(0);
    yield* answerWorkerDecision(supervisorId, answer).pipe(Effect.provideService(ProjectionSnapshotQuery, query), Effect.provideService(ProviderService, providers));
    expect(responses).toEqual([{ threadId: workerId, requestId: 'question', answers: { choice: 'Continue' } }]);
    const sql = yield* SqlClient.SqlClient;
    expect((yield* sql`SELECT status FROM workjet_worker_supervisor_decisions`)[0]?.status).toBe('resolved');
    expect(yield* routeWorkerDecision(thread(workerId, 'worker'), request('one-shot'))).toBe(true);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("only actual client turns enable direct questions; imports and automatic continuations do not", () =>
  Effect.gen(function* () {
    yield* setup;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
      VALUES ('automatic','thread','worker',1,'thread.turn-start-requested',${NOW},'server','{}','{}')`;
    expect(yield* routeWorkerDecision(worker, request('automatic'))).toBe(true);
    yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
      VALUES ('personal','thread','worker',2,'thread.turn-start-requested',${NOW},'client','{}','{}')`;
    expect(yield* routeWorkerDecision(worker, request('personal'))).toBe(false);
    expect(yield* routeWorkerDecision(supervisor, request('supervisor'))).toBe(false);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("keeps unattended approval requests away from the user and supports Supervisor approval", () =>
  Effect.gen(function* () {
    yield* setup;
    const event = { ...request('approval'), type: 'request.opened', payload: { requestType: 'command_execution_approval', detail: 'Run the project check' } } as unknown as ProviderRuntimeEvent;
    expect(yield* routeWorkerDecision(worker, event)).toBe(true);
    let resumed = false;
    const providers = { respondToRequest: () => Effect.sync(() => { resumed = true; }) } as unknown as ProviderService["Service"];
    yield* answerWorkerDecision(supervisorId, { decisionId: 'worker:approval', decision: 'accept' }).pipe(
      Effect.provideService(ProjectionSnapshotQuery, query), Effect.provideService(ProviderService, providers));
    expect(resumed).toBe(true);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
