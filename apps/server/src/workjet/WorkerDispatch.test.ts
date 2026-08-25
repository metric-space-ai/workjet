// @effect-diagnostics preferSchemaOverJson:off -- redaction assertions inspect complete bounded results.
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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
    schemaVersion: 1,
    role: "orchestrator",
    parent: null,
    managedInstructions: "Keep changes bounded.",
    enabledCapabilityIds: ["greppy", "web-search"],
  },
  branch: "feature/work",
  worktreePath: "/workspace/worktree",
  deletedAt: null,
} as unknown as OrchestrationThread;
const invocation: McpInvocationScope = {
  environmentId,
  threadId: parentThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex-main"),
  capabilities: new Set(["preview"]),
  workjetRole: "orchestrator",
  issuedAt: 1,
};
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
  readonly queryFails?: boolean;
  readonly failCommandTypes?: ReadonlyArray<OrchestrationCommand["type"]>;
  readonly failWorktreeCreate?: boolean;
  readonly failWorktreeRemove?: boolean;
  readonly failBranchDelete?: boolean;
}) => {
  const commands: Array<OrchestrationCommand> = [];
  const worktreeCreates: Array<WorktreeCreateRecord> = [];
  const worktreeRemovals: Array<{ readonly cwd: string; readonly path: string }> = [];
  const branchDeletions: Array<{ readonly cwd: string; readonly refName: string }> = [];
  let idIndex = 0;
  const sources: WorkerDispatchSources = {
    // Deterministic and unbounded, so a second dispatch in the same harness gets
    // genuinely fresh identifiers instead of reusing the first worker's id.
    randomUUID: Effect.sync(() => nthId(idIndex++)),
    nowIso: Effect.succeed(now),
  };
  const engine = {
    dispatch: (command: OrchestrationCommand) => {
      commands.push(command);
      return input?.failCommandTypes?.includes(command.type)
        ? Effect.fail({
            _tag: "DownstreamTestError",
            message: `downstream secret for ${command.type}`,
          } as const)
        : Effect.succeed({ sequence: commands.length });
    },
  } as unknown as OrchestrationEngineService["Service"];
  const query = {
    getThreadDetailById: () =>
      input?.queryFails
        ? Effect.fail({ _tag: "QueryTestError", message: "sensitive SQL text" } as const)
        : Effect.succeed(
            input && "currentParent" in input
              ? input.currentParent === undefined
                ? Option.none()
                : Option.some(input.currentParent)
              : Option.some(parent),
          ),
    getProjectShellById: () => Effect.succeed(Option.some({ workspaceRoot })),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const gitCommandFailure = {
    _tag: "GitCommandError",
    detail: "downstream git secret",
  } as const;
  const service = Effect.gen(function* () {
    const storage = yield* WorktreeStorage;
    const gitWorkflow = {
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
      removeWorktree: (removeInput: { readonly cwd: string; readonly path: string }) => {
        worktreeRemovals.push({ cwd: removeInput.cwd, path: removeInput.path });
        return input?.failWorktreeRemove ? Effect.fail(gitCommandFailure) : Effect.void;
      },
      deleteBranch: (deleteInput: { readonly cwd: string; readonly refName: string }) => {
        branchDeletions.push({ cwd: deleteInput.cwd, refName: deleteInput.refName });
        return input?.failBranchDelete ? Effect.fail(gitCommandFailure) : Effect.void;
      },
    } as unknown as GitWorkflowService["Service"];
    return yield* makeWorkerDispatchWithSources(sources).pipe(
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(ProjectionSnapshotQuery, query),
      Effect.provideService(GitWorkflowService, gitWorkflow),
    );
  }).pipe(Effect.provide(worktreeStorageLayer));
  return { commands, service, worktreeCreates, worktreeRemovals, branchDeletions };
};

const workerRefFor = (threadId: string) => `${WORKER_REF_PREFIX}${threadId}`;
const workerPathFor = (threadId: string) =>
  `${worktreeRoot}/repository-hash/${workerRefFor(threadId).replace(/[^A-Za-z0-9._-]+/g, "-")}`;

it.effect("dispatches exact normal create and turn-start commands with inherited state", () =>
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
        title: deriveWorkerTitle(task),
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
        },
        branch: workerRefFor(ids[0]),
        worktreePath: workerPathFor(ids[0]),
        createdAt: now,
      },
      {
        type: "thread.turn.start",
        commandId: ids[2],
        threadId: ids[0],
        message: {
          messageId: ids[3],
          role: "user",
          text: task,
          attachments: [],
        },
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
        createdAt: now,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(task);
  }),
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
      title: "Focused review",
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
        workjetConfig: { ...parent.workjetConfig, role: "standard", parent: null },
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

it.effect("denies a stale invocation role even when the persisted parent is an orchestrator", () =>
  Effect.gen(function* () {
    for (const workjetRole of ["standard", "worker", undefined] as const) {
      const { commands, service } = makeHarness();
      const workerDispatch = yield* service;
      const { workjetRole: _role, ...invocationWithoutRole } = invocation;
      const scoped = {
        ...invocationWithoutRole,
        ...(workjetRole === undefined ? {} : { workjetRole }),
      };
      const error = yield* workerDispatch
        .dispatch(scoped, { task: "Secret denied task." })
        .pipe(Effect.flip);
      expect(error.reason).toBe("role-not-authorized");
      expect(JSON.stringify(error)).not.toContain("Secret denied task");
      expect(commands).toEqual([]);
    }
  }),
);

it.effect("does not delete after create failure and rolls back bounded turn-start failures", () =>
  Effect.gen(function* () {
    const createFailure = makeHarness({ failCommandTypes: ["thread.create"] });
    const createService = yield* createFailure.service;
    const createError = yield* createService
      .dispatch(invocation, { task: "Sensitive create task." })
      .pipe(Effect.flip);
    expect(createError.reason).toBe("create-failed");
    expect(createFailure.commands.map(({ type }) => type)).toEqual(["thread.create"]);

    const turnFailure = makeHarness({ failCommandTypes: ["thread.turn.start"] });
    const turnService = yield* turnFailure.service;
    const turnError = yield* turnService
      .dispatch(invocation, { task: "Sensitive turn task." })
      .pipe(Effect.flip);
    expect(turnError.reason).toBe("turn-start-failed");
    expect(turnFailure.commands.map(({ type }) => type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.delete",
    ]);
    expect(turnFailure.commands[2]).toEqual({
      type: "thread.delete",
      commandId: ids[4],
      threadId: ids[0],
    });
    expect(JSON.stringify(turnError)).not.toContain("downstream secret");
    expect(JSON.stringify(turnError)).not.toContain("Sensitive turn task");

    const rollbackFailure = makeHarness({
      failCommandTypes: ["thread.turn.start", "thread.delete"],
    });
    const rollbackService = yield* rollbackFailure.service;
    const rollbackError = yield* rollbackService
      .dispatch(invocation, { task: "Sensitive rollback task." })
      .pipe(Effect.flip);
    expect(rollbackError.reason).toBe("rollback-failed");
    expect(JSON.stringify(rollbackError)).not.toContain("downstream secret");
    expect(JSON.stringify(rollbackError)).not.toContain("Sensitive rollback task");
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

it.effect("removes only the worktree this dispatch created when rollback runs", () =>
  Effect.gen(function* () {
    const turnFailure = makeHarness({ failCommandTypes: ["thread.turn.start"] });
    const turnService = yield* turnFailure.service;
    const turnError = yield* turnService
      .dispatch(invocation, { task: "Rolled back task." })
      .pipe(Effect.flip);

    expect(turnError.reason).toBe("turn-start-failed");
    expect(turnFailure.worktreeRemovals).toEqual([
      { cwd: parent.worktreePath, path: workerPathFor(ids[0]) },
    ]);
    // `git worktree remove` leaves the branch behind, so the rollback must
    // delete this dispatch's own worker ref too — and only that one.
    expect(turnFailure.branchDeletions).toEqual([
      { cwd: parent.worktreePath, refName: workerRefFor(ids[0]) },
    ]);
    // The orchestrator's own worktree and ref are never removal targets.
    expect(turnFailure.worktreeRemovals.some(({ path }) => path === parent.worktreePath)).toBe(
      false,
    );
    expect(turnFailure.branchDeletions.some(({ refName }) => refName === parent.branch)).toBe(
      false,
    );

    // A create failure must not leak the worktree or the ref either.
    const createFailure = makeHarness({ failCommandTypes: ["thread.create"] });
    const createService = yield* createFailure.service;
    const createError = yield* createService
      .dispatch(invocation, { task: "Create failure task." })
      .pipe(Effect.flip);
    expect(createError.reason).toBe("create-failed");
    expect(createFailure.worktreeRemovals).toEqual([
      { cwd: parent.worktreePath, path: workerPathFor(ids[0]) },
    ]);
    expect(createFailure.branchDeletions).toEqual([
      { cwd: parent.worktreePath, refName: workerRefFor(ids[0]) },
    ]);

    // A failed worktree removal is reported as a rollback failure.
    const removeFailure = makeHarness({
      failCommandTypes: ["thread.turn.start"],
      failWorktreeRemove: true,
    });
    const removeService = yield* removeFailure.service;
    const removeError = yield* removeService
      .dispatch(invocation, { task: "Removal failure task." })
      .pipe(Effect.flip);
    expect(removeError.reason).toBe("rollback-failed");
    expect(JSON.stringify(removeError)).not.toContain("downstream git secret");
    // A failed worktree removal short-circuits before the ref delete.
    expect(removeFailure.branchDeletions).toEqual([]);

    // A failed ref deletion is a rollback failure too: the dangling ref is the
    // exact leak this path exists to prevent.
    const branchFailure = makeHarness({
      failCommandTypes: ["thread.turn.start"],
      failBranchDelete: true,
    });
    const branchService = yield* branchFailure.service;
    const branchError = yield* branchService
      .dispatch(invocation, { task: "Branch failure task." })
      .pipe(Effect.flip);
    expect(branchError.reason).toBe("rollback-failed");
    expect(branchFailure.branchDeletions).toEqual([
      { cwd: parent.worktreePath, refName: workerRefFor(ids[0]) },
    ]);
    expect(JSON.stringify(branchError)).not.toContain("downstream git secret");
  }),
);
