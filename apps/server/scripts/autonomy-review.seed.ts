import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  ThreadId,
  ProjectId,
  EnvironmentId,
} from "@workjet/contracts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import {
  routeWorkerDecision,
  deliverWorkerDecisions,
} from "../src/workjet/WorkerSupervisorDecisions.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { ServerEnvironment } from "../src/environment/ServerEnvironment.ts";
import type {
  OrchestrationThreadShell,
  ProviderRuntimeEvent,
  OrchestrationCommand,
} from "@workjet/contracts";
const profile = process.env.AUTONOMY_UI_PROFILE;
if (!profile) throw new Error("AUTONOMY_UI_PROFILE must name an owned disposable profile");
const state = await Effect.runPromise(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const state = path.join(profile, "userdata");
    yield* fs.makeDirectory(state, { recursive: true });
    yield* fs.writeFileString(path.join(state, "environment-id"), "autonomy-review\n");
    return state;
  }).pipe(Effect.provide(NodeServices.layer)),
);
const environmentId = EnvironmentId.make("autonomy-review");

const now = DateTime.formatIso(await Effect.runPromise(DateTime.now));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const thread = (id: string, role: "supervisor" | "specialist") =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make("autonomy-review"),
    title: role === "supervisor" ? "Projekt-Supervisor" : "Persistent Worker",
    deletedAt: null,
    archivedAt: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      team: {
        role,
        projectId: ProjectId.make("autonomy-review"),
        threadId: ThreadId.make(id),
        parentThreadId: role === "supervisor" ? null : ThreadId.make("autonomy-supervisor"),
        goal: "Verify autonomous routing",
        createdAt: now,
      },
    },
  }) as unknown as OrchestrationThreadShell;
const supervisor = thread("autonomy-supervisor", "supervisor"),
  worker = thread("autonomy-worker", "specialist");
const shells = [supervisor, worker];
const program = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('autonomy-review','Autonomie-Prüfung',NULL,'[]',${now},${now})`;
  for (const shell of shells)
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,runtime_mode,workjet_config_json,created_at,updated_at) VALUES (${shell.id},${shell.projectId},${shell.title},'{"instanceId":"claudeAgent","model":"claude-opus-5-5"}','full-access',${encodeConfig(shell.workjetConfig)},${now},${now})`;
  yield* routeWorkerDecision(worker, {
    type: "user-input.requested",
    eventId: "review-question",
    requestId: "review-question",
    threadId: worker.id,
    createdAt: now,
    payload: {
      questions: [
        {
          id: "choice",
          header: "Entscheidung",
          question: "Welcher freigegebene Weg soll umgesetzt werden?",
          multiSelect: false,
          options: [
            {
              label: "Bestehende Lösung",
              description: "Aus dem Projektkontext selbst entscheiden.",
            },
            {
              label: "Kleine Korrektur",
              description: "Die belegte Korrektur im Worktree umsetzen.",
            },
          ],
        },
      ],
    },
  } as unknown as ProviderRuntimeEvent);
  const captured: OrchestrationCommand[] = [];
  yield* deliverWorkerDecisions().pipe(
    Effect.provideService(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          captured.push(command);
          return { sequence: 1 };
        }),
    } as unknown as OrchestrationEngineService["Service"]),
  );
  const delivery = captured.find((command) => command.type === "thread.turn.start");
  if (!delivery || delivery.type !== "thread.turn.start")
    throw new Error("Supervisor delivery absent");
  yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('supervisor-question',${supervisor.id},'user',${delivery.message.text},0,${now},${now})`;
  yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('worker-result',${worker.id},'assistant','Arbeitsstand gespeichert. Die Entscheidung liegt beim Projekt-Supervisor.',0,${now},${now})`;
  yield* sql`INSERT INTO projection_thread_activities(activity_id,thread_id,tone,kind,summary,payload_json,created_at) VALUES ('worker-wait',${worker.id},'info','user-input.requested','Worker wartet auf Supervisor','{"requestId":"review-question","recipient":"supervisor","questions":[]}',${now})`;
  yield* Effect.log("AUTONOMY_UI_SEED_PASS actual-route-and-delivery");
}).pipe(
  Effect.provideService(ProjectionSnapshotQuery, {
    getThreadShellById: (id: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(shells.find((shell) => shell.id === id))),
  } as unknown as ProjectionSnapshotQuery["Service"]),
  Effect.provideService(ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("unused"),
  }),
  Effect.provideService(ProviderService, {} as ProviderService["Service"]),
  Effect.provideService(OrchestrationEngineService, {
    dispatch: () => Effect.die("unexpected fixture dispatch"),
  } as unknown as OrchestrationEngineService["Service"]),
  Effect.provide(
    Layer.mergeAll(
      NodeSqliteClient.layer({ filename: state + "/state.sqlite" }),
      NodeServices.layer,
    ),
  ),
);
await Effect.runPromise(program);
