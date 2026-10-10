for (const requestedHarness of [
  "claude-code",
  "grok-cli",
  "opencode",
  "minimax-code",
  "greppy",
  "pi-code",
] as const) {
  it.effect(`dispatches remote ${requestedHarness} with its immutable harness and model`, () =>
    Effect.gen(function* () {
      const harness = makeHarness({ remoteSource: true, remoteReplyLost: true });
      const profile = { ...remoteProfile, harness: requestedHarness };
      const configuration = {
        computers: [remoteComputer],
        workerProfiles: [profile],
        llmRoutes: [
          {
            id: profile.llmRouteId,
            label: "Worker route",
            gatewayAccountId: WorkjetGatewayAccountId.make("worker-account"),
          },
        ],
      };
      const service = yield* harness.service.pipe(
        Effect.provide(serverSettingsLayerTest({ workjet: configuration })),
      );
      const input = { task: "Fix docs", workerProfileId: profile.id };
      const pending = yield* Effect.flip(service.dispatch(invocation, input));
      expect(pending.reason).toBe("remote-dispatch-pending");
      const request = harness.remoteRequests[0]!;
      expect(request.harness).toBe(profile.harness);
      expect(request.modelSelection.model).toBe(profile.modelId);
      expect(request.modelSelection.model).not.toBe(inheritedModel.model);
      const switched = yield* harness.service.pipe(
        Effect.provide(
          serverSettingsLayerTest({
            workjet: { ...configuration, workerProfiles: [remoteProfile] },
          }),
        ),
      );
      expect(
        (yield* Effect.flip(
          switched.dispatch(invocation, { ...input, remoteRequestId: pending.remoteRequestId! }),
        )).reason,
      ).toBe("remote-dispatch-failed");
      expect(
        (yield* service.dispatch(invocation, {
          ...input,
          remoteRequestId: pending.remoteRequestId!,
        })).workerThreadId,
      ).toBe(request.requestId);
      expect(harness.remoteRequests).toHaveLength(1);
      expect(harness.commands).toEqual([]);
    }),
  );
}
it.effect(
  "uses the native intent as the first remote worker ID and reconciles it after source restart",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({ remoteSource: true, remoteReplyLost: true });
      const input = { task: "Fix documentation", computerId: remoteComputer.id };
      const intentId = ThreadId.make(ids[4]);
      const first = yield* harness.service.pipe(Effect.provide(computerCatalogLayer));
      expect(
        (yield* Effect.flip(first.dispatch(invocation, { ...input, remoteRequestId: intentId })))
          .reason,
      ).toBe("remote-dispatch-failed");
      expect(harness.remoteRequests).toHaveLength(0);
      const pending = yield* Effect.flip(first.dispatchNativeIntent!(invocation, input, intentId));
      expect(pending.reason).toBe("remote-dispatch-pending");
      expect(pending.remoteRequestId).toBe(intentId);
      const restarted = yield* harness.service.pipe(Effect.provide(computerCatalogLayer));
      const result = yield* restarted.dispatchNativeIntent!(invocation, input, intentId);
      expect(result.workerThreadId).toBe(intentId);
      expect(result.branch).toBe(`workjet/worker/${intentId}`);
      expect(harness.remoteRequests).toHaveLength(1);
      expect(harness.remoteRequests[0]?.requestId).toBe(intentId);
      expect(harness.commands).toEqual([]);
      expect(harness.worktreeCreates).toEqual([]);
      expect(
        (yield* Effect.flip(
          restarted.dispatchNativeIntent!(invocation, { ...input, task: "Substituted" }, intentId),
        )).reason,
      ).toBe("remote-dispatch-failed");
      expect(harness.remoteRequests).toHaveLength(1);
    }),
);

it.effect("refuses local placement for a native remote intent without creating a checkout", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ remoteSource: true });
    const service = yield* harness.service.pipe(Effect.provide(computerCatalogLayer));
    const error = yield* Effect.flip(
      service.dispatchNativeIntent!(
        invocation,
        {
          task: "Fix documentation",
          computerId: localComputer.id,
        },
        ThreadId.make(ids[4]),
      ),
    );
    expect(error.reason).toBe("remote-dispatch-failed");
    expect(harness.commands).toEqual([]);
    expect(harness.worktreeCreates).toEqual([]);
    expect(harness.remoteRequests).toEqual([]);
  }),
);
it.effect("requires one explicit configured remote worker profile", () =>
  Effect.gen(function* () {
    for (const profiles of [
      [],
      [remoteProfile, { ...remoteProfile, id: WorkjetWorkerProfileId.make("second-profile") }],
    ]) {
      const harness = makeHarness({ remoteSource: true });
      const service = yield* harness.service.pipe(
        Effect.provide(
          serverSettingsLayerTest({
            workjet: {
              computers: [remoteComputer],
              workerProfiles: profiles,
              llmRoutes: [
                {
                  id: remoteProfile.llmRouteId,
                  label: "Worker route",
                  gatewayAccountId: WorkjetGatewayAccountId.make("worker-account"),
                },
              ],
            },
          }),
        ),
      );
      const error = yield* Effect.flip(
        service.dispatch(invocation, { task: "Fix docs", computerId: remoteComputer.id }),
      );
      expect(error.reason).toBe("worker-profile-unavailable");
      expect(harness.remoteRequests).toEqual([]);
      expect(harness.worktreeCreates).toEqual([]);
    }
  }),
);
it.effect("explicit profile disambiguates the computer and preserves exact retry options", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ remoteSource: true, remoteReplyLost: true });
    const service = yield* harness.service.pipe(
      Effect.provide(
        serverSettingsLayerTest({
          workjet: {
            computers: [remoteComputer],
            workerProfiles: [
              remoteProfile,
              { ...remoteProfile, id: WorkjetWorkerProfileId.make("second-profile") },
            ],
            llmRoutes: [
              {
                id: remoteProfile.llmRouteId,
                label: "Worker route",
                gatewayAccountId: WorkjetGatewayAccountId.make("worker-account"),
              },
            ],
          },
        }),
      ),
    );
    const input = {
      task: "Fix docs",
      workerProfileId: remoteProfile.id,
      modelSelection: { ...inheritedModel, model: remoteProfile.modelId },
    };
    const pending = yield* Effect.flip(service.dispatch(invocation, input));
    expect(pending.reason).toBe("remote-dispatch-pending");
    const result = yield* service.dispatch(invocation, {
      ...input,
      remoteRequestId: pending.remoteRequestId!,
    });
    expect(result.workerThreadId).toBe(ids[0]);
    expect(harness.remoteRequests).toHaveLength(1);
    expect(harness.remoteRequests[0]?.modelSelection).toEqual(input.modelSelection);
  }),
);
it.effect(
  "dispatches a registered remote worker without creating a source checkout or thread",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({ remoteSource: true });
      const service = yield* harness.service.pipe(Effect.provide(computerCatalogLayer));
      const result = yield* service.dispatch(invocation, {
        task: "Fix documentation",
        computerId: remoteComputer.id,
      });
      expect(result.environmentId).toBe(remoteComputer.environmentId);
      expect(result.worktreePath).toBe("/gpu3/owned-worker");
      expect(harness.commands).toEqual([]);
      expect(harness.worktreeCreates).toEqual([]);
      expect(harness.remoteRequests).toHaveLength(1);
      expect(harness.remoteRequests[0]?.workerProfileId).toBe(remoteProfile.id);
      expect(harness.remoteRequests[0]?.llmRouteId).toBe(remoteProfile.llmRouteId);
      expect(harness.remoteRequests[0]?.modelSelection.model).toBe("gpt-worker");
      expect(harness.remoteRequests[0]?.project.repository.rootPath).toBeUndefined();
      expect(harness.remoteRequests[0]?.project.repository.locator.remoteUrl).toBe(
        "https://github.com/example/project.git",
      );
    }),
);
it.effect("reconciles a lost remote reply under its saved ID and rejects retry substitutions", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ remoteSource: true, remoteReplyLost: true });
    const service = yield* harness.service.pipe(Effect.provide(computerCatalogLayer));
    const input = { task: "Fix documentation", computerId: remoteComputer.id };
    const pending = yield* Effect.flip(service.dispatch(invocation, input));
    expect(pending.reason).toBe("remote-dispatch-pending");
    expect(pending.remoteRequestId).toBe(ids[0]);
    const retry = { ...input, remoteRequestId: pending.remoteRequestId! };
    expect(
      (yield* Effect.flip(service.dispatch(invocation, { ...retry, task: "Different task" })))
        .reason,
    ).toBe("remote-dispatch-failed");
    expect(
      (yield* Effect.flip(
        service.dispatch(invocation, {
          ...retry,
          modelSelection: { ...inheritedModel, model: "substitution" },
        }),
      )).reason,
    ).toBe("worker-profile-unavailable");
    expect((yield* service.dispatch(invocation, retry)).workerThreadId).toBe(ids[0]);
    expect(harness.remoteRequests).toHaveLength(1);
    expect(harness.commands).toEqual([]);
  }),
);
it.effect("does not discard dirty source edits during remote dispatch", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ remoteSource: true, sourceDirty: true });
    const service = yield* harness.service.pipe(Effect.provide(computerCatalogLayer));
    expect(
      (yield* Effect.flip(
        service.dispatch(invocation, { task: "Fix documentation", computerId: remoteComputer.id }),
      )).reason,
    ).toBe("remote-dispatch-failed");
    expect(harness.remoteRequests).toEqual([]);
    expect(harness.commands).toEqual([]);
  }),
);
// @effect-diagnostics preferSchemaOverJson:off -- redaction assertions inspect complete bounded results.
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WorkjetComputerId,
  WorkjetWorkerProfileId,
  WorkjetLlmRouteId,
  WorkjetGatewayAccountId,
  WorkjetMeshWorkspaceId,
  WorkjetContentDigest,
  WorkjetSealedPayloadRef,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationThread,
  type RemoteWorkerRequest,
  type WorkjetComputer,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { layerTest as serverSettingsLayerTest, ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import {
  OrchestrationEngineService,
  type OrchestrationDispatchOptions,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { WorkjetSnapshotStore } from "./mailbox/WorkjetSnapshotStore.ts";
import { WorkjetMeshIdentity } from "./mailbox/WorkjetMeshIdentity.ts";
import { WorkjetMailboxStore } from "./mailbox/WorkjetMailboxStore.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkerDispatchRollback, WorkerDispatchRollbackError } from "./WorkerDispatchRollback.ts";
import {
  WorktreeStorage,
  layerTest as worktreeStorageLayerTest,
} from "../worktree/WorktreeStorage.ts";
import {
  deriveWorkerTitle,
  makeWorkerDispatchWithSources,
  WORKER_REF_PREFIX,
  type WorkerDispatchSources,
} from "./WorkerDispatch.ts";

const environmentId = EnvironmentId.make("environment-local");
const parentThreadId = ThreadId.make("thread-parent");
const inheritedModel = {
  instanceId: ProviderInstanceId.make("codex-main"),
  model: "gpt-5.4",
  options: [{ id: "reasoning", value: "high" }],
} as const satisfies ModelSelection;
const parent = {
  id: parentThreadId,
  projectId: ProjectId.make("project-1"),
  title: "Parent orchestrator",
  modelSelection: inheritedModel,
  runtimeMode: "auto-accept-edits",
  interactionMode: "plan",
  workjetConfig: {
    schemaVersion: 2,
    role: "standard",
    parent: null,
    managedInstructions: "Keep changes bounded.",
    enabledCapabilityIds: ["greppy", "web-search"],
    capabilityBindings: [],
    team: {
      projectId: ProjectId.make("project-1"),
      threadId: parentThreadId,
      role: "supervisor",
      parentThreadId: null,
      goal: "Coordinate the project",
      createdAt: "2026-08-15T12:34:56.000Z",
    },
  },
  branch: "feature/work",
  worktreePath: "/workspace/worktree",
  deletedAt: null,
} as unknown as OrchestrationThread;
const teamConfig = {
  ...parent.workjetConfig,
  schemaVersion: 2,
  capabilityBindings: [],
  team: {
    projectId: parent.projectId,
    threadId: parent.id,
    role: "specialist",
    parentThreadId: ThreadId.make("supervisor"),
    domain: "implementation",
    goal: "Implement the project",
    createdAt: "2026-08-15T12:34:56.000Z",
  },
} as const;
const teamParent = {
  ...parent,
  workjetConfig: teamConfig,
} as OrchestrationThread;
const invocation: McpInvocationScope = {
  environmentId,
  threadId: parentThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex-main"),
  capabilities: new Set(["preview"]),
  workjetRole: "orchestrator",
  issuedAt: 1,
};
const localComputer = {
  id: WorkjetComputerId.make("saved-local"),
  label: "Local build computer",
  environmentId,
  presentationKind: "local",
  harnesses: [],
} as const satisfies WorkjetComputer;
const remoteComputer = {
  ...localComputer,
  id: WorkjetComputerId.make("saved-gpu3"),
  label: "GPU3",
  environmentId: EnvironmentId.make("environment-gpu3"),
  presentationKind: "ssh",
} as const satisfies WorkjetComputer;
const remoteProfile = {
  id: WorkjetWorkerProfileId.make("gpu3-docs"),
  name: "GPU3 documentation",
  computerId: remoteComputer.id,
  harness: "codex-cli" as const,
  llmRouteId: WorkjetLlmRouteId.make("worker-route"),
  modelId: "gpt-worker",
  reasoning: "automatic" as const,
  role: "standard" as const,
  capabilityIds: ["greppy"] as const,
  capabilityBindings: [],
};
const computerCatalogLayer = serverSettingsLayerTest({
  workjet: {
    computers: [localComputer, remoteComputer],
    selectedComputerId: null,
    workerProfiles: [remoteProfile],
    llmRoutes: [
      {
        id: remoteProfile.llmRouteId,
        label: "Worker route",
        gatewayAccountId: WorkjetGatewayAccountId.make("worker-account"),
      },
    ],
  },
});
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
] as const;
const nthId = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
const now = "2026-08-15T12:34:56.000Z";
const worktreeRoot = "/Volumes/tmp/workjet/worktrees";
const workspaceRoot = "/workspace/project";

/**
 * Mirrors the real `WorktreeStorage.resolveAutomaticPath` contract: a directory
 * beneath the server-authoritative root, keyed by repository and ref.
 */
const worktreeStorageLayer = worktreeStorageLayerTest({
  resolveAutomaticPath: (storageInput) =>
    Effect.succeed(
      `${worktreeRoot}/repository-hash/${storageInput.ref.replace(/[^A-Za-z0-9._-]+/g, "-")}`,
    ),
  trustedRoots: [worktreeRoot],
});

interface WorktreeCreateRecord {
  readonly cwd: string;
  readonly refName: string;
  readonly newRefName: string | undefined;
  readonly path: string;
}

const makeHarness = (input?: {
  readonly currentParent?: OrchestrationThread | undefined;
  readonly remoteSource?: boolean;
  readonly sourceDirty?: boolean;
  readonly remoteReplyLost?: boolean;
  readonly queryFails?: boolean;
  readonly failCommandTypes?: ReadonlyArray<OrchestrationCommand["type"]>;
  readonly failWorktreeCreate?: boolean;
  readonly failCreateAttempts?: number;
  readonly createReceiptStatus?: "accepted" | "rejected" | "missing" | "unavailable";
  readonly turnReceiptStatus?: "accepted" | "rejected" | "missing";
  readonly committedDelegation?: boolean;
  readonly workerProjection?: "matching" | "mismatched";
  readonly failWorktreeRemove?: boolean;
  readonly failBranchDelete?: boolean;
  readonly missingDelegationStorage?: boolean;
}) => {
  const commands: Array<OrchestrationCommand> = [];
  const remoteRequests: RemoteWorkerRequest[] = [];
  let loseRemoteReply = input?.remoteReplyLost ?? false;
  const dispatchOptions: Array<OrchestrationDispatchOptions | undefined> = [];
  const worktreeCreates: Array<WorktreeCreateRecord> = [];
  const worktreeRemovals: Array<{ readonly cwd: string; readonly path: string }> = [];
  const branchDeletions: Array<{ readonly cwd: string; readonly refName: string }> = [];
  let idIndex = 0;
  const ordinals = new Map<string, number>();
  let createFailures = input?.failCreateAttempts ?? 0;
  const sources: WorkerDispatchSources = {
    // Deterministic and unbounded, so a second dispatch in the same harness gets
    // genuinely fresh identifiers instead of reusing the first worker's id.
    randomUUID: Effect.sync(() => nthId(idIndex++)),
    nowIso: Effect.succeed(now),
    nextWorkerOrdinal: (_parent, workerId) =>
      Effect.sync(() => {
        if (!ordinals.has(workerId)) ordinals.set(workerId, ordinals.size + 1);
        return ordinals.get(workerId)!;
      }),
  };
  const engine = {
    dispatch: (command: OrchestrationCommand, options?: OrchestrationDispatchOptions) => {
      commands.push(command);
      dispatchOptions.push(options);
      if (command.type === "thread.create" && createFailures > 0) {
        createFailures -= 1;
        return Effect.fail({ _tag: "PersistenceSqlError", detail: "lost acknowledgement" });
      }
      return input?.failCommandTypes?.includes(command.type)
        ? Effect.fail({
            _tag: "DownstreamTestError",
            message: `downstream secret for ${command.type}`,
          } as const)
        : Effect.succeed({ sequence: commands.length });
    },
  } as unknown as OrchestrationEngineService["Service"];
  const query = {
    getThreadDetailById: (threadId: ThreadId) => {
      if (input?.queryFails) {
        return Effect.fail({ _tag: "QueryTestError", message: "sensitive SQL text" } as const);
      }
      if (threadId !== parentThreadId) {
        if (!input?.workerProjection) return Effect.succeed(Option.none());
        const workerRef = `${WORKER_REF_PREFIX}${threadId}`;
        return Effect.succeed(
          Option.some({
            ...teamParent,
            id: threadId,
            archivedAt: null,
            branch: input.workerProjection === "matching" ? workerRef : "unrelated/branch",
            worktreePath: `${worktreeRoot}/repository-hash/${workerRef.replace(/[^A-Za-z0-9._-]+/g, "-")}`,
            workjetConfig: {
              ...teamParent.workjetConfig,
              role: "worker",
              parent: { environmentId, threadId: parentThreadId },
              team: {
                ...teamConfig.team,
                role: "worker",
                parentThreadId,
                threadId,
                packageId: threadId,
              },
            },
          } as OrchestrationThread),
        );
      }
      return Effect.succeed(
        input && "currentParent" in input
          ? input.currentParent === undefined
            ? Option.none()
            : Option.some(input.currentParent)
          : Option.some(parent),
      );
    },
    getProjectShellById: () =>
      Effect.succeed(
        Option.some({
          id: parent.projectId,
          title: "Project",
          workspaceRoot,
          repositoryIdentity: {
            canonicalKey: "github:example/project",
            rootPath: workspaceRoot,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:example/project.git",
            },
          },
        }),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const receipts = {
    getByCommandId: ({ commandId }: { commandId: string }) => {
      const status = commandId === ids[2] ? input?.turnReceiptStatus : input?.createReceiptStatus;
      if (status === "unavailable") {
        return Effect.fail({ _tag: "ReceiptReadError" });
      }
      if (!status || status === "missing") {
        return Effect.succeed(Option.none());
      }
      return Effect.succeed(
        Option.some({
          aggregateKind: "thread",
          aggregateId: ThreadId.make(ids[0]),
          status,
        }),
      );
    },
  } as unknown as OrchestrationCommandReceiptRepository["Service"];
  const mailbox = {
    getDelegation: () => {
      const delegation = dispatchOptions[0]?.workerDelegation?.delegation;
      return Effect.succeed(
        input?.committedDelegation && delegation
          ? Option.some({ delegation, delegationId: delegation.delegationId, state: "queued" })
          : Option.none(),
      );
    },
  } as unknown as WorkjetMailboxStore["Service"];
  const gitCommandFailure = {
    _tag: "GitCommandError",
    detail: "downstream git secret",
  } as const;
  const service = Effect.gen(function* () {
    const storage = yield* WorktreeStorage;
    const gitWorkflow = {
      localStatus: () =>
        Effect.succeed({ isRepo: true, hasWorkingTreeChanges: input?.sourceDirty ?? false }),
      createWorktree: (worktreeInput: {
        readonly cwd: string;
        readonly refName: string;
        readonly newRefName?: string;
        readonly path: string | null;
      }) => {
        if (input?.failWorktreeCreate) return Effect.fail(gitCommandFailure);
        const ref = worktreeInput.newRefName ?? worktreeInput.refName;
        return (
          worktreeInput.path === null
            ? storage.resolveAutomaticPath({
                cwd: worktreeInput.cwd,
                gitCommonDir: `${worktreeInput.cwd}/.git`,
                ref,
              })
            : Effect.succeed(worktreeInput.path)
        ).pipe(
          Effect.mapError(() => gitCommandFailure),
          Effect.map((path) => {
            worktreeCreates.push({
              cwd: worktreeInput.cwd,
              refName: worktreeInput.refName,
              newRefName: worktreeInput.newRefName,
              path,
            });
            return { worktree: { path, refName: ref } };
          }),
        );
      },
      removeWorktree: (removeInput: {
        readonly cwd: string;
        readonly path: string;
        readonly force?: boolean;
      }) => {
        expect(removeInput.force).toBe(false);
        worktreeRemovals.push({ cwd: removeInput.cwd, path: removeInput.path });
        return input?.failWorktreeRemove ? Effect.fail(gitCommandFailure) : Effect.void;
      },
      deleteBranch: (deleteInput: {
        readonly cwd: string;
        readonly refName: string;
        readonly force?: boolean;
      }) => {
        expect(deleteInput.force).toBe(false);
        branchDeletions.push({ cwd: deleteInput.cwd, refName: deleteInput.refName });
        return input?.failBranchDelete ? Effect.fail(gitCommandFailure) : Effect.void;
      },
    } as unknown as GitWorkflowService["Service"];
    const broker = {
      enqueue: (request: RemoteWorkerRequest) =>
        Effect.sync(() => {
          remoteRequests.push(request);
        }),
      read: (id: ThreadId) =>
        Effect.succeed(
          Option.fromUndefinedOr(remoteRequests.find((request) => request.requestId === id)).pipe(
            Option.map((request) => ({ request, response: null, worktreePath: null })),
          ),
        ),
      awaitResponse: (id: ThreadId) =>
        Effect.suspend(() => {
          if (loseRemoteReply) {
            loseRemoteReply = false;
            return Effect.fail({ _tag: "TransportUnavailable" });
          }
          const request = remoteRequests.find((request) => request.requestId === id)!;
          return Effect.succeed({
            requestId: id,
            outcome: {
              status: "dispatched",
              result: {
                schemaVersion: 1,
                status: "dispatched",
                environmentId: request.targetEnvironmentId,
                workerThreadId: id,
                computerId: request.computerId,
                branch: `${WORKER_REF_PREFIX}${id}`,
                worktreePath: "/gpu3/owned-worker",
                parent: request.parent,
                modelSelection: request.modelSelection,
                enabledCapabilityIds: request.enabledCapabilityIds,
              },
            },
          });
        }),
    } as unknown as RemoteWorkerBroker["Service"];
    const remoteSources = input?.remoteSource
      ? (effect: ReturnType<typeof makeWorkerDispatchWithSources>) =>
          effect.pipe(
            Effect.provideService(RemoteWorkerBroker, broker),
            Effect.provideService(GitVcsDriver, {
              execute: () => Effect.succeed({ stdout: "a".repeat(40), stderr: "", exitCode: 0 }),
            } as unknown as GitVcsDriver["Service"]),
          )
      : (effect: ReturnType<typeof makeWorkerDispatchWithSources>) => effect;
    const providedSnapshotStore = yield* Effect.serviceOption(WorkjetSnapshotStore);
    const providedMeshIdentity = yield* Effect.serviceOption(WorkjetMeshIdentity);
    const delegationSources = (effect: ReturnType<typeof makeWorkerDispatchWithSources>) =>
      input?.missingDelegationStorage
        ? effect
        : effect.pipe(
            Effect.provideService(
              WorkjetSnapshotStore,
              Option.getOrElse(
                providedSnapshotStore,
                () =>
                  ({
                    put: (prompt: string) =>
                      Effect.succeed({
                        snapshotRef: WorkjetSealedPayloadRef.make("c25hcHNob3QtcmVmZXJlbmNlLTAwMQ"),
                        digest: WorkjetContentDigest.make("a".repeat(64)),
                        byteLength: prompt.length,
                      }),
                  }) as unknown as WorkjetSnapshotStore["Service"],
              ),
            ),
            Effect.provideService(
              WorkjetMeshIdentity,
              Option.getOrElse(
                providedMeshIdentity,
                () =>
                  ({
                    workspaceId: WorkjetMeshWorkspaceId.make("workspace-test"),
                    signRoutingEnvelope: (envelope: object) =>
                      Effect.succeed({ ...envelope, signature: "c2lnbmF0dXJlLXN0dWI" }),
                  }) as unknown as WorkjetMeshIdentity["Service"],
              ),
            ),
          );
    return yield* makeWorkerDispatchWithSources(sources).pipe(
      remoteSources,
      delegationSources,
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(OrchestrationCommandReceiptRepository, receipts),
      Effect.provideService(WorkjetMailboxStore, mailbox),
      Effect.provideService(ProjectionSnapshotQuery, query),
      Effect.provideService(GitWorkflowService, gitWorkflow),
      Effect.provideService(WorkerDispatchRollback, {
        prepare: (prepared) =>
          Effect.succeed(
            Effect.gen(function* () {
              worktreeRemovals.push({ cwd: prepared.cwd, path: prepared.worktreePath });
              if (input?.failWorktreeRemove) {
                return yield* new WorkerDispatchRollbackError({ reason: "changed" });
              }
              branchDeletions.push({ cwd: prepared.cwd, refName: prepared.branchRef });
              if (input?.failBranchDelete) {
                return yield* new WorkerDispatchRollbackError({ reason: "unavailable" });
              }
              return {
                originalWorktreePath: prepared.worktreePath,
                originalAdminPath: "/repo/.git/worktrees/worker",
                recoveryLocationStatus: "verified" as const,
                recoveryWorktreePath: `${prepared.worktreePath}.workjet-rejected-2`,
                recoveryAdminPath: "/repo/.git/workjet-rejected/worker-3",
              };
            }),
          ),
      }),
    );
  }).pipe(Effect.provide(worktreeStorageLayer));
  return {
    commands,
    dispatchOptions,
    service,
    remoteRequests,
    worktreeCreates,
    worktreeRemovals,
    branchDeletions,
  };
};

for (const failCreateAttempts of [0, 1, 2]) {
  it.effect(`dispatches a team delegation with ${failCreateAttempts} lost acknowledgements`, () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        currentParent: teamParent,
        failCreateAttempts,
        createReceiptStatus: failCreateAttempts === 2 ? "accepted" : "missing",
      });
      const storedPrompts: string[] = [];
      const service = yield* harness.service.pipe(
        Effect.provideService(WorkjetSnapshotStore, {
          put: (prompt: string) =>
            Effect.sync(() => {
              storedPrompts.push(prompt);
              return {
                snapshotRef: WorkjetSealedPayloadRef.make("c25hcHNob3QtcmVmZXJlbmNlLTAwMQ"),
                digest: WorkjetContentDigest.make("a".repeat(64)),
                byteLength: prompt.length,
              };
            }),
        } as unknown as WorkjetSnapshotStore["Service"]),
        Effect.provideService(WorkjetMeshIdentity, {
          workspaceId: WorkjetMeshWorkspaceId.make("workspace-test"),
          signRoutingEnvelope: (envelope: object) =>
            Effect.succeed({ ...envelope, signature: "c2lnbmF0dXJlLXN0dWI" }),
        } as unknown as WorkjetMeshIdentity["Service"]),
      );
      const result = yield* service.dispatch(invocation, {
        task: "Implement the complete assigned task.",
      });
      expect(storedPrompts).toEqual(["Implement the complete assigned task."]);
      expect(harness.commands.map((command) => command.type)).toEqual(
        Array.from({ length: Math.min(failCreateAttempts + 1, 2) }, () => "thread.create"),
      );
      expect(new Set(harness.commands.map((command) => command.commandId)).size).toBe(1);
      expect(
        harness.dispatchOptions.every(
          (options) => options?.workerDelegation === harness.dispatchOptions[0]?.workerDelegation,
        ),
      ).toBe(true);
      const prepared = harness.dispatchOptions[0]?.workerDelegation;
      expect(prepared?.delegation).toMatchObject({
        state: "queued",
        source: { threadId: parent.id, environmentId },
        target: { threadId: result.workerThreadId, environmentId },
      });
      expect(prepared?.envelope.envelopeId).toBe(prepared?.delegation.envelopeId);
      expect(harness.worktreeRemovals).toEqual([]);
    }),
  );
}

const workerRefFor = (threadId: string) => `${WORKER_REF_PREFIX}${threadId}`;
for (const receiptStatus of ["rejected", "missing", "unavailable"] as const) {
  it.effect(
    `reconciles two failed team create acknowledgements with a ${receiptStatus} receipt`,
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          currentParent: teamParent,
          failCreateAttempts: 2,
          createReceiptStatus: receiptStatus,
        });
        const service = yield* harness.service.pipe(
          Effect.provideService(WorkjetSnapshotStore, {
            put: (prompt: string) =>
              Effect.succeed({
                snapshotRef: WorkjetSealedPayloadRef.make("c25hcHNob3QtcmVmZXJlbmNlLTAwMQ"),
                digest: WorkjetContentDigest.make("a".repeat(64)),
                byteLength: prompt.length,
              }),
          } as unknown as WorkjetSnapshotStore["Service"]),
          Effect.provideService(WorkjetMeshIdentity, {
            workspaceId: WorkjetMeshWorkspaceId.make("workspace-test"),
            signRoutingEnvelope: (envelope: object) =>
              Effect.succeed({ ...envelope, signature: "c2lnbmF0dXJlLXN0dWI" }),
          } as unknown as WorkjetMeshIdentity["Service"]),
        );
        const error = yield* service
          .dispatch(invocation, { task: "Retain or remove only with a durable receipt." })
          .pipe(Effect.flip);
        expect(error.reason).toBe(
          receiptStatus === "rejected" ? "create-failed" : "rollback-failed",
        );
        expect(harness.commands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.create",
        ]);
        expect(harness.worktreeRemovals).toEqual(
          receiptStatus === "rejected"
            ? [{ cwd: parent.worktreePath, path: workerPathFor(ids[0]) }]
            : [],
        );
        expect(harness.branchDeletions).toEqual(
          receiptStatus === "rejected"
            ? [{ cwd: parent.worktreePath, refName: workerRefFor(ids[0]) }]
            : [],
        );
      }),
  );
}
for (const receiptStatus of ["missing", "unavailable"] as const) {
  for (const proof of [
    { committedDelegation: true, workerProjection: "matching" },
    { committedDelegation: true, workerProjection: "mismatched" },
    { committedDelegation: false, workerProjection: "matching" },
  ] as const) {
    it.effect(
      `reconciles a ${receiptStatus} receipt with delegation ${proof.committedDelegation} and ${proof.workerProjection} worker`,
      () =>
        Effect.gen(function* () {
          const harness = makeHarness({
            currentParent: teamParent,
            failCreateAttempts: 2,
            createReceiptStatus: receiptStatus,
            committedDelegation: proof.committedDelegation,
            workerProjection: proof.workerProjection,
          });
          const service = yield* harness.service.pipe(
            Effect.provideService(WorkjetSnapshotStore, {
              put: (prompt: string) =>
                Effect.succeed({
                  snapshotRef: WorkjetSealedPayloadRef.make("c25hcHNob3QtcmVmZXJlbmNlLTAwMQ"),
                  digest: WorkjetContentDigest.make("a".repeat(64)),
                  byteLength: prompt.length,
                }),
            } as unknown as WorkjetSnapshotStore["Service"]),
            Effect.provideService(WorkjetMeshIdentity, {
              workspaceId: WorkjetMeshWorkspaceId.make("workspace-test"),
              signRoutingEnvelope: (envelope: object) =>
                Effect.succeed({ ...envelope, signature: "c2lnbmF0dXJlLXN0dWI" }),
            } as unknown as WorkjetMeshIdentity["Service"]),
          );
          const dispatch = service.dispatch(invocation, { task: "Recover an accepted worker." });
          if (proof.committedDelegation && proof.workerProjection === "matching") {
            const result = yield* dispatch;
            expect(result.workerThreadId).toBe(ThreadId.make(ids[0]));
            expect(result.status).toBe("dispatched");
          } else {
            const error = yield* dispatch.pipe(Effect.flip);
            expect(error.reason).toBe("rollback-failed");
          }
          expect(harness.commands.map((command) => command.type)).toEqual([
            "thread.create",
            "thread.create",
          ]);
          expect(harness.worktreeRemovals).toEqual([]);
        }),
    );
  }
}
const workerPathFor = (threadId: string) =>
  `${worktreeRoot}/repository-hash/${workerRefFor(threadId).replace(/[^A-Za-z0-9._-]+/g, "-")}`;

it.effect("requires durable delegation storage before creating a local team worker checkout", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ missingDelegationStorage: true });
    const service = yield* harness.service;
    const error = yield* Effect.flip(
      service.dispatch(invocation, { task: "Never bypass the durable start." }),
    );
    expect(error.reason).toBe("create-failed");
    expect(harness.commands).toEqual([]);
    expect(harness.worktreeCreates).toEqual([]);
  }),
);

it.effect("atomically creates the worker and queues its first turn with inherited state", () =>
  Effect.gen(function* () {
    const { commands, service } = makeHarness();
    const workerDispatch = yield* service;
    const task = "Implement the bounded parser.\nDo not alter manifests.";
    const result = yield* workerDispatch.dispatch(invocation, { task });

    expect(result).toEqual({
      schemaVersion: 1,
      status: "dispatched",
      environmentId,
      workerThreadId: ThreadId.make(ids[0]),
      branch: workerRefFor(ids[0]),
      worktreePath: workerPathFor(ids[0]),
      parent: { environmentId, threadId: parentThreadId },
      modelSelection: inheritedModel,
      enabledCapabilityIds: ["greppy", "web-search"],
    });
    expect(commands).toEqual([
      {
        type: "thread.create",
        commandId: ids[1],
        threadId: ids[0],
        projectId: parent.projectId,
        title: deriveWorkerTitle(1, parent.title, inheritedModel.model),
        modelSelection: inheritedModel,
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
        workjetConfig: {
          schemaVersion: 2,
          role: "worker",
          parent: { environmentId, threadId: parentThreadId },
          managedInstructions: "Keep changes bounded.",
          enabledCapabilityIds: ["greppy", "web-search"],
          capabilityBindings: [],
          team: {
            projectId: parent.projectId,
            threadId: ThreadId.make(ids[0]),
            role: "worker",
            parentThreadId,
            packageId: ThreadId.make(ids[0]),
            goal: task,
            createdAt: now,
          },
        },
        branch: workerRefFor(ids[0]),
        worktreePath: workerPathFor(ids[0]),
        createdAt: now,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(task);
  }),
);

it.effect("returns the explicitly selected native computer and actual isolated checkout", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const service = yield* harness.service;
    const result = yield* service.dispatch(invocation, {
      task: "Implement one pull request.",
      computerId: localComputer.id,
    });
    expect(result).toMatchObject({
      computerId: localComputer.id,
      environmentId,
      branch: workerRefFor(ids[0]),
      worktreePath: workerPathFor(ids[0]),
    });
    expect(harness.commands[0]).toMatchObject({
      branch: result.branch,
      worktreePath: result.worktreePath,
    });
  }).pipe(Effect.provide(computerCatalogLayer)),
);

it.effect("infers only an unambiguous current-environment computer", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const service = yield* harness.service;
    const result = yield* service.dispatch(invocation, {
      task: "Use the native current computer.",
    });
    expect(result.computerId).toBe(localComputer.id);
  }).pipe(Effect.provide(computerCatalogLayer)),
);

for (const [computerId, reason] of [
  [WorkjetComputerId.make("missing-computer"), "computer-unavailable"],
  [remoteComputer.id, "remote-dispatch-unavailable"],
] as const) {
  it.effect(`rejects ${reason} before creating a checkout or thread`, () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const service = yield* harness.service;
      const error = yield* service
        .dispatch(invocation, {
          task: "COMPUTER_TASK_CANARY",
          computerId,
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe(reason);
      expect(JSON.stringify(error)).not.toContain("COMPUTER_TASK_CANARY");
      expect(harness.worktreeCreates).toEqual([]);
      expect(harness.commands).toEqual([]);
    }).pipe(Effect.provide(computerCatalogLayer)),
  );
}

it.effect("never treats an explicit computer as local when its native catalog is absent", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const service = yield* harness.service;
    const error = yield* service
      .dispatch(invocation, {
        task: "Do not guess placement.",
        computerId: localComputer.id,
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("computer-unavailable");
    expect(harness.worktreeCreates).toEqual([]);
    expect(harness.commands).toEqual([]);
  }),
);

it.effect("rechecks native selection and honors an explicit local override", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const settings = yield* ServerSettingsService;
    const service = yield* harness.service;
    const first = yield* service.dispatch(invocation, { task: "Use the current saved computer." });
    expect(first.computerId).toBe(localComputer.id);
    const createdBefore = harness.worktreeCreates.length;
    const current = yield* settings.getSettings;
    yield* settings.updateSettings({
      workjet: { ...current.workjet, selectedComputerId: remoteComputer.id },
    });
    const error = yield* service
      .dispatch(invocation, {
        task: "Do not fall back locally after selection changes.",
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("remote-dispatch-unavailable");
    expect(harness.worktreeCreates).toHaveLength(createdBefore);
    const explicit = yield* service.dispatch(invocation, {
      task: "Use the explicitly chosen local computer.",
      computerId: localComputer.id,
    });
    expect(explicit.computerId).toBe(localComputer.id);
  }).pipe(Effect.provide(computerCatalogLayer)),
);

it.effect("accepts a capability subset and canonical model override including options", () =>
  Effect.gen(function* () {
    const { commands, service } = makeHarness();
    const workerDispatch = yield* service;
    const override = {
      instanceId: ProviderInstanceId.make("claude-team"),
      model: "claude-opus-4-6",
      options: [
        { id: "effort", value: "max" },
        { id: "fast", value: true },
      ],
    } as const satisfies ModelSelection;

    const result = yield* workerDispatch.dispatch(invocation, {
      task: "Review the implementation.",
      title: "  Focused review  ",
      enabledCapabilityIds: ["web-search"],
      modelSelection: override,
    });

    expect(result.modelSelection).toEqual(override);
    expect(result.enabledCapabilityIds).toEqual(["web-search"]);
    expect(commands[0]).toMatchObject({
      title: deriveWorkerTitle(1, parent.title, override.model),
      modelSelection: override,
      workjetConfig: { enabledCapabilityIds: ["web-search"] },
    });
  }),
);

it.effect("rejects duplicate and escalating capability delegation before creating a thread", () =>
  Effect.gen(function* () {
    for (const [enabledCapabilityIds, reason] of [
      [["greppy", "greppy"], "duplicate-capabilities"],
      [["web-stack-browser"], "capability-escalation"],
    ] as const) {
      const { commands, service } = makeHarness();
      const workerDispatch = yield* service;
      const error = yield* workerDispatch
        .dispatch(invocation, { task: "Bounded task", enabledCapabilityIds })
        .pipe(Effect.flip);
      expect(error.reason).toBe(reason);
      expect(commands).toEqual([]);
    }
  }),
);

it.effect("never delegates Decision Hub or its CTOX binding to a child worker", () =>
  Effect.gen(function* () {
    const decisionParent = {
      ...parent,
      workjetConfig: {
        schemaVersion: 2,
        role: "orchestrator",
        parent: null,
        managedInstructions: "Keep changes bounded.",
        enabledCapabilityIds: ["greppy", "decision-hub"],
        team: parent.workjetConfig.schemaVersion === 2 ? parent.workjetConfig.team : undefined,
        capabilityBindings: [
          {
            capabilityId: "decision-hub",
            target: { kind: "ctox-connection", connectionId: "ctox-dev:tenant-1" },
          },
        ],
      },
    } as unknown as OrchestrationThread;

    const implicit = makeHarness({ currentParent: decisionParent });
    const service = yield* implicit.service;
    const result = yield* service.dispatch(invocation, { task: "Inspect a bounded slice." });
    expect(result.enabledCapabilityIds).toEqual(["greppy"]);
    expect(implicit.commands[0]).toMatchObject({
      workjetConfig: { enabledCapabilityIds: ["greppy"], capabilityBindings: [] },
    });

    const explicit = makeHarness({ currentParent: decisionParent });
    const explicitService = yield* explicit.service;
    const error = yield* explicitService
      .dispatch(invocation, {
        task: "Try an explicitly forbidden grant.",
        enabledCapabilityIds: ["decision-hub"],
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("capability-escalation");
    expect(explicit.commands).toEqual([]);
  }),
);

it.effect(
  "revalidates the persisted parent role and fails missing or unreadable parents safely",
  () =>
    Effect.gen(function* () {
      const staleParent = {
        ...parent,
        workjetConfig: { ...parent.workjetConfig, role: "standard", parent: null, team: undefined },
      } as unknown as OrchestrationThread;
      for (const [harnessInput, reason] of [
        [{ currentParent: staleParent }, "parent-not-orchestrator"],
        [{ currentParent: undefined }, "parent-unavailable"],
        [{ queryFails: true }, "parent-unavailable"],
      ] as const) {
        const { commands, service } = makeHarness(harnessInput);
        const workerDispatch = yield* service;
        const error = yield* workerDispatch
          .dispatch(invocation, { task: "Do not leak this task canary." })
          .pipe(Effect.flip);
        expect(error.reason).toBe(reason);
        expect(JSON.stringify(error)).not.toContain("task canary");
        expect(JSON.stringify(error)).not.toContain("sensitive SQL text");
        expect(commands).toEqual([]);
      }
    }),
);

it.effect("a project supervisor dispatches an isolated leaf with its durable parent binding", () =>
  Effect.gen(function* () {
    const supervisor = {
      ...teamParent,
      workjetConfig: {
        ...teamConfig,
        team: {
          projectId: parent.projectId,
          threadId: parent.id,
          role: "supervisor" as const,
          parentThreadId: null,
          goal: "Coordinate the project",
          createdAt: now,
        },
      },
    } as OrchestrationThread;
    const harness = makeHarness({ currentParent: supervisor });
    const service = yield* harness.service.pipe(
      Effect.provideService(WorkjetSnapshotStore, {
        put: (prompt: string) =>
          Effect.succeed({
            snapshotRef: WorkjetSealedPayloadRef.make("c25hcHNob3QtcmVmZXJlbmNlLTAwMQ"),
            digest: WorkjetContentDigest.make("a".repeat(64)),
            byteLength: prompt.length,
          }),
      } as unknown as WorkjetSnapshotStore["Service"]),
      Effect.provideService(WorkjetMeshIdentity, {
        workspaceId: WorkjetMeshWorkspaceId.make("workspace-test"),
        signRoutingEnvelope: (envelope: object) =>
          Effect.succeed({ ...envelope, signature: "c2lnbmF0dXJlLXN0dWI" }),
      } as unknown as WorkjetMeshIdentity["Service"]),
    );
    const result = yield* service.dispatch(invocation, { task: "Implement one bounded PR." });
    expect(result.parent).toEqual({ environmentId, threadId: parent.id });
    expect(harness.worktreeCreates).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.create",
      workjetConfig: {
        role: "worker",
        parent: { environmentId, threadId: parent.id },
        team: {
          role: "worker",
          projectId: parent.projectId,
          parentThreadId: parent.id,
          threadId: result.workerThreadId,
        },
      },
    });
    expect(harness.dispatchOptions[0]?.workerDelegation?.delegation).toMatchObject({
      source: { threadId: parent.id },
      target: { threadId: result.workerThreadId },
      budget: { maxDepth: 1 },
    });
  }),
);

it.effect("a team worker cannot redelegate through a stale orchestrator role", () =>
  Effect.gen(function* () {
    const worker = {
      ...teamParent,
      workjetConfig: {
        ...teamConfig,
        team: {
          ...teamConfig.team,
          role: "worker" as const,
          packageId: parent.id,
        },
      },
    } as OrchestrationThread;
    const harness = makeHarness({ currentParent: worker });
    const service = yield* harness.service;
    const error = yield* service
      .dispatch(invocation, { task: "Do not redelegate." })
      .pipe(Effect.flip);
    expect(error.reason).toBe("parent-not-orchestrator");
    expect(harness.worktreeCreates).toEqual([]);
    expect(harness.commands).toEqual([]);
  }),
);

it.effect("uses the current team role regardless of a legacy provider role switch", () =>
  Effect.gen(function* () {
    for (const workjetRole of ["standard", "worker", undefined] as const) {
      const { commands, service } = makeHarness();
      const workerDispatch = yield* service;
      const { workjetRole: _role, ...invocationWithoutRole } = invocation;
      const result = yield* workerDispatch.dispatch(
        {
          ...invocationWithoutRole,
          ...(workjetRole === undefined ? {} : { workjetRole }),
        },
        { task: "Bounded package." },
      );
      expect(result.status).toBe("dispatched");
      expect(commands[0]?.type).toBe("thread.create");
    }
  }),
);

it.effect(
  "retains a failed atomic create and leaves first-turn execution to the durable executor",
  () =>
    Effect.gen(function* () {
      const createFailure = makeHarness({ failCommandTypes: ["thread.create"] });
      const createService = yield* createFailure.service;
      const createError = yield* createService
        .dispatch(invocation, { task: "Sensitive create task." })
        .pipe(Effect.flip);
      expect(createError.reason).toBe("rollback-failed");
      expect(createFailure.commands.map(({ type }) => type)).toEqual([
        "thread.create",
        "thread.create",
      ]);

      const turnFailure = makeHarness({ failCommandTypes: ["thread.turn.start"] });
      const turnService = yield* turnFailure.service;
      const turnResult = yield* turnService.dispatch(invocation, { task: "Sensitive turn task." });
      expect(turnResult.status).toBe("dispatched");
      expect(turnFailure.commands.map(({ type }) => type)).toEqual(["thread.create"]);
      expect(JSON.stringify(turnResult)).not.toContain("Sensitive turn task");

      const rollbackFailure = makeHarness({
        failCommandTypes: ["thread.turn.start", "thread.delete"],
        turnReceiptStatus: "rejected",
      });
      const rollbackService = yield* rollbackFailure.service;
      const rollbackResult = yield* rollbackService.dispatch(invocation, {
        task: "Sensitive rollback task.",
      });
      expect(rollbackResult.status).toBe("dispatched");
      expect(rollbackFailure.worktreeRemovals).toEqual([]);
      expect(rollbackFailure.branchDeletions).toEqual([]);
      expect(JSON.stringify(rollbackResult)).not.toContain("Sensitive rollback task");
    }),
);

it.effect("creates one isolated worker worktree beneath the configured storage root", () =>
  Effect.gen(function* () {
    const { commands, worktreeCreates, worktreeRemovals, branchDeletions, service } = makeHarness();
    const workerDispatch = yield* service;

    yield* workerDispatch.dispatch(invocation, { task: "Bounded worker task." });

    expect(worktreeCreates).toEqual([
      {
        cwd: parent.worktreePath,
        // Branched from the orchestrator's current ref.
        refName: "feature/work",
        newRefName: workerRefFor(ids[0]),
        path: workerPathFor(ids[0]),
      },
    ]);
    expect(worktreeCreates[0]!.path.startsWith(`${worktreeRoot}/`)).toBe(true);
    // The parent checkout and ref stay exactly as they were.
    expect(worktreeCreates[0]!.path).not.toBe(parent.worktreePath);
    expect(worktreeRemovals).toEqual([]);
    // A successful dispatch keeps its ref; only the durable deletion boundary
    // (ThreadDeletionReactor) or a rollback releases it.
    expect(branchDeletions).toEqual([]);
    expect(commands[0]).toMatchObject({
      type: "thread.create",
      branch: workerRefFor(ids[0]),
      worktreePath: workerPathFor(ids[0]),
    });
    expect(parent.worktreePath).toBe("/workspace/worktree");
    expect(parent.branch).toBe("feature/work");
  }),
);

it.effect("gives two dispatches disjoint worktrees and refs", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const workerDispatch = yield* harness.service;
    yield* workerDispatch.dispatch(invocation, { task: "First worker." });
    yield* workerDispatch.dispatch(invocation, { task: "Second worker." });

    expect(harness.worktreeCreates).toHaveLength(2);
    const [firstCreate, secondCreate] = harness.worktreeCreates as [
      WorktreeCreateRecord,
      WorktreeCreateRecord,
    ];
    expect(firstCreate.cwd).toBe(secondCreate.cwd);
    // Same parent checkout, but never the same worker checkout or ref.
    expect(firstCreate.newRefName).not.toBe(secondCreate.newRefName);
    expect(firstCreate.path).not.toBe(secondCreate.path);
    for (const created of [firstCreate, secondCreate]) {
      expect(created.path.startsWith(`${worktreeRoot}/`)).toBe(true);
      expect(created.path).not.toBe(parent.worktreePath);
    }
  }),
);

it.effect("fails bounded when the isolated worker worktree cannot be created", () =>
  Effect.gen(function* () {
    const { commands, worktreeRemovals, service } = makeHarness({ failWorktreeCreate: true });
    const workerDispatch = yield* service;

    const error = yield* workerDispatch
      .dispatch(invocation, { task: "Sensitive worktree task." })
      .pipe(Effect.flip);

    expect(error.reason).toBe("worktree-failed");
    expect(JSON.stringify(error)).not.toContain("downstream git secret");
    expect(JSON.stringify(error)).not.toContain("Sensitive worktree task");
    // Nothing was created, so nothing may be removed.
    expect(commands).toEqual([]);
    expect(worktreeRemovals).toEqual([]);
  }),
);

it.effect("retains checkout and ref when rollback cannot safely remove them", () =>
  Effect.gen(function* () {
    const turnFailure = makeHarness({ failCommandTypes: ["thread.turn.start"] });
    const turnService = yield* turnFailure.service;
    const turnResult = yield* turnService.dispatch(invocation, { task: "Rolled back task." });
    expect(turnResult.status).toBe("dispatched");
    expect(turnFailure.worktreeRemovals).toEqual([]);
    expect(turnFailure.branchDeletions).toEqual([]);

    // A rejected create leaves the checkout and ref available for recovery.
    const createFailure = makeHarness({ failCommandTypes: ["thread.create"] });
    const createService = yield* createFailure.service;
    const createError = yield* createService
      .dispatch(invocation, { task: "Create failure task." })
      .pipe(Effect.flip);
    expect(createError.reason).toBe("rollback-failed");
    expect(createFailure.worktreeRemovals).toEqual([]);
    expect(createFailure.branchDeletions).toEqual([]);
  }),
);

for (const stage of ["create"] as const) {
  it.effect(`rolls back a durably rejected ${stage} before returning its bounded error`, () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        failCommandTypes: [stage === "create" ? "thread.create" : "thread.turn.start"],
        createReceiptStatus: "rejected",
        turnReceiptStatus: "rejected",
      });
      const service = yield* harness.service;
      const error = yield* service
        .dispatch(invocation, { task: "Rejected worker." })
        .pipe(Effect.flip);
      expect(error.reason).toBe(stage === "create" ? "create-failed" : "turn-start-failed");
      expect(harness.worktreeRemovals).toEqual([
        { cwd: parent.worktreePath, path: workerPathFor(ids[0]) },
      ]);
      expect(harness.branchDeletions).toEqual([
        { cwd: parent.worktreePath, refName: workerRefFor(ids[0]) },
      ]);
      expect(harness.commands.map(({ type }) => type)).toEqual(["thread.create", "thread.create"]);
    }),
  );
}

it.effect("keeps an accepted atomic worker create after its acknowledgement is lost", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      failCommandTypes: ["thread.create"],
      createReceiptStatus: "accepted",
    });
    const service = yield* harness.service;
    const result = yield* service.dispatch(invocation, { task: "Accepted, not acknowledged." });
    expect(result.status).toBe("dispatched");
    expect(harness.commands.map(({ type }) => type)).toEqual(["thread.create", "thread.create"]);
    expect(harness.worktreeRemovals).toEqual([]);
    expect(harness.branchDeletions).toEqual([]);
  }),
);

it.effect("keeps a checkout already owned by another projected thread", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      failCommandTypes: ["thread.create"],
      createReceiptStatus: "rejected",
      workerProjection: "matching",
    });
    const service = yield* harness.service;
    const error = yield* service
      .dispatch(invocation, { task: "Conflicting owner." })
      .pipe(Effect.flip);
    expect(error.reason).toBe("rollback-failed");
    expect(harness.worktreeRemovals).toEqual([]);
    expect(harness.branchDeletions).toEqual([]);
  }),
);
