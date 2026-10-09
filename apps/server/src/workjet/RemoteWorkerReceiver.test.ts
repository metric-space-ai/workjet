it.effect("requires an installed source route before creating a Claude worker checkout", () =>
  Effect.gen(function* () {
    const h = harness();
    const service = yield* h.receiver;
    expect(
      (yield* Effect.flip(service.receive({ ...request, harness: "claude-code" }))).reason,
    ).toBe("source-unavailable");
    expect(h.worktreeCalls).toEqual([]);
    expect(h.commands).toEqual([]);
  }),
);
it("selects the commissioned target driver and preserves its pinned model options", () => {
  const claude = {
    ...request,
    harness: "claude-code" as const,
    modelSelection: {
      ...request.modelSelection,
      options: [{ id: "effort", value: "high" }],
    },
  };
  const source = { harness: "claude-code" as const, model: request.modelSelection.model };
  const instance = (id: string, driverKind: "codex" | "claudeAgent", enabled = true) => ({
    instanceId: ProviderInstanceId.make(id),
    driverKind: ProviderDriverKind.make(driverKind),
    enabled,
  });
  const candidates = [instance("codex", "codex"), instance("target-claude", "claudeAgent")];
  expect(remoteWorkerRuntimeSelection(claude, source, candidates)).toEqual({
    ...claude.modelSelection,
    instanceId: candidates[1]!.instanceId,
  });
  expect(remoteWorkerRuntimeSelection(claude, source, [candidates[0]!])).toBeUndefined();
  expect(
    remoteWorkerRuntimeSelection(claude, source, [instance("disabled", "claudeAgent", false)]),
  ).toBeUndefined();
  expect(
    remoteWorkerRuntimeSelection(claude, source, [
      instance("a", "claudeAgent"),
      instance("b", "claudeAgent"),
    ]),
  ).toBeUndefined();
  expect(remoteWorkerRuntimeSelection(request, source, candidates)).toBeUndefined();
});
// @effect-diagnostics preferSchemaOverJson:off -- immutable request comparisons in an in-memory receipt fixture.
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  WorkjetComputerId,
  RemoteWorkerDispatchError,
  type OrchestrationCommand,
  type RemoteWorkerRequest,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationDispatchOptions,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceipt,
} from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { GitVcsDriver, type ExecuteGitInput } from "../vcs/GitVcsDriver.ts";
import { WorktreeStorage } from "../worktree/WorktreeStorage.ts";
import { RemoteWorkerStore, type RemoteWorkerReceipt } from "./RemoteWorkerStore.ts";
import {
  make,
  RemoteWorkerAdmission,
  remoteWorkerCommandId,
  remoteWorkerRuntimeSelection,
  remoteWorkerRepositoryUrl,
} from "./RemoteWorkerReceiver.ts";
import { WorkerDispatchRollback } from "./WorkerDispatchRollback.ts";

const target = EnvironmentId.make("gpu3");
const source = EnvironmentId.make("mac");
const request: RemoteWorkerRequest = {
  schemaVersion: 1,
  requestId: ThreadId.make("00000000-0000-4000-8000-000000000001"),
  targetEnvironmentId: target,
  computerId: WorkjetComputerId.make("gpu3-computer"),
  parent: { environmentId: source, threadId: ThreadId.make("parent") },
  parentTeamRole: "specialist",
  parentCapabilityIds: ["greppy"],
  enabledCapabilityIds: ["greppy"],
  managedInstructions: "Bounded leaf worker.",
  project: {
    id: ProjectId.make("source-project"),
    title: "Project",
    repository: {
      canonicalKey: "github.com/example/project",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/project.git",
      },
      rootPath: "/source/private-checkout",
    },
  },
  revision: "a".repeat(40),
  task: "Implement one PR",
  title: "Worker",
  modelSelection: { instanceId: ProviderInstanceId.make("native-model"), model: "gpt-6.1-sol" },
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  createdAt: "2026-10-07T12:00:00.000Z",
  expiresAt: "2099-10-07T12:00:00.000Z",
};
const workerPath = "/target/storage/project/worker";
const projectPath = "/target/project";
const harness = (
  options: {
    missingProject?: boolean;
    missingAdmission?: boolean;
    wrongRepository?: boolean;
    outsideWorker?: boolean;
    failStep?: "create" | "turn" | "delete";
    receiptOnFailure?: "accepted" | "rejected";
    failCompleteOnce?: boolean;
    preexistingWorktree?: string;
    preexistingBranch?: boolean;
    failWorktreeOnce?: boolean;
  } = {},
) => {
  let saved: RemoteWorkerReceipt | undefined;
  let registeredPath = options.preexistingWorktree;
  let checkoutHead = request.revision;
  let checkoutDirty = false;
  let worktreeFailures = options.failWorktreeOnce ? 1 : 0;
  const rollbackPrepares: string[] = [];
  let threadExists = false;
  let completeFailures = options.failCompleteOnce ? 1 : 0;
  const commandReceipts = new Map<string, OrchestrationCommandReceipt>();
  const commands: Array<{ command: OrchestrationCommand; options?: OrchestrationDispatchOptions }> =
    [];
  const gitCalls: ExecuteGitInput[] = [];
  const worktreeCalls: Array<{ cwd: string; path: string | null }> = [];
  const rollbackCalls: string[] = [];
  const store = RemoteWorkerStore.of({
    put: (_, input) =>
      Effect.gen(function* () {
        if (saved && !NodeUtil.isDeepStrictEqual(saved.request, input))
          return yield* new RemoteWorkerDispatchError({ reason: "request-conflict" });
        saved ??= { request: input, response: null, worktreePath: null };
      }),
    get: () => Effect.succeed(Option.fromUndefinedOr(saved)),
    pendingOutbound: Effect.succeed([]),
    recordWorktree: (_, path) =>
      Effect.sync(() => {
        saved = { ...saved!, worktreePath: path };
      }),
    complete: (_, response) =>
      Effect.gen(function* () {
        if (completeFailures > 0) {
          completeFailures--;
          return yield* new RemoteWorkerDispatchError({ reason: "source-unavailable" });
        }
        saved = { ...saved!, response };
      }),
  });
  const engine = {
    dispatch: (command: OrchestrationCommand, dispatchOptions?: OrchestrationDispatchOptions) =>
      Effect.gen(function* () {
        commands.push({ command, ...(dispatchOptions ? { options: dispatchOptions } : {}) });
        const step =
          command.type === "thread.create"
            ? "create"
            : command.type === "thread.turn.start"
              ? "turn"
              : command.type === "thread.delete"
                ? "delete"
                : "project";
        const failing = step === options.failStep;
        const status = failing ? options.receiptOnFailure : "accepted";
        if (status)
          commandReceipts.set(command.commandId, {
            commandId: command.commandId,
            aggregateKind: step === "project" ? "project" : "thread",
            aggregateId: step === "project" ? request.project.id : request.requestId,
            status,
            resultSequence: 1,
            error: null,
            acceptedAt: request.createdAt,
          });
        if (status === "accepted" && step === "create") threadExists = true;
        if (status === "accepted" && step === "delete") threadExists = false;
        if (failing)
          return yield* Effect.fail({ _tag: "DispatchError", message: "lost acknowledgement" });
        return { sequence: commands.length };
      }),
  } as unknown as OrchestrationEngineService["Service"];
  const query = {
    getProjectShellById: () =>
      Effect.succeed(
        options.missingProject ? Option.none() : Option.some({ workspaceRoot: projectPath }),
      ),
    getThreadDetailById: () =>
      Effect.succeed(threadExists ? Option.some({ worktreePath: registeredPath }) : Option.none()),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const git = {
    execute: (input: ExecuteGitInput) =>
      Effect.sync(() => {
        gitCalls.push(input);
        let stdout = "";
        if (input.args[0] === "rev-parse") stdout = projectPath + "/.git";
        if (input.args[0] === "symbolic-ref")
          stdout = "refs/heads/workjet/worker/" + request.requestId + "\n";
        if (input.args[0] === "status" && checkoutDirty) stdout = "?? retained.txt\n";
        if (input.args[0] === "worktree" && registeredPath)
          stdout =
            "worktree " +
            registeredPath +
            "\nHEAD " +
            checkoutHead +
            "\nbranch refs/heads/workjet/worker/" +
            request.requestId +
            "\n\n";
        return {
          exitCode:
            input.args[0] === "show-ref" && !registeredPath && !options.preexistingBranch ? 1 : 0,
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
    resolveCommit: (input: { revision: string }) =>
      Effect.succeed({ commitSha: input.revision === "HEAD" ? checkoutHead : request.revision }),
  } as unknown as GitVcsDriver["Service"];
  const workflow = {
    createWorktree: (input: { cwd: string; path: string | null; newRefName: string }) =>
      Effect.gen(function* () {
        worktreeCalls.push(input);
        expect(saved?.worktreePath).toBe(workerPath);
        if (worktreeFailures > 0) {
          worktreeFailures--;
          return yield* Effect.fail({ _tag: "WorktreeCreationFailed" });
        }
        registeredPath = options.outsideWorker ? "/source/private-checkout" : workerPath;
        return { worktree: { path: registeredPath, refName: input.newRefName } };
      }),
  } as unknown as GitWorkflowService["Service"];
  const rollback = WorkerDispatchRollback.of({
    prepare: () =>
      Effect.sync(() => {
        rollbackPrepares.push(registeredPath!);
        return Effect.sync(() => {
          rollbackCalls.push(registeredPath!);
          return {
            recoveryWorktreePath: "/quarantine/w",
            recoveryAdminPath: "/quarantine/a",
            originalWorktreePath: registeredPath!,
            originalAdminPath: "/admin",
            recoveryLocationStatus: "verified" as const,
          };
        });
      }),
  });
  const services = Layer.mergeAll(
    Layer.succeed(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(target),
      getDescriptor: Effect.die("unused"),
    }),
    Layer.succeed(OrchestrationEngineService, engine),
    Layer.succeed(ProjectionSnapshotQuery, query),
    Layer.succeed(GitVcsDriver, git),
    Layer.succeed(GitWorkflowService, workflow),
    Layer.succeed(RemoteWorkerStore, store),
    Layer.succeed(WorkerDispatchRollback, rollback),
    Layer.succeed(OrchestrationCommandReceiptRepository, {
      getByCommandId: ({ commandId }) =>
        Effect.succeed(Option.fromUndefinedOr(commandReceipts.get(commandId))),
      upsert: () => Effect.void,
    }),
    Layer.succeed(RepositoryIdentityResolver, {
      resolve: () =>
        Effect.succeed({
          ...request.project.repository,
          canonicalKey: options.wrongRepository
            ? "github.com/foreign/project"
            : request.project.repository.canonicalKey,
        }),
    }),
    Layer.succeed(WorktreeStorage, {
      inspect: () =>
        Effect.succeed({
          status: "valid",
          effectiveRoot: "/target/storage",
          configuredRoot: "/target/storage",
          defaultRoot: "/target/storage",
          canonicalRoot: "/target/storage",
          requestedRoot: "",
          writable: true,
          availableBytes: 1000000000,
        }),
      resolveAutomaticPath: () => Effect.succeed(workerPath),
      trustedRoots: Effect.succeed(["/target/storage"]),
    }),
    FileSystem.layerNoop({
      exists: () => Effect.succeed(false),
      makeDirectory: () => Effect.void,
      realPath: (path) => Effect.succeed(path),
    }),
    Path.layer,
  );
  const admitted = options.missingAdmission
    ? services
    : Layer.merge(services, Layer.succeed(RemoteWorkerAdmission, { admit: () => Effect.void }));
  return {
    receiver: make.pipe(Effect.provide(admitted)),
    commands,
    gitCalls,
    worktreeCalls,
    rollbackCalls,
    rollbackPrepares,
    commandReceipts,
    receipt: () => saved,
    changeCheckout: (change: { head?: string; dirty?: boolean; path?: string }) => {
      checkoutHead = change.head ?? checkoutHead;
      checkoutDirty = change.dirty ?? checkoutDirty;
      registeredPath = change.path ?? registeredPath;
    },
  };
};

for (const [label, collision] of [
  ["same managed path", { preexistingWorktree: workerPath }],
  ["foreign path", { preexistingWorktree: "/foreign/checkout" }],
  ["unattached branch", { preexistingBranch: true }],
] as const)
  it.effect(
    "rejects a pre-existing worker branch at " + label + " without claiming or deleting it",
    () =>
      Effect.gen(function* () {
        const h = harness(collision);
        const receiver = yield* h.receiver;
        const result = yield* Effect.result(receiver.receive(request));
        expect(result._tag === "Failure" && result.failure.reason).toBe("worktree-failed");
        expect(h.receipt()?.worktreePath).toBeNull();
        expect(h.worktreeCalls).toEqual([]);
        expect(h.commands).toEqual([]);
        expect(h.rollbackPrepares).toEqual([]);
        expect(h.rollbackCalls).toEqual([]);
      }),
  );
it.effect(
  "persists the exact managed path before creation and resumes that reservation after restart",
  () =>
    Effect.gen(function* () {
      const h = harness({ failWorktreeOnce: true });
      const receiver = yield* h.receiver;
      const first = yield* Effect.result(receiver.receive(request));
      expect(first._tag === "Failure" && first.failure.reason).toBe("worktree-failed");
      expect(h.receipt()?.worktreePath).toBe(workerPath);
      expect(h.commands).toEqual([]);
      const restarted = yield* h.receiver;
      const result = yield* restarted.receive(request);
      expect(result.worktreePath).toBe(workerPath);
      expect(h.commands).toHaveLength(2);
      expect(h.worktreeCalls.every((input) => input.path === workerPath)).toBe(true);
    }),
);
for (const [label, change] of [
  ["advanced HEAD", { head: "b".repeat(40) }],
  ["dirty checkout", { dirty: true }],
] as const)
  it.effect("preserves " + label + " after rejected create on restart", () =>
    Effect.gen(function* () {
      const h = harness({ failStep: "create" });
      const receiver = yield* h.receiver;
      yield* Effect.result(receiver.receive(request));
      expect(h.rollbackPrepares).toHaveLength(1);
      const commandId = remoteWorkerCommandId(request.requestId, "create");
      h.commandReceipts.set(commandId, {
        commandId,
        aggregateKind: "thread",
        aggregateId: request.requestId,
        status: "rejected",
        acceptedAt: request.createdAt,
        resultSequence: 1,
        error: null,
      });
      h.changeCheckout(change);
      const restarted = yield* h.receiver;
      const result = yield* Effect.result(restarted.receive(request));
      expect(result._tag === "Failure" && result.failure.reason).toBe("worktree-failed");
      expect(h.rollbackPrepares).toHaveLength(1);
      expect(h.rollbackCalls).toEqual([]);
      expect(h.commands).toHaveLength(1);
      expect(h.receipt()?.worktreePath).toBe(workerPath);
    }),
  );
it.effect("refuses a replay whose registered branch moved to an unreserved path", () =>
  Effect.gen(function* () {
    const h = harness({ failStep: "create" });
    const receiver = yield* h.receiver;
    yield* Effect.result(receiver.receive(request));
    h.changeCheckout({ path: "/foreign/checkout" });
    const restarted = yield* h.receiver;
    const result = yield* Effect.result(restarted.receive(request));
    expect(result._tag === "Failure" && result.failure.reason).toBe("worktree-failed");
    expect(h.worktreeCalls).toHaveLength(1);
    expect(h.commands).toHaveLength(1);
    expect(h.rollbackCalls).toEqual([]);
  }),
);
it.effect("creates an isolated target worker with exact source parent and team mapping", () =>
  Effect.gen(function* () {
    const h = harness();
    const receiver = yield* h.receiver;
    const result = yield* receiver.receive(request);
    expect(result.worktreePath).toBe(workerPath);
    expect(h.worktreeCalls).toEqual([
      {
        cwd: projectPath,
        path: workerPath,
        refName: request.revision,
        newRefName: `workjet/worker/${request.requestId}`,
      },
    ]);
    const create = h.commands[0]!;
    expect(create.command.type).toBe("thread.create");
    if (create.command.type === "thread.create") {
      expect(create.command.workjetConfig?.parent).toEqual(request.parent);
      expect(create.command.workjetConfig?.schemaVersion).toBe(2);
    }
    expect(create.options).toEqual({ remoteWorkerRequest: request });
    expect(h.commands[1]?.command.type).toBe("thread.turn.start");
  }),
);
it.effect(
  "clones missing project beneath target storage and suppresses a duplicate supervisor",
  () =>
    Effect.gen(function* () {
      const h = harness({ missingProject: true });
      const receiver = yield* h.receiver;
      yield* receiver.receive(request);
      const project = h.commands[0]!;
      expect(project.command.type).toBe("project.create");
      if (project.command.type === "project.create")
        expect(project.command.workspaceRoot).toMatch(
          /^\/target\/storage\/\.remote-projects\/[a-f0-9]{64}$/,
        );
      expect(project.options).toEqual({ remoteProjectMirror: true });
      expect(h.gitCalls[0]?.args).toContain("protocol.file.allow=never");
      expect(h.worktreeCalls[0]?.cwd).not.toBe(request.project.repository.rootPath);
    }),
);
for (const [label, changed] of [
  ["foreign target", { targetEnvironmentId: EnvironmentId.make("gpu4") }],
  ["self parent environment", { parent: { ...request.parent, environmentId: target } }],
  ["self parent thread", { parent: { ...request.parent, threadId: request.requestId } }],
  ["expired", { createdAt: "1968-10-07T12:00:00.000Z", expiresAt: "1969-10-07T12:00:00.000Z" }],
  ["capability escalation", { enabledCapabilityIds: ["web-search"] }],
  ["duplicate capability", { enabledCapabilityIds: ["greppy", "greppy"] }],
] as const)
  it.effect(`rejects ${label} before creating a worktree`, () =>
    Effect.gen(function* () {
      const h = harness();
      const receiver = yield* h.receiver;
      const result = yield* Effect.result(receiver.receive({ ...request, ...changed }));
      expect(result._tag).toBe("Failure");
      expect(h.worktreeCalls).toEqual([]);
      expect(h.commands).toEqual([]);
    }),
  );
it.effect("fails closed without native computer and provider admission", () =>
  Effect.gen(function* () {
    const h = harness({ missingAdmission: true });
    const receiver = yield* h.receiver;
    const result = yield* Effect.result(receiver.receive(request));
    expect(result._tag === "Failure" && result.failure.reason).toBe("computer-unavailable");
    expect(h.gitCalls).toEqual([]);
  }),
);
it.effect("rejects project UUID collision with another repository", () =>
  Effect.gen(function* () {
    const h = harness({ wrongRepository: true });
    const receiver = yield* h.receiver;
    const result = yield* Effect.result(receiver.receive(request));
    expect(result._tag === "Failure" && result.failure.reason).toBe("project-unavailable");
    expect(h.worktreeCalls).toEqual([]);
  }),
);
it.effect("rejects worktree paths outside target-owned storage", () =>
  Effect.gen(function* () {
    const h = harness({ outsideWorker: true });
    const receiver = yield* h.receiver;
    const result = yield* Effect.result(receiver.receive(request));
    expect(result._tag === "Failure" && result.failure.reason).toBe("worktree-failed");
    expect(h.commands).toEqual([]);
  }),
);
it.effect("returns same receipt after replay and rejects changed same-ID requests", () =>
  Effect.gen(function* () {
    const h = harness();
    const receiver = yield* h.receiver;
    const first = yield* receiver.receive(request);
    expect(yield* receiver.receive(request)).toEqual(first);
    const changed = yield* Effect.result(receiver.receive({ ...request, task: "changed" }));
    expect(changed._tag === "Failure" && changed.failure.reason).toBe("request-conflict");
    expect(h.worktreeCalls).toHaveLength(1);
    expect(h.commands).toHaveLength(2);
  }),
);
for (const step of ["create", "turn"] as const)
  it.effect(`reconciles lost ${step} acknowledgement using accepted receipt`, () =>
    Effect.gen(function* () {
      const h = harness({ failStep: step, receiptOnFailure: "accepted" });
      const receiver = yield* h.receiver;
      yield* receiver.receive(request);
      yield* receiver.receive(request);
      expect(h.commands).toHaveLength(2);
      expect(h.worktreeCalls).toHaveLength(1);
      expect(h.rollbackCalls).toEqual([]);
    }),
  );
it.effect("replays durable commands when the response write acknowledgement is lost", () =>
  Effect.gen(function* () {
    const h = harness({ failCompleteOnce: true });
    const receiver = yield* h.receiver;
    expect((yield* Effect.result(receiver.receive(request)))._tag).toBe("Failure");
    yield* receiver.receive(request);
    expect(h.commands).toHaveLength(2);
    expect(h.worktreeCalls).toHaveLength(1);
  }),
);
for (const step of ["create", "turn"] as const)
  it.effect(`quarantines only a proven rejected ${step} command`, () =>
    Effect.gen(function* () {
      const h = harness({ failStep: step, receiptOnFailure: "rejected" });
      const receiver = yield* h.receiver;
      const result = yield* Effect.result(receiver.receive(request));
      expect(result._tag === "Failure" && result.failure.reason).toBe(
        step === "create" ? "create-failed" : "turn-start-failed",
      );
      expect(h.rollbackCalls).toEqual([workerPath]);
      expect(h.commands.some(({ command }) => command.type === "thread.delete")).toBe(
        step === "turn",
      );
    }),
  );
it.effect("preserves ambiguous first-turn evidence and reconciles same worker on retry", () =>
  Effect.gen(function* () {
    const h = harness({ failStep: "turn" });
    const receiver = yield* h.receiver;
    const first = yield* Effect.result(receiver.receive(request));
    expect(first._tag === "Failure" && first.failure.reason).toBe("rollback-failed");
    expect(h.rollbackCalls).toEqual([]);
    h.commandReceipts.set(remoteWorkerCommandId(request.requestId, "turn"), {
      commandId: remoteWorkerCommandId(request.requestId, "turn"),
      aggregateKind: "thread",
      aggregateId: request.requestId,
      status: "accepted",
      acceptedAt: request.createdAt,
      resultSequence: 2,
      error: null,
    });
    yield* receiver.receive(request);
    expect(h.worktreeCalls).toHaveLength(1);
    expect(h.commands).toHaveLength(2);
  }),
);
it.effect("preserves worktree evidence when create receipt is ambiguous", () =>
  Effect.gen(function* () {
    const h = harness({ failStep: "create" });
    const receiver = yield* h.receiver;
    const result = yield* Effect.result(receiver.receive(request));
    expect(result._tag === "Failure" && result.failure.reason).toBe("rollback-failed");
    expect(h.rollbackCalls).toEqual([]);
    expect(h.commands).toHaveLength(1);
  }),
);
it.effect("serializes concurrent replay requests into one worktree and first turn", () =>
  Effect.gen(function* () {
    const h = harness();
    const receiver = yield* h.receiver;
    const results = yield* Effect.all([receiver.receive(request), receiver.receive(request)], {
      concurrency: 2,
    });
    expect(results[0]).toEqual(results[1]);
    expect(h.worktreeCalls).toHaveLength(1);
    expect(h.commands).toHaveLength(2);
  }),
);
it("rejects credential-bearing and local repository transports", () => {
  for (const url of [
    "file:///source/repo",
    "/source/repo",
    "https://secret@github.com/example/project.git",
    "ext::command",
  ]) {
    expect(
      remoteWorkerRepositoryUrl({
        ...request,
        project: {
          ...request.project,
          repository: {
            ...request.project.repository,
            locator: { ...request.project.repository.locator, remoteUrl: url },
          },
        },
      }),
    ).toBeNull();
  }
});
it("converts standard git SSH repository locators to credential-free HTTPS", () => {
  for (const url of [
    "git@github.com:example/project.git",
    "ssh://git@github.com/example/project.git",
  ]) {
    expect(
      remoteWorkerRepositoryUrl({
        ...request,
        project: {
          ...request.project,
          repository: {
            ...request.project.repository,
            locator: { ...request.project.repository.locator, remoteUrl: url },
          },
        },
      }),
    ).toBe("https://github.com/example/project.git");
  }
});
