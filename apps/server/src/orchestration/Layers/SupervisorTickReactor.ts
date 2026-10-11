import { CommandId, supervisorTickDueAt, supervisorFirstTickAt } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import { GitHubCli } from "../../sourceControl/GitHubCli.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { supervisorTickPrompt } from "../../workjet/supervisorTickPrompt.ts";
import { isSupervisorTickEligible } from "../../workjet/supervisorTickEligibility.ts";
import {
  SupervisorPullRequests,
  supervisorTickSituation,
  minutesUntilRegularMeeting,
} from "../../workjet/supervisorTickSituation.ts";

export class SupervisorTickReactor extends Context.Service<
  SupervisorTickReactor,
  {
    readonly start: () => Effect.Effect<void, never, import("effect/Scope").Scope>;
  }
>()("workjet/orchestration/Layers/SupervisorTickReactor") {}

const decodePullRequests = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SupervisorPullRequests),
);

export const makeSupervisorTickReactor = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;
  const github = yield* GitHubCli;
  const registry = yield* SourceControlProviderRegistry;

  const reconcile = Effect.fn("SupervisorTickReactor.reconcile")(function* () {
    const model = yield* query.getCommandReadModel();
    for (const supervisor of model.threads) {
      const config = supervisor.workjetConfig;
      const project = model.projects.find((p) => p.id === supervisor.projectId);
      if (config.schemaVersion !== 2 || !project || !isSupervisorTickEligible(supervisor, project))
        continue;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (!config.supervisorTick) {
        const firstTickAt = supervisorFirstTickAt(now, project.overview?.supervisorTick);
        if (firstTickAt !== null) {
          yield* engine
            .dispatch({
              type: "thread.supervisor.tick.schedule",
              commandId: CommandId.make(
                `server:supervisor-tick:${supervisor.id}:initial:${firstTickAt}`,
              ),
              threadId: supervisor.id,
              firstTickAt: DateTime.formatIso(DateTime.makeUnsafe(firstTickAt)),
              createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            })
            .pipe(
              Effect.catch((error) =>
                error._tag === "OrchestrationCommandInvariantError" &&
                error.detail === "Command produced no events."
                  ? Effect.void
                  : Effect.logWarning("Supervisor initial control scheduling failed", {
                      threadId: supervisor.id,
                      error,
                    }),
              ),
            );
        }
        continue;
      }
      const dueAt = supervisorTickDueAt(
        supervisor.createdAt,
        project.overview?.supervisorTick,
        config.supervisorTick,
      );
      if (dueAt === null || dueAt > now) continue;
      const since = config.supervisorTick?.lastControlAt ?? supervisor.createdAt;
      const sourceErrors: string[] = [];
      const read = <A, E>(source: string, effect: Effect.Effect<readonly A[], E>) =>
        effect.pipe(
          Effect.timeout("15 seconds"),
          Effect.catch(() => {
            sourceErrors.push(source + " unavailable or timed out");
            return Effect.succeed([] as readonly A[]);
          }),
        );
      const errors = yield* read(
        "Error history",
        sql<{
          threadId: string;
          kind: string;
          summary: string;
          createdAt: string;
        }>`
        SELECT a.thread_id AS "threadId", a.kind, a.summary, a.created_at AS "createdAt"
        FROM projection_thread_activities a JOIN projection_threads t ON t.thread_id = a.thread_id
        WHERE t.project_id = ${project.id} AND a.created_at > ${since}
          AND (a.tone = 'error' OR a.kind LIKE '%timeout%')
        ORDER BY a.created_at DESC LIMIT 50
      `,
      );
      const escalations = yield* read(
        "Escalations",
        sql<{
          threadId: string;
          decisionKey: string;
          createdAtMs: number;
        }>`
        SELECT e.thread_id AS "threadId", e.decision_key AS "decisionKey", e.created_at_ms AS "createdAtMs"
        FROM workjet_decision_hub_escalations e JOIN projection_threads t ON t.thread_id = e.thread_id
        WHERE t.project_id = ${project.id} AND e.status = 'open' LIMIT 50
      `,
      );
      const changes = yield* read(
        "Goal and kanban changes",
        sql<{
          threadId: string;
          occurredAt: string;
        }>`
        SELECT stream_id AS "threadId", occurred_at AS "occurredAt"
        FROM orchestration_events WHERE event_type = 'thread.workjet-config-set'
          AND occurred_at > ${since} AND stream_id IN
          (SELECT thread_id FROM projection_threads WHERE project_id = ${project.id})
        ORDER BY occurred_at DESC LIMIT 100
      `,
      );
      const cwd = project.workspaceRoot ?? process.cwd();
      const repo = project.overview?.repositoryUrl;
      let pullRequests: typeof SupervisorPullRequests.Type = [];
      if (project.workspaceRoot || repo) {
        pullRequests = yield* read(
          "Pull requests",
          Effect.gen(function* () {
            if (!repo) {
              const provider = yield* registry.resolve({ cwd });
              if (provider.kind !== "github") {
                sourceErrors.push("PR CI details unavailable for " + provider.kind);
                return [];
              }
            } else if (!/^https:\/\/(?:www\.)?github\.com\//u.test(repo)) {
              sourceErrors.push("PR CI details unavailable for configured source provider");
              return [];
            }
            const result = yield* github.execute({
              cwd,
              args: [
                "pr",
                "list",
                ...(repo ? ["--repo", repo] : []),
                "--state",
                "open",
                "--limit",
                "100",
                "--json",
                "number,title,url,headRefName,createdAt,updatedAt,isDraft,author,statusCheckRollup,mergeStateStatus",
              ],
              timeoutMs: 15000,
              maxOutputBytes: 512000,
            });
            return yield* decodePullRequests(result.stdout);
          }),
        );
      } else sourceErrors.push("No project repository configured");
      const text = supervisorTickPrompt(
        supervisorTickSituation({
          project,
          threads: model.threads,
          since,
          now,
          pullRequests,
          sourceErrors,
          errors,
          escalations,
          changes,
          meetingMinutes: minutesUntilRegularMeeting(project.overview?.regularMeeting, now),
        }),
      );
      // Admission is rechecked atomically against the engine's current model after source collection.
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine
        .dispatch({
          type: "thread.supervisor.tick",
          commandId: CommandId.make(`server:supervisor-tick:${supervisor.id}:${dueAt}`),
          threadId: supervisor.id,
          scheduledAt: DateTime.formatIso(DateTime.makeUnsafe(dueAt)),
          createdAt,
          text,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Supervisor control round failed", {
              threadId: supervisor.id,
              error,
            }),
          ),
        );
    }
  });
  const start = Effect.fn("SupervisorTickReactor.start")(function* () {
    yield* forkParked(
      reconcile().pipe(
        Effect.catch((error) => Effect.logWarning("Supervisor tick recovery failed", { error })),
        Effect.repeat(Schedule.spaced("30 seconds")),
      ),
    );
  });
  return { start, reconcile };
});
export const SupervisorTickReactorLive = Layer.effect(
  SupervisorTickReactor,
  makeSupervisorTickReactor,
);
