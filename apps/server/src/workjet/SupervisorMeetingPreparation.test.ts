import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  WorkjetComputerId,
  WorkjetWorkerProfileId,
  WorkjetLlmRouteId,
  WorkjetGatewayAccountId,
  type ThreadId,
  type WorkjetWorkerProfile,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../config.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitHubCli } from "../sourceControl/GitHubCli.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { layerTest as settingsTest } from "../serverSettings.ts";
import { CtoxThreadBindingSource } from "./ctox/CtoxThreadBinding.ts";
import { DecisionHubConnectionRegistry } from "./decisionHub/DecisionHubConnectionRegistry.ts";
import {
  WorkerDispatch,
  type WorkerDispatchInput,
  type WorkerDispatchResult,
} from "./WorkerDispatch.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import { WorkerPullRequestStore } from "./WorkerPullRequestStore.ts";
import { makeSupervisorMeetingPreparation } from "./SupervisorMeetingPreparation.ts";

const source = EnvironmentId.make("preparation-source");
const computer = {
  id: WorkjetComputerId.make("preparation-computer"),
  label: "Worker computer",
  environmentId: EnvironmentId.make("preparation-target"),
  presentationKind: "ssh" as const,
  harnesses: [],
};
const profile = {
  id: WorkjetWorkerProfileId.make("preparation-profile"),
  name: "Preparation Grok",
  computerId: computer.id,
  harness: "claude-code",
  llmRouteId: WorkjetLlmRouteId.make("preparation-route"),
  modelId: "grok-4.7",
  reasoning: "automatic",
  role: "standard",
  capabilityIds: [],
  capabilityBindings: [],
} as const satisfies WorkjetWorkerProfile;
it.layer(NodeServices.layer)("meeting preparation through the project engine", (it) => {
  it.effect(
    "selects the configured Claude/Grok worker, supplies merged PRs and budget, and records the start once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
            prefix: "preparation-live-",
          });
          const runtime = OrchestrationLayerLive.pipe(
            Layer.provideMerge(RepositoryIdentityResolver.layer),
            Layer.provideMerge(SqlitePersistenceMemory),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), home)),
            Layer.provideMerge(NodeServices.layer),
          );
          yield* Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const query = yield* ProjectionSnapshotQuery;
            const projectId = ProjectId.make("meeting-project");
            const createdAt = "2026-10-11T12:00:00.000Z";
            yield* engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("meeting-project-create"),
              projectId,
              title: "Meeting project",
              workspaceRoot: null,
              createdAt,
            });
            yield* engine.dispatch({
              type: "project.meta.update",
              commandId: CommandId.make("meeting-project-config"),
              projectId,
              overview: {
                websiteUrl: null,
                slots: [null, null, null],
                repositoryUrl: "https://github.com/example/project",
                regularMeeting: { weekday: 1, time: "13:00", timezone: "Europe/Berlin" },
              },
            });
            const model = yield* query.getCommandReadModel();
            const project = model.projects.find((p) => p.id === projectId)!;
            const supervisor = model.threads.find((t) => t.projectId === projectId)!;
            const starts: { input: Omit<WorkerDispatchInput, "remoteRequestId">; id: ThreadId }[] =
              [];
            const workers = Layer.mock(WorkerDispatch)({
              dispatchNativeIntent: (invocation, input, id) => {
                starts.push({ input, id });
                expect(invocation.threadId).toBe(supervisor.id);
                expect(invocation.projectTeamRole).toBe("supervisor");
                expect(input.workerProfileId).toBe(profile.id);
                return Effect.succeed({
                  schemaVersion: 1,
                  status: "dispatched",
                  environmentId: computer.environmentId,
                  workerThreadId: id,
                  computerId: computer.id,
                  branch: `workjet/worker/${id}`,
                  worktreePath: "/isolated/preparation",
                  parent: { environmentId: source, threadId: supervisor.id },
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("claudeAgent"),
                    model: profile.modelId,
                  },
                  enabledCapabilityIds: [],
                  harness: profile.harness,
                } satisfies WorkerDispatchResult);
              },
            });
            const service = yield* makeSupervisorMeetingPreparation.pipe(
              Effect.provide(
                Layer.mergeAll(
                  workers,
                  settingsTest({
                    workjet: {
                      computers: [computer],
                      workerProfiles: [profile],
                      llmRoutes: [
                        {
                          id: profile.llmRouteId,
                          label: "Existing pool",
                          gatewayAccountId: WorkjetGatewayAccountId.make("preparation-account"),
                        },
                      ],
                    },
                  }),
                  Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(source) }),
                  Layer.mock(CtoxThreadBindingSource)({
                    fromStartConfig: () =>
                      Effect.succeed({ environmentId: source, binding: undefined }),
                  }),
                  Layer.mock(DecisionHubConnectionRegistry)({}),
                  Layer.mock(RemoteWorkerBroker)({ read: () => Effect.succeed(Option.none()) }),
                  Layer.mock(WorkerPullRequestStore)({ get: () => Effect.succeed(Option.none()) }),
                  Layer.mock(SourceControlProviderRegistry)({}),
                  Layer.mock(GitHubCli)({
                    execute: () =>
                      Effect.succeed({
                        stdout:
                          '[{"number":42,"title":"Merged change","url":"https://github.com/example/project/pull/42","mergedAt":"2026-10-10T12:00:00Z"}]',
                        stderr: "",
                        exitCode: ChildProcessSpawner.ExitCode(0),
                        stdoutTruncated: false,
                        stderrTruncated: false,
                      }),
                  }),
                ),
              ),
            );
            const input = {
              project,
              supervisor,
              now: Date.parse("2026-10-11T17:00:00Z"),
              situation: '{"escalations":[{"decisionKey":"release-date"}]}',
            };
            yield* service.run(input);
            yield* service.run({ ...input, now: input.now + 1800000 });
            expect(starts).toHaveLength(1);
            expect(starts[0]?.input.task).toContain("Merged change");
            expect(starts[0]?.input.task).toContain("release-date");
            const current = yield* query.getCommandReadModel();
            expect(current.threads.find((t) => t.id === supervisor.id)?.modelSelection).toEqual(
              supervisor.modelSelection,
            );
            expect(
              (yield* Stream.runCollect(engine.readEvents(0, 100))).some(
                (e) =>
                  e.type === "thread.activity-appended" &&
                  e.payload.activity.kind === "supervisor.meeting-preparation" &&
                  e.payload.activity.summary.includes("Worker gestartet"),
              ),
            ).toBe(true);
            yield* service.run({
              ...input,
              now: Date.parse("2026-10-12T09:00:00Z"),
              project: {
                ...project,
                overview: {
                  ...project.overview!,
                  meetingPreparation: {
                    enabled: true,
                    harness: "grok-cli",
                    model: "grok-4.7",
                    leadMinutes: [1440, 120],
                  },
                },
              },
            });
            expect(starts).toHaveLength(1);
            expect(
              (yield* Stream.runCollect(engine.readEvents(0, 100))).some(
                (e) =>
                  e.type === "thread.activity-appended" &&
                  e.payload.activity.tone === "error" &&
                  e.payload.activity.summary.includes("Worktree-Begrenzung"),
              ),
            ).toBe(true);
          }).pipe(Effect.provide(runtime));
        }),
      ),
  );
});
