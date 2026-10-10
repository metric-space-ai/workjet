// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import {
  CommandId,
  MessageId,
  RemoteWorkerDispatchError,
  RemoteWorkerRequest,
  type OrchestrationCommand,
  type RemoteWorkerResult,
} from "@workjet/contracts";
import { resolveDelegatedCapabilities } from "@metric-space-ai/workjet-capabilities";
import { normalizeGitRemoteUrl } from "@workjet/shared/git";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { WorktreeStorage } from "../worktree/WorktreeStorage.ts";
import { RemoteWorkerStore } from "./RemoteWorkerStore.ts";
import { WorkerDispatchRollback } from "./WorkerDispatchRollback.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { readWorkerSourceHarness } from "./WorkerSourceHarness.ts";
import { workerSourceDriver } from "./WorkerSourceNativeProfile.ts";

import { RemoteWorkerAdmission } from "./RemoteWorkerAdmission.ts";
export { RemoteWorkerAdmission } from "./RemoteWorkerAdmission.ts";

/** A source account is not a target executable. Select only the commissioned driver. */
export const remoteWorkerRuntimeSelection = (
  request: Pick<RemoteWorkerRequest, "harness" | "modelSelection">,
  source: Pick<import("./WorkerSourceHarness.ts").WorkerSourceHarness, "harness" | "model">,
  instances: ReadonlyArray<Pick<ProviderInstance, "instanceId" | "enabled" | "driverKind">>,
): RemoteWorkerRequest["modelSelection"] | undefined => {
  if (
    source.harness !== (request.harness ?? "codex-cli") ||
    source.model !== request.modelSelection.model
  )
    return undefined;
  const driverKind = workerSourceDriver(source.harness);
  if (driverKind === undefined) return undefined;
  const candidates = instances.filter(
    (instance) => instance.enabled && instance.driverKind === driverKind,
  );
  const selected =
    candidates.find((instance) => instance.instanceId === request.modelSelection.instanceId) ??
    (candidates.length === 1
      ? candidates[0]
      : candidates.find((instance) => instance.instanceId === driverKind));
  return selected === undefined
    ? undefined
    : { ...request.modelSelection, instanceId: selected.instanceId, model: source.model };
};
export class RemoteWorkerReceiver extends Context.Service<
  RemoteWorkerReceiver,
  {
    readonly receive: (
      request: RemoteWorkerRequest,
    ) => Effect.Effect<RemoteWorkerResult, RemoteWorkerDispatchError>;
  }
>()("workjet/workjet/RemoteWorkerReceiver") {}

const failure = (reason: RemoteWorkerDispatchError["reason"]) =>
  new RemoteWorkerDispatchError({ reason });
export const remoteWorkerCommandId = (
  requestId: string,
  step: "project" | "create" | "turn" | "delete",
) => CommandId.make(`remote-worker/${requestId}/${step}`);

/** The receiver only admits credential-free HTTPS repository locators. Target
 * git credentials remain in the target's credential helper, never in requests. */
export const remoteWorkerRepositoryUrl = (request: RemoteWorkerRequest): string | null => {
  try {
    const remote = request.project.repository.locator.remoteUrl;
    const scp = /^git@([A-Za-z0-9.-]+):([^?#\s]+)$/.exec(remote);
    const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote);
    // Standard git SSH locators are converted to credential-free HTTPS; no
    // request-supplied SSH command, user credential or local transport executes.
    const fetchUrl =
      url.protocol === "ssh:" && url.username === "git" && !url.password && !url.port
        ? new URL(`https://${url.hostname}${url.pathname}`)
        : url;
    if (
      fetchUrl.protocol !== "https:" ||
      fetchUrl.username ||
      fetchUrl.password ||
      url.search ||
      url.hash ||
      !fetchUrl.hostname
    )
      return null;
    if (
      normalizeGitRemoteUrl(remote) !== request.project.repository.canonicalKey ||
      normalizeGitRemoteUrl(fetchUrl.href) !== request.project.repository.canonicalKey
    )
      return null;
    return fetchUrl.href;
  } catch {
    return null;
  }
};

export const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const store = yield* RemoteWorkerStore;
  const git = yield* GitVcsDriver;
  const workflow = yield* GitWorkflowService;
  const identity = yield* RepositoryIdentityResolver;
  const storage = yield* WorktreeStorage;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rollback = yield* WorkerDispatchRollback;
  const admission = yield* Effect.serviceOption(RemoteWorkerAdmission);
  const providerInstances = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const mutex = yield* Semaphore.make(1);
  const targetEnvironmentId = yield* environment.getEnvironmentId;

  const receive = Effect.fn("RemoteWorkerReceiver.receive")(function* (input: RemoteWorkerRequest) {
    const request = yield* Schema.decodeUnknownEffect(RemoteWorkerRequest)(input).pipe(
      Effect.mapError(() => failure("invalid-request")),
    );
    const url = remoteWorkerRepositoryUrl(request);
    const delegated = resolveDelegatedCapabilities({
      parentCapabilityIds: request.parentCapabilityIds,
      requestedCapabilityIds: request.enabledCapabilityIds,
      targetRole: "worker",
    });
    if (
      request.targetEnvironmentId !== targetEnvironmentId ||
      request.parent.environmentId === targetEnvironmentId ||
      request.parent.threadId === request.requestId ||
      (request.executionPolicy !== undefined &&
        (request.executionPolicy.projectId !== request.project.id ||
          request.parentTeamRole === undefined)) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.requestId) ||
      url === null ||
      new Set(request.enabledCapabilityIds).size !== request.enabledCapabilityIds.length ||
      new Set(request.parentCapabilityIds).size !== request.parentCapabilityIds.length ||
      request.enabledCapabilityIds.some((id) => !request.parentCapabilityIds.includes(id)) ||
      delegated.issues.length > 0 ||
      delegated.capabilityIds.length !== request.enabledCapabilityIds.length
    )
      return yield* failure("invalid-request");

    // put is an immutable compare-and-insert: a changed replay never reaches git.
    yield* store
      .put("inbound", request)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "RemoteWorkerDispatchError" ? error : failure("source-unavailable"),
        ),
      );
    const saved = yield* store.get("inbound", request.requestId).pipe(
      Effect.mapError(() => failure("source-unavailable")),
      Effect.map(Option.getOrUndefined),
    );
    if (!saved) return yield* failure("source-unavailable");
    if (saved.response !== null) {
      if (saved.response.outcome.status === "failed")
        return yield* failure(saved.response.outcome.reason);
      return saved.response.outcome.result;
    }
    if (saved.worktreePath !== null) {
      const accepted = yield* Effect.all(
        (["create", "turn"] as const).map((step) =>
          receipts
            .getByCommandId({ commandId: remoteWorkerCommandId(request.requestId, step) })
            .pipe(
              Effect.mapError(() => failure("source-unavailable")),
              Effect.map(Option.getOrUndefined),
            ),
        ),
      );
      if (
        accepted.every(
          (receipt) =>
            receipt?.aggregateKind === "thread" &&
            receipt.aggregateId === request.requestId &&
            receipt.status === "accepted",
        )
      ) {
        const result: RemoteWorkerResult = {
          schemaVersion: 1,
          status: "dispatched",
          environmentId: targetEnvironmentId,
          workerThreadId: request.requestId,
          computerId: request.computerId,
          branch: `workjet/worker/${request.requestId}`,
          worktreePath: saved.worktreePath,
          parent: request.parent,
          modelSelection: request.modelSelection,
          enabledCapabilityIds: request.enabledCapabilityIds,
        };
        yield* store
          .complete("inbound", {
            requestId: request.requestId,
            outcome: { status: "dispatched", result },
          })
          .pipe(Effect.mapError(() => failure("source-unavailable")));
        return result;
      }
    }
    const now = yield* DateTime.now;
    if (
      DateTime.toEpochMillis(DateTime.makeUnsafe(request.expiresAt)) <=
        DateTime.toEpochMillis(now) ||
      DateTime.toEpochMillis(DateTime.makeUnsafe(request.createdAt)) >=
        DateTime.toEpochMillis(DateTime.makeUnsafe(request.expiresAt))
    )
      return yield* failure("invalid-request");
    if (Option.isNone(admission)) return yield* failure("computer-unavailable");
    yield* admission.value.admit(request);
    // Source authority selects the model/account. The target selects an actual
    // installed executable harness, rather than inheriting a source-only
    // native provider instance ID whose empty target binding cannot execute.
    let runtimeModelSelection = request.modelSelection;
    const sourceHarness = readWorkerSourceHarness(request.requestId);
    if (
      request.harness !== undefined &&
      request.harness !== "codex-cli" &&
      sourceHarness === undefined
    )
      return yield* failure("source-unavailable");
    if (sourceHarness !== undefined) {
      if (sourceHarness.harness !== (request.harness ?? "codex-cli"))
        return yield* failure("source-unavailable");
      if (
        sourceHarness.harness !== "codex-cli" &&
        sourceHarness.harness !== "claude-code" &&
        sourceHarness.nativeProfile?.harness !== sourceHarness.harness
      )
        return yield* failure("source-unavailable");
      if (Option.isNone(providerInstances)) return yield* failure("computer-unavailable");
      const selected = remoteWorkerRuntimeSelection(
        request,
        sourceHarness,
        yield* providerInstances.value.listInstances,
      );
      if (selected === undefined) return yield* failure("computer-unavailable");
      runtimeModelSelection = selected;
    }

    const runGit = Effect.fn("RemoteWorkerReceiver.git")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ) {
      return yield* git
        .execute({ operation: "RemoteWorkerReceiver", cwd, args, timeoutMs: 120000 })
        .pipe(Effect.mapError(() => failure("project-unavailable")));
    });
    const project = yield* query.getProjectShellById(request.project.id).pipe(
      Effect.mapError(() => failure("project-unavailable")),
      Effect.map(Option.getOrUndefined),
    );
    let cwd = project?.workspaceRoot;
    if (!project) {
      const inspection = yield* storage.inspect("");
      if (inspection.status === "invalid") return yield* failure("project-unavailable");
      const mirrorId = NodeCrypto.createHash("sha256")
        .update(`${request.project.id}\0${request.project.repository.canonicalKey}`)
        .digest("hex");
      cwd = path.join(inspection.effectiveRoot, ".remote-projects", mirrorId);
      yield* fs
        .makeDirectory(path.dirname(cwd), { recursive: true })
        .pipe(Effect.mapError(() => failure("project-unavailable")));
      const mirrorParent = yield* fs
        .realPath(path.dirname(cwd))
        .pipe(Effect.mapError(() => failure("project-unavailable")));
      if (
        path.relative(inspection.effectiveRoot, mirrorParent).startsWith("..") ||
        path.isAbsolute(path.relative(inspection.effectiveRoot, mirrorParent))
      )
        return yield* failure("project-unavailable");
      if (!(yield* fs.exists(cwd).pipe(Effect.mapError(() => failure("project-unavailable"))))) {
        yield* runGit(path.dirname(cwd), [
          "-c",
          "protocol.file.allow=never",
          "-c",
          "protocol.ext.allow=never",
          "clone",
          "--",
          url,
          cwd,
        ]);
      }
      const mirrorPath = yield* fs
        .realPath(cwd)
        .pipe(Effect.mapError(() => failure("project-unavailable")));
      if (mirrorPath !== cwd) return yield* failure("project-unavailable");
      const resolved = yield* identity.resolve(cwd);
      if (resolved?.canonicalKey !== request.project.repository.canonicalKey)
        return yield* failure("project-unavailable");
      yield* engine
        .dispatch(
          {
            type: "project.create",
            commandId: remoteWorkerCommandId(request.requestId, "project"),
            projectId: request.project.id,
            title: request.project.title,
            workspaceRoot: cwd,
            defaultModelSelection: request.modelSelection,
            createdAt: request.createdAt,
          },
          { remoteProjectMirror: true },
        )
        .pipe(Effect.mapError(() => failure("project-unavailable")));
    }
    if (!cwd) return yield* failure("project-unavailable");
    const repository = yield* identity.resolve(cwd);
    if (repository?.canonicalKey !== request.project.repository.canonicalKey)
      return yield* failure("project-unavailable");
    // Fetch only the approved repository. A source path is never used as cwd.
    const revision = yield* Effect.result(git.resolveCommit({ cwd, revision: request.revision }));
    if (revision._tag === "Failure") {
      yield* runGit(cwd, [
        "-c",
        "protocol.file.allow=never",
        "-c",
        "protocol.ext.allow=never",
        "fetch",
        "--",
        url,
        request.revision,
      ]);
    }
    const commit = yield* git
      .resolveCommit({ cwd, revision: request.revision })
      .pipe(Effect.mapError(() => failure("project-unavailable")));
    if (commit.commitSha !== request.revision) return yield* failure("project-unavailable");
    const branch = "workjet/worker/" + request.requestId;
    const common = yield* runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.stdoutTruncated || common.stdout.trim() === "")
      return yield* failure("worktree-failed");
    const expectedPath = yield* storage
      .resolveAutomaticPath({ cwd, gitCommonDir: common.stdout.trim(), ref: branch })
      .pipe(Effect.mapError(() => failure("worktree-failed")));
    const trustedRoots = yield* storage.trustedRoots;
    if (
      !trustedRoots.some((root) => {
        const relative = path.relative(root, expectedPath);
        return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
      })
    )
      return yield* failure("worktree-failed");
    const list = yield* runGit(cwd, ["worktree", "list", "--porcelain"]);
    if (list.stdoutTruncated) return yield* failure("worktree-failed");
    const registered = list.stdout
      .split("\n\n")
      .filter((entry) => entry.split("\n").includes("branch refs/heads/" + branch));
    if (registered.length > 1) return yield* failure("worktree-failed");
    const registeredPath = registered[0]
      ?.split("\n")
      .find((line) => line.startsWith("worktree "))
      ?.slice(9);
    if (saved.worktreePath === null) {
      // An existing UUID-shaped branch is not a receipt of ownership. Reserve
      // the server-derived path only while neither branch nor checkout exists.
      const ref = yield* git
        .execute({
          operation: "RemoteWorkerReceiver.reserve",
          cwd,
          args: ["show-ref", "--verify", "--quiet", "refs/heads/" + branch],
          allowNonZeroExit: true,
        })
        .pipe(Effect.mapError(() => failure("worktree-failed")));
      if (
        registeredPath !== undefined ||
        ref.exitCode !== 1 ||
        (yield* fs.exists(expectedPath).pipe(Effect.mapError(() => failure("worktree-failed"))))
      )
        return yield* failure("worktree-failed");
      yield* store
        .recordWorktree(request.requestId, expectedPath)
        .pipe(Effect.mapError(() => failure("worktree-failed")));
    } else if (
      saved.worktreePath !== expectedPath ||
      (registeredPath !== undefined && registeredPath !== saved.worktreePath)
    ) {
      return yield* failure("worktree-failed");
    }
    let worktreePath = registeredPath;
    if (!worktreePath) {
      if (yield* fs.exists(expectedPath).pipe(Effect.mapError(() => failure("worktree-failed"))))
        return yield* failure("worktree-failed");
      const created = yield* workflow
        .createWorktree({ cwd, path: expectedPath, refName: request.revision, newRefName: branch })
        .pipe(Effect.mapError(() => failure("worktree-failed")));
      worktreePath = created.worktree.path;
      if (created.worktree.refName !== branch || worktreePath !== expectedPath)
        return yield* failure("worktree-failed");
    }
    const workerRealPath = yield* fs
      .realPath(worktreePath)
      .pipe(Effect.mapError(() => failure("worktree-failed")));
    if (workerRealPath !== expectedPath) return yield* failure("worktree-failed");
    const verifyUnstartedCheckout = Effect.fn("RemoteWorkerReceiver.verifyUnstartedCheckout")(
      function* () {
        const head = yield* git
          .resolveCommit({ cwd: worktreePath, revision: "HEAD" })
          .pipe(Effect.mapError(() => failure("worktree-failed")));
        const ref = yield* runGit(worktreePath, ["symbolic-ref", "HEAD"]);
        const status = yield* runGit(worktreePath, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignored",
        ]);
        if (
          head.commitSha !== request.revision ||
          ref.stdoutTruncated ||
          ref.stdout.trim() !== "refs/heads/" + branch ||
          status.stdoutTruncated ||
          status.stdout !== ""
        )
          return yield* failure("worktree-failed");
      },
    );
    // Never recapture changed committed work as the new rollback baseline on
    // restart. Check both sides of the native rollback's inode/HEAD capture.
    yield* verifyUnstartedCheckout();
    const prepared = yield* rollback
      .prepare({ cwd, worktreePath, branchRef: branch })
      .pipe(Effect.option);
    yield* verifyUnstartedCheckout();
    const result: RemoteWorkerResult = {
      schemaVersion: 1,
      status: "dispatched",
      environmentId: targetEnvironmentId,
      workerThreadId: request.requestId,
      computerId: request.computerId,
      branch,
      worktreePath,
      harness: request.harness ?? "codex-cli",
      hostname: NodeOS.hostname(),
      parent: request.parent,
      modelSelection: request.modelSelection,
      enabledCapabilityIds: request.enabledCapabilityIds,
    };
    const commandReceipt = Effect.fn("RemoteWorkerReceiver.commandReceipt")(function* (
      step: "create" | "turn" | "delete",
    ) {
      const receipt = yield* receipts
        .getByCommandId({ commandId: remoteWorkerCommandId(request.requestId, step) })
        .pipe(
          Effect.mapError(() => failure("rollback-failed")),
          Effect.map(Option.getOrUndefined),
        );
      if (
        receipt &&
        (receipt.aggregateKind !== "thread" || receipt.aggregateId !== request.requestId)
      )
        return yield* failure("rollback-failed");
      return receipt;
    });
    const terminalFailure = Effect.fn("RemoteWorkerReceiver.reject")(function* (
      step: "create" | "turn",
    ) {
      const receipt = yield* commandReceipt(step);
      if (receipt?.status !== "rejected" || Option.isNone(prepared))
        return yield* failure("rollback-failed");
      if (step === "turn") {
        const deletion = yield* Effect.result(
          engine.dispatch({
            type: "thread.delete",
            commandId: remoteWorkerCommandId(request.requestId, "delete"),
            threadId: request.requestId,
          }),
        );
        if (deletion._tag === "Failure" && (yield* commandReceipt("delete"))?.status !== "accepted")
          return yield* failure("rollback-failed");
      } else {
        const existing = yield* query.getThreadDetailById(request.requestId).pipe(
          Effect.mapError(() => failure("rollback-failed")),
          Effect.map(Option.getOrUndefined),
        );
        if (existing?.worktreePath === worktreePath) return yield* failure("rollback-failed");
      }
      yield* prepared.value.pipe(Effect.mapError(() => failure("rollback-failed")));
      const reason = step === "create" ? "create-failed" : "turn-start-failed";
      yield* store
        .complete("inbound", {
          requestId: request.requestId,
          outcome: { status: "failed", reason },
        })
        .pipe(Effect.mapError(() => failure("rollback-failed")));
      return yield* failure(reason);
    });
    const dispatch = Effect.fn("RemoteWorkerReceiver.dispatch")(function* (
      command: OrchestrationCommand,
      step: "create" | "turn",
    ) {
      const previous = yield* commandReceipt(step);
      if (previous?.status === "accepted") return;
      if (previous?.status === "rejected") return yield* terminalFailure(step);
      const attempt = yield* Effect.result(
        engine.dispatch(command, step === "create" ? { remoteWorkerRequest: request } : undefined),
      );
      if (attempt._tag === "Failure") {
        const receipt = yield* commandReceipt(step);
        if (receipt?.status === "accepted") return;
        if (receipt?.status === "rejected") return yield* terminalFailure(step);
        return yield* failure("rollback-failed");
      }
    });
    yield* dispatch(
      {
        type: "thread.create",
        commandId: remoteWorkerCommandId(request.requestId, "create"),
        threadId: request.requestId,
        projectId: request.project.id,
        title: request.title,
        modelSelection: runtimeModelSelection,
        runtimeMode: request.runtimeMode,
        interactionMode: request.interactionMode,
        workjetConfig: {
          schemaVersion: 2,
          role: "worker",
          parent: request.parent,
          managedInstructions: request.managedInstructions,
          enabledCapabilityIds: request.enabledCapabilityIds,
          capabilityBindings: [],
          ...(request.executionPolicy === undefined ? {} : { executionPolicy: request.executionPolicy }),
          ...(request.parentTeamRole
            ? {
                team: {
                  projectId: request.project.id,
                  threadId: request.requestId,
                  role: "worker",
                  parentThreadId: request.parent.threadId,
                  packageId: request.requestId,
                  goal: request.task.trim().slice(0, 4096),
                  createdAt: request.createdAt,
                },
              }
            : {}),
        },
        branch,
        worktreePath,
        createdAt: request.createdAt,
      },
      "create",
    );
    yield* dispatch(
      {
        type: "thread.turn.start",
        commandId: remoteWorkerCommandId(request.requestId, "turn"),
        threadId: request.requestId,
        message: {
          messageId: MessageId.make(`remote-worker/${request.requestId}/message`),
          role: "user",
          text: request.task,
          attachments: [],
        },
        runtimeMode: request.runtimeMode,
        interactionMode: request.interactionMode,
        createdAt: request.createdAt,
      },
      "turn",
    );
    yield* store
      .complete("inbound", {
        requestId: request.requestId,
        outcome: { status: "dispatched", result },
      })
      .pipe(Effect.mapError(() => failure("source-unavailable")));
    return result;
  }, mutex.withPermits(1));
  return RemoteWorkerReceiver.of({ receive });
});
export const layer = Layer.effect(RemoteWorkerReceiver, make);
