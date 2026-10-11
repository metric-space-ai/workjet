import {
  CommandId,
  EventId,
  ThreadId,
  MeetingPreparationConfiguration,
  DEFAULT_MEETING_PREPARATION_CONFIGURATION,
  oneShotHarnessUnavailableReason,
  regularMeetingAt,
  meetingPreparationWindow,
  type OrchestrationProject,
  type OrchestrationThread,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { ProjectTokenBudgetStatus } from "../usage/projectTokenBudgetStatus.ts";
import { GitHubCli } from "../sourceControl/GitHubCli.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { CtoxThreadBindingSource } from "./ctox/CtoxThreadBinding.ts";
import { makeCtoxLumaConfigurationRpc } from "./ctox/CtoxLumaConfigurationRpc.ts";
import { makeCtoxLumaConfigurationClient } from "./ctox/CtoxLumaConfigurationClient.ts";
import { DecisionHubConnectionRegistry } from "./decisionHub/DecisionHubConnectionRegistry.ts";
import { WorkerDispatch } from "./WorkerDispatch.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import { WorkerPullRequestStore } from "./WorkerPullRequestStore.ts";
import {
  makePreparationStore,
  makePreparationRunner,
  PreparationError,
} from "./MeetingPreparation.ts";

const mergedSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      number: Schema.Int,
      title: Schema.String,
      url: Schema.String,
      mergedAt: Schema.String,
    }),
  ),
);
const encodeBrief = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MeetingPreparationConfiguration),
);

export const makeSupervisorMeetingPreparation = Effect.gen(function* () {
  const store = yield* makePreparationStore;
  const workers = yield* WorkerDispatch;
  const broker = yield* RemoteWorkerBroker;
  const environment = yield* ServerEnvironment;
  const settings = yield* ServerSettingsService;
  const bindings = yield* CtoxThreadBindingSource;
  const connections = yield* DecisionHubConnectionRegistry;
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const github = yield* GitHubCli;
  const registry = yield* SourceControlProviderRegistry;
  const pullRequests = yield* WorkerPullRequestStore;
  const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
  const rpc = makeCtoxLumaConfigurationRpc({
    connections,
    client: makeCtoxLumaConfigurationClient(http),
  });
  const fail = (detail: string) => new PreparationError({ detail });
  const runner = yield* makePreparationRunner({
    store,
    dispatch: (row) =>
      Effect.gen(function* () {
        const config = yield* decodeConfig(row.configurationJson).pipe(
          Effect.mapError(() => fail("Gespeicherte Vorbereitungs-Konfiguration ist ungültig.")),
        );
        const unavailable = oneShotHarnessUnavailableReason(config.harness);
        if (unavailable) return yield* fail(unavailable);
        const model = yield* query
          .getCommandReadModel()
          .pipe(Effect.mapError(() => fail("Supervisor ist nicht verfügbar.")));
        const parent = model.threads.find(
          (t) => t.id === row.supervisorThreadId && t.projectId === row.projectId,
        );
        if (
          !parent ||
          parent.deletedAt ||
          parent.archivedAt ||
          parent.workjetConfig.schemaVersion !== 2 ||
          parent.workjetConfig.team?.role !== "supervisor"
        )
          return yield* fail("Projekt-Supervisor ist nicht verfügbar.");
        const saved = yield* broker.read(ThreadId.make(row.intentId)).pipe(
          Effect.mapError(
            () =>
              new PreparationError({
                detail: "Worker-Start ist noch nicht sicher bestätigt.",
                pending: true,
              }),
          ),
        );
        if (Option.isSome(saved)) {
          if (
            saved.value.request.project.id !== row.projectId ||
            saved.value.request.parent.threadId !== row.supervisorThreadId
          )
            return yield* fail("Gespeicherter Worker-Start gehört zu einem anderen Projekt.");
          if (saved.value.response?.outcome.status === "dispatched")
            return saved.value.response.outcome.result;
          if (saved.value.response?.outcome.status === "failed")
            return yield* fail(
              `Worker-Start fehlgeschlagen: ${saved.value.response.outcome.reason}.`,
            );
          return yield* new PreparationError({
            detail: "Worker-Start wartet auf Bestätigung des Worker-Computers.",
            pending: true,
          });
        }
        const facts = yield* bindings
          .fromStartConfig(parent.workjetConfig)
          .pipe(Effect.mapError(() => fail("Supervisor-Instanz ist nicht verfügbar.")));
        if (
          parent.workjetConfig.capabilityBindings.some(
            (b) => b.capabilityId === "ctox-business-os",
          ) &&
          !facts.binding
        )
          return yield* fail(
            "Die gebundene Instanz ist für die Worker-Konfiguration nicht erreichbar.",
          );
        let catalog = (yield* settings.getSettings.pipe(
          Effect.mapError(() => fail("Worker-Konfiguration ist nicht verfügbar.")),
        )).workjet;
        if (facts.binding)
          catalog = yield* rpc
            .resolveDispatch(facts.binding, catalog)
            .pipe(
              Effect.mapError(() =>
                fail("Worker-Konfiguration der gebundenen Instanz ist nicht verfügbar."),
              ),
            );
        const candidates = catalog.workerProfiles
          .filter(
            (p) =>
              p.harness === config.harness &&
              p.modelId === config.model &&
              (config.workerProfileId === undefined || p.id === config.workerProfileId) &&
              catalog.llmRoutes.some((r) => r.id === p.llmRouteId),
          )
          .sort(
            (a, b) =>
              Number(b.computerId === catalog.selectedComputerId) -
                Number(a.computerId === catalog.selectedComputerId) || a.id.localeCompare(b.id),
          );
        const profile = candidates[0];
        if (!profile)
          return yield* fail(
            `Kein konfigurierter Worker für ${config.harness} / ${config.model} mit Kontoroute vorhanden.`,
          );
        if (!workers.dispatchNativeIntent)
          return yield* fail("Idempotenter Worker-Dispatch ist nicht verfügbar.");
        return yield* workers
          .dispatchNativeIntent(
            {
              environmentId: yield* environment.getEnvironmentId,
              threadId: parent.id,
              providerSessionId: row.intentId,
              providerInstanceId: parent.modelSelection.instanceId,
              capabilities: new Set(),
              activeWorkjetMcpCapabilityIds: new Set(parent.workjetConfig.enabledCapabilityIds),
              workjetRole: "orchestrator",
              projectTeamRole: "supervisor",
              ...(facts.binding ? { ctoxBusinessOsBinding: facts.binding } : {}),
              issuedAt: DateTime.toEpochMillis(yield* DateTime.now),
            },
            {
              task: row.task,
              title: `Regeltermin ${row.meetingAt.slice(0, 10)} · T-${row.leadMinutes} min`,
              workerProfileId: profile.id,
            },
            ThreadId.make(row.intentId),
          )
          .pipe(
            Effect.timeout("20 seconds"),
            Effect.mapError(
              (e) =>
                new PreparationError({
                  detail:
                    e._tag === "TimeoutError"
                      ? "Worker-Start wartet auf Bestätigung des Worker-Computers."
                      : `Worker-Start fehlgeschlagen: ${e.reason}.`,
                  ...(e._tag === "TimeoutError" || e.reason === "remote-dispatch-pending"
                    ? { pending: true }
                    : {}),
                }),
            ),
          );
      }),
    outcome: (row) =>
      Effect.gen(function* () {
        const id = ThreadId.make(row.workerThreadId!);
        const receipt = yield* pullRequests
          .get(id)
          .pipe(Effect.mapError(() => fail("Worker-Rückbericht konnte nicht gelesen werden.")));
        if (Option.isSome(receipt))
          return { status: "completed" as const, detail: receipt.value.prUrl };
        const model = yield* query
          .getCommandReadModel()
          .pipe(Effect.mapError(() => fail("Worker-Status konnte nicht gelesen werden.")));
        const worker = model.threads.find((t) => t.id === id);
        if (worker?.latestTurn?.state === "error" || worker?.session?.status === "error")
          return {
            status: "failed" as const,
            detail: worker.session?.lastError ?? "Vorbereitungs-Worker ist fehlgeschlagen.",
          };
        if (worker?.latestTurn?.state === "completed")
          return { status: "completed" as const, detail: "Rückbericht im Worker-Verlauf prüfen." };
        if (
          DateTime.toEpochMillis(yield* DateTime.now) >=
          DateTime.toEpochMillis(DateTime.makeUnsafe(row.meetingAt))
        )
          return {
            status: "failed" as const,
            detail:
              "Termin erreicht, aber kein Vorbereitungs-Rückbericht eingegangen. Worker prüfen.",
          };
        return { status: "running" as const };
      }),
    report: (row) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        const key = `server:meeting-preparation:${row.intentId}:${row.status}`;
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(key),
            threadId: ThreadId.make(row.supervisorThreadId),
            activity: {
              id: EventId.make(key),
              tone: row.status === "failed" ? "error" : "info",
              kind: "supervisor.meeting-preparation",
              summary: `Regeltermin-Vorbereitung T-${row.leadMinutes} min: ${row.status === "failed" ? "fehlgeschlagen" : row.status === "completed" ? "Entwurf zur Prüfung bereit" : row.status === "pending" ? "Worker-Start wartet" : "Worker gestartet"}${row.failure ? " · " + row.failure : ""}`,
              payload: {
                meetingAt: row.meetingAt,
                leadMinutes: row.leadMinutes,
                workerThreadId: row.workerThreadId,
                detail: row.failure,
              },
              turnId: null,
              createdAt: at,
            },
            createdAt: at,
          })
          .pipe(
            Effect.mapError(() =>
              fail(
                "Vorbereitungs-Rückmeldung konnte nicht im Supervisor-Verlauf gespeichert werden.",
              ),
            ),
          );
      }),
  });
  const run = Effect.fn("SupervisorMeetingPreparation.run")(function* (input: {
    project: OrchestrationProject;
    supervisor: OrchestrationThread;
    now: number;
    situation: string;
    tokenBudget?: ProjectTokenBudgetStatus;
  }) {
    const meeting = input.project.overview?.regularMeeting;
    const config =
      input.project.overview?.meetingPreparation ?? DEFAULT_MEETING_PREPARATION_CONFIGURATION;
    let merged: typeof mergedSchema.Type = [];
    const sourceErrors: string[] = [];
    const next = meeting ? regularMeetingAt(meeting, input.now) : null;
    const previous =
      meeting && next !== null ? regularMeetingAt(meeting, next - 1, "previous") : null;
    if (meeting && previous !== null && meetingPreparationWindow(meeting, config, input.now)) {
      const repo = input.project.overview?.repositoryUrl;
      const cwd = input.project.workspaceRoot ?? process.cwd();
      const fetched = yield* Effect.result(
        Effect.gen(function* () {
          if (
            repo
              ? !/^https:\/\/(?:www\.)?github\.com\//u.test(repo)
              : (yield* registry.resolve({ cwd })).kind !== "github"
          )
            return yield* fail("Gemergte PRs sind beim Projekt-Provider nicht verfügbar.");
          const result = yield* github.execute({
            cwd,
            args: [
              "pr",
              "list",
              ...(repo ? ["--repo", repo] : []),
              "--state",
              "merged",
              "--search",
              `merged:>=${DateTime.formatIso(DateTime.makeUnsafe(previous)).slice(0, 10)}`,
              "--limit",
              "100",
              "--json",
              "number,title,url,mergedAt",
            ],
            timeoutMs: 15000,
            maxOutputBytes: 256000,
          });
          return yield* Schema.decodeUnknownEffect(mergedSchema)(result.stdout);
        }).pipe(Effect.timeout("15 seconds")),
      );
      if (fetched._tag === "Success")
        merged = fetched.success.filter(
          (pr) => DateTime.toEpochMillis(DateTime.makeUnsafe(pr.mergedAt)) >= previous,
        );
      else
        sourceErrors.push("Gemergte PRs seit dem letzten Termin konnten nicht gesammelt werden.");
    }
    const goal =
      input.supervisor.workjetConfig.schemaVersion === 2
        ? input.supervisor.workjetConfig.goal
        : undefined;
    yield* runner({
      projectId: input.project.id,
      supervisorThreadId: input.supervisor.id,
      meeting,
      configuration: config,
      now: input.now,
      brief: yield* encodeBrief({
        supervisorGoal:
          goal?.objective ??
          (input.supervisor.workjetConfig.schemaVersion === 2
            ? input.supervisor.workjetConfig.team?.goal
            : undefined) ??
          input.project.title,
        supervisorKanban: goal?.kanban ?? null,
        controlRound: input.situation,
        mergedPullRequests: merged,
        tokenBudget: input.tokenBudget ?? null,
        sourceErrors,
        limits: { mergedPullRequests: 100 },
      }),
    });
  });
  return { run };
});
export class SupervisorMeetingPreparation extends Context.Service<
  SupervisorMeetingPreparation,
  Effect.Success<typeof makeSupervisorMeetingPreparation>
>()("workjet/workjet/SupervisorMeetingPreparation") {}
export const SupervisorMeetingPreparationLive = Layer.effect(
  SupervisorMeetingPreparation,
  makeSupervisorMeetingPreparation,
);
