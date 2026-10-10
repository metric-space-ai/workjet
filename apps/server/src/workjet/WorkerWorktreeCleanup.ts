/**
 * WorkerWorktreeCleanup - durable removal of a dispatched worker's isolated
 * checkout.
 *
 * `WorkerDispatch` gives every worker thread its own Git checkout plus a
 * throwaway `workjet/worker/<threadId>` branch. Dispatch rollback covers the
 * failure paths only; the durable end of a worker's life is the
 * `thread.deleted` orchestration domain event, which the
 * `ThreadDeletionReactor` already consumes for provider sessions and
 * terminals. This module is the third such cleanup.
 *
 * Safety rules encoded here, in order:
 *  - only threads whose persisted `workjetConfig.role` is `worker`;
 *  - only the exact `worktreePath` recorded on that thread;
 *  - only when that path resolves strictly beneath a trusted automatic
 *    worktree storage root (never the project workspace root, never a root
 *    itself);
 *  - only the branch ref named exactly `workjet/worker/<threadId>`;
 *  - only after the provider confirms the exact local HEAD or retained branch
 *    commit was merged;
 *  - private repositories require the immutable allocation's original inode
 *    pair and are retained together with `.git` in the native recovery path;
 *  - linked worktrees are never force removed; branch deletion compares HEAD.
 *
 * Every outcome is a value, so the reaction is observable, and the caller can
 * log a failure without ever failing the thread deletion it reacts to.
 *
 * @module WorkerWorktreeCleanup
 */
import type { ThreadId } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { WorktreeStorage } from "../worktree/WorktreeStorage.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { NativeWorkerWorktreeRemover } from "./NativeWorkerWorktreeRemover.ts";
import { IsolatedWorkerWorktreeStore } from "./IsolatedWorkerWorktreeStore.ts";
import {
  WorkerCleanupReceiptStore,
  type VerifiedWorkerCleanup,
} from "./WorkerCleanupReceiptStore.ts";
import { WORKER_REF_PREFIX } from "./WorkerDispatch.ts";

/**
 * Why a cleanup did nothing. Skips are normal outcomes, not failures: most
 * deleted threads are not workers at all.
 */
export type WorkerWorktreeCleanupSkipReason =
  | "thread-unavailable"
  | "not-a-worker"
  | "no-worktree-path"
  | "outside-storage-root"
  | "merge-unverified"
  | "safe-removal-unavailable"
  | "already-cleaned";

export type WorkerWorktreeCleanupOutcome =
  | { readonly status: "skipped"; readonly reason: WorkerWorktreeCleanupSkipReason }
  | {
      readonly status: "cleaned";
      readonly worktreePath: string;
      readonly deletedRefName: string | null;
      readonly retainedRepositoryPath?: string;
    };

export type WorkerWorktreeCleanupFailureStep =
  | "read-thread"
  | "record-verification"
  | "remove-worktree"
  | "record-removal"
  | "delete-branch"
  | "record-completion";

/**
 * Bounded, redaction-safe failure. Downstream Git and SQL detail is
 * deliberately dropped: this error is logged on a best-effort cleanup path.
 */
export class WorkerWorktreeCleanupError extends Schema.TaggedErrorClass<WorkerWorktreeCleanupError>()(
  "WorkerWorktreeCleanupError",
  {
    step: Schema.Literals([
      "read-thread",
      "record-verification",
      "remove-worktree",
      "record-removal",
      "delete-branch",
      "record-completion",
    ]),
  },
) {
  override get message(): string {
    switch (this.step) {
      case "read-thread":
        return "The deleted thread's worker worktree context could not be read.";
      case "record-verification":
        return "The verified worker merge could not be recorded.";
      case "remove-worktree":
        return "The worker checkout could not be safely released.";
      case "record-removal":
        return "The removed worker worktree could not be recorded.";
      case "delete-branch":
        return "The isolated worker branch ref could not be deleted.";
      case "record-completion":
        return "The completed worker cleanup could not be recorded.";
    }
  }
}

export interface WorkerWorktreeCleanupShape {
  /**
   * Idempotent. A missing checkout with an owned branch retries branch cleanup;
   * when both are gone the operation reports an already-cleaned skip.
   */
  readonly cleanupDeletedThread: (
    threadId: ThreadId,
  ) => Effect.Effect<WorkerWorktreeCleanupOutcome, WorkerWorktreeCleanupError>;
}

export class WorkerWorktreeCleanup extends Context.Service<
  WorkerWorktreeCleanup,
  WorkerWorktreeCleanupShape
>()("workjet/workjet/WorkerWorktreeCleanup") {}

/** Strictly beneath `root` — the root itself is never a removal target. */
const isStrictlyWithin = (path: Path.Path, candidate: string, root: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export type WorkerRemovalPathGuard = (input: {
  readonly worktreePath: string;
  readonly workspaceRoot: string;
  readonly trustedRoots: ReadonlyArray<string>;
}) => Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path>;

/** Return the canonical target only when no path component redirects a worker checkout. */
export const canonicalWorkerRemovalPath: WorkerRemovalPathGuard = (input) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const lexicalTarget = path.resolve(input.worktreePath);
    const targetOption = yield* fs.realPath(lexicalTarget).pipe(Effect.option);
    const workspaceOption = yield* fs
      .realPath(path.resolve(input.workspaceRoot))
      .pipe(Effect.option);
    if (Option.isNone(targetOption) || Option.isNone(workspaceOption)) return null;
    const target = targetOption.value;
    const workspace = workspaceOption.value;
    if (target === workspace || isStrictlyWithin(path, target, workspace)) return null;

    for (const root of input.trustedRoots) {
      const lexicalRoot = path.resolve(root);
      if (!isStrictlyWithin(path, lexicalTarget, lexicalRoot)) continue;
      const rootOption = yield* fs.realPath(lexicalRoot).pipe(Effect.option);
      if (Option.isNone(rootOption)) continue;
      const canonicalRoot = rootOption.value;
      const relative = path.relative(lexicalRoot, lexicalTarget);
      if (
        isStrictlyWithin(path, target, canonicalRoot) &&
        path.resolve(canonicalRoot, relative) === target
      ) {
        return target;
      }
    }
    return null;
  });

export const make = Effect.fn("WorkerWorktreeCleanup.make")(function* (
  removalPathGuard: WorkerRemovalPathGuard = canonicalWorkerRemovalPath,
) {
  const query = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const git = yield* GitVcsDriver;
  const sourceControlProviders = yield* SourceControlProviderRegistry;
  const worktreeStorage = yield* WorktreeStorage;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const receipts = yield* WorkerCleanupReceiptStore;
  const nativeRemover = yield* NativeWorkerWorktreeRemover;
  const isolatedWorktrees = yield* IsolatedWorkerWorktreeStore;
  const validateRemovalPath = (input: Parameters<WorkerRemovalPathGuard>[0]) =>
    removalPathGuard(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const cleanupDeletedThread: WorkerWorktreeCleanupShape["cleanupDeletedThread"] = Effect.fn(
    "WorkerWorktreeCleanup.cleanupDeletedThread",
  )(function* (threadId) {
    const contextOption = yield* query
      .getThreadWorktreeCleanupContext(threadId)
      .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "read-thread" })));
    const context = Option.getOrUndefined(contextOption);
    if (!context) {
      return { status: "skipped", reason: "thread-unavailable" } as const;
    }
    if (context.workjetRole !== "worker") {
      return { status: "skipped", reason: "not-a-worker" } as const;
    }
    const worktreePath = context.worktreePath;
    if (worktreePath === null || worktreePath.length === 0) {
      return { status: "skipped", reason: "no-worktree-path" } as const;
    }

    // Automatic worker checkouts always live beneath a trusted storage root.
    // Anything else — a hand-attached checkout, the project workspace itself,
    // a path from an older layout — is left untouched.
    const trustedRoots = yield* worktreeStorage.trustedRoots;
    const isAutomatic =
      trustedRoots.some((root) => isStrictlyWithin(path, worktreePath, root)) &&
      !isStrictlyWithin(path, worktreePath, path.resolve(context.workspaceRoot)) &&
      path.resolve(worktreePath) !== path.resolve(context.workspaceRoot);
    if (!isAutomatic) {
      return { status: "skipped", reason: "outside-storage-root" } as const;
    }

    const workerRefName = `${WORKER_REF_PREFIX}${threadId}`;
    if (context.branch !== workerRefName) {
      return { status: "skipped", reason: "merge-unverified" } as const;
    }

    const mergedAtCommit = (cwd: string, commitSha: string) =>
      Effect.gen(function* () {
        const provider = yield* sourceControlProviders.resolve({ cwd });
        const merged = yield* provider.listChangeRequests({
          cwd,
          headSelector: workerRefName,
          state: "merged",
          limit: 100,
        });
        return (
          merged.find(
            (pr) =>
              pr.state === "merged" &&
              pr.headRefName === workerRefName &&
              pr.headCommitOid?.toLowerCase() === commitSha.toLowerCase() &&
              pr.url.length > 0,
          )?.url ?? null
        );
      }).pipe(Effect.orElseSucceed(() => null));

    const cwd = context.workspaceRoot;
    const allocation = yield* isolatedWorktrees
      .get(threadId)
      .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "read-thread" })));
    if (Option.isSome(allocation)) {
      const { intent, custody } = allocation.value;
      // The allocation journal captures the staging directory BEFORE its
      // atomic publication. Remap only its names, never its original inodes.
      if (
        custody === null ||
        intent.workerId !== threadId ||
        intent.projectId !== context.projectId ||
        intent.sourceCwd !== cwd ||
        intent.branch !== workerRefName ||
        intent.destination !== worktreePath ||
        path.dirname(custody.worktreePath) !== path.dirname(worktreePath) ||
        !path.basename(custody.worktreePath).startsWith(`.workjet-prepared-${threadId}-`) ||
        custody.adminPath !== path.join(custody.worktreePath, ".git")
      ) {
        return { status: "skipped", reason: "safe-removal-unavailable" } as const;
      }
      const captured = {
        ...custody,
        worktreePath,
        adminPath: path.join(worktreePath, ".git"),
      };
      const recoveryPath = `${worktreePath}.workjet-rejected-${captured.worktreeIno}`;
      const originalExists = yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
      const targetPath = originalExists ? worktreePath : recoveryPath;
      if (
        (yield* validateRemovalPath({
          worktreePath: targetPath,
          workspaceRoot: cwd,
          trustedRoots,
        })) !== targetPath
      ) {
        return { status: "skipped", reason: "outside-storage-root" } as const;
      }
      const observed = yield* nativeRemover.capture(targetPath, "isolated").pipe(Effect.option);
      if (
        Option.isNone(observed) ||
        observed.value.kind !== "isolated" ||
        observed.value.worktreePath !== targetPath ||
        observed.value.worktreeDev !== captured.worktreeDev ||
        observed.value.worktreeIno !== captured.worktreeIno ||
        observed.value.adminPath !== path.join(targetPath, ".git") ||
        observed.value.adminDev !== captured.adminDev ||
        observed.value.adminIno !== captured.adminIno
      ) {
        return { status: "skipped", reason: "safe-removal-unavailable" } as const;
      }
      const cleanHead = Effect.gen(function* () {
        yield* gitWorkflow.invalidateLocalStatus(targetPath);
        const status = yield* gitWorkflow.localStatus({ cwd: targetPath });
        if (!status.isRepo || status.hasWorkingTreeChanges || status.refName !== workerRefName)
          return null;
        return (yield* git.resolveCommit({ cwd: targetPath, revision: "HEAD" })).commitSha;
      }).pipe(Effect.orElseSucceed(() => null));
      const head = yield* cleanHead;
      if (head === null) return { status: "skipped", reason: "merge-unverified" } as const;
      const stored = yield* receipts
        .get(threadId)
        .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "read-thread" })));
      const matching =
        Option.isSome(stored) &&
        stored.value.worktreePath === worktreePath &&
        stored.value.branchRef === workerRefName &&
        stored.value.mergedHeadOid === head &&
        stored.value.mergedChangeRequestUrl.length > 0
          ? stored.value
          : null;
      if (matching?.status === "complete") {
        return {
          status: "skipped",
          reason: originalExists ? "safe-removal-unavailable" : "already-cleaned",
        } as const;
      }
      let receipt: VerifiedWorkerCleanup;
      if (originalExists) {
        if (matching?.status === "removed")
          return { status: "skipped", reason: "safe-removal-unavailable" } as const;
        const mergedUrl = yield* mergedAtCommit(worktreePath, head);
        if (mergedUrl === null) return { status: "skipped", reason: "merge-unverified" } as const;
        receipt = {
          threadId,
          worktreePath,
          branchRef: workerRefName,
          mergedHeadOid: head,
          mergedChangeRequestUrl: mergedUrl,
        };
        const recorded = yield* receipts.recordVerified(receipt).pipe(
          Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "record-verification" })),
        );
        if (!recorded) return { status: "skipped", reason: "merge-unverified" } as const;
        const verified = yield* receipts.get(threadId).pipe(
          Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "read-thread" })),
        );
        if (Option.isNone(verified) || verified.value.status !== "verified")
          return { status: "skipped", reason: "safe-removal-unavailable" } as const;
        if ((yield* cleanHead) !== head)
          return { status: "skipped", reason: "merge-unverified" } as const;
        // The native helper preserves the checkout AND its private Git admin
        // using the original capture. Never remove refs in the source repo.
        const recovery = yield* nativeRemover.quarantineCaptured(captured, {
          headOid: head,
          branchRef: workerRefName,
        }).pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "remove-worktree" })));
        if (recovery.recoveryWorktreePath !== recoveryPath ||
          recovery.recoveryAdminPath !== path.join(recoveryPath, ".git") ||
          recovery.recoveryLocationStatus !== "verified")
          return yield* new WorkerWorktreeCleanupError({ step: "remove-worktree" });
      } else {
        // A lost native acknowledgement or SQL write must not strand a worker.
        // A missing original alone is insufficient: require the ORIGINAL inode
        // pair and the helper's synced terminal receipt at the recovery path.
        if (matching === null)
          return { status: "skipped", reason: "safe-removal-unavailable" } as const;
        const nativeProof = yield* Effect.gen(function* () {
          const readBounded = (name: string) => Effect.gen(function* () {
            const file = path.join(recoveryPath, ".git", name);
            const info = yield* fs.stat(file);
            if (info.size > 65536n) return yield* Effect.fail("oversized-receipt");
            return yield* fs.readFileString(file);
          });
          const proof = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
            schemaVersion: Schema.Literal(1),
            kind: Schema.Literal("isolated"),
            originalWorktreePath: Schema.String,
            originalAdminPath: Schema.String,
            recoveryWorktreePath: Schema.String,
            recoveryAdminPath: Schema.String,
            originalHeadOid: Schema.String,
            originalBranchRef: Schema.String,
            worktreeIdentity: Schema.Struct({ dev: Schema.Number, ino: Schema.Number }),
            adminIdentity: Schema.Struct({ dev: Schema.Number, ino: Schema.Number }),
            automaticContentDeletion: Schema.Literal(false),
          })))(yield* readBounded("workjet-rollback-receipt.json"));
          const progress = yield* readBounded("workjet-rollback-progress.jsonl");
          const terminal = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
            phase: Schema.Literal("checkout-and-admin-quarantined"),
          })))(progress.trim().split("\n").at(-1));
          return terminal.phase === "checkout-and-admin-quarantined" &&
            proof.originalWorktreePath === worktreePath &&
            proof.originalAdminPath === captured.adminPath &&
            proof.recoveryWorktreePath === recoveryPath &&
            proof.recoveryAdminPath === path.join(recoveryPath, ".git") &&
            proof.originalHeadOid === head && proof.originalBranchRef === workerRefName &&
            String(proof.worktreeIdentity.dev) === captured.worktreeDev &&
            String(proof.worktreeIdentity.ino) === captured.worktreeIno &&
            String(proof.adminIdentity.dev) === captured.adminDev &&
            String(proof.adminIdentity.ino) === captured.adminIno;
        }).pipe(Effect.orElseSucceed(() => false));
        if (!nativeProof)
          return { status: "skipped", reason: "safe-removal-unavailable" } as const;
        if ((yield* cleanHead) !== head ||
          (yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => true))))
          return { status: "skipped", reason: "safe-removal-unavailable" } as const;
        receipt = matching;
      }
      yield* receipts.markRemoved(receipt).pipe(
        Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "record-removal" })),
      );
      yield* receipts.markComplete(receipt).pipe(
        Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "record-completion" })),
      );
      return {
        status: "cleaned", worktreePath, deletedRefName: null,
        retainedRepositoryPath: recoveryPath,
      } as const;
    }
    const existingPath = yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    const safeRemovalPath = existingPath
      ? yield* validateRemovalPath({ worktreePath, workspaceRoot: cwd, trustedRoots })
      : null;
    if (existingPath && safeRemovalPath === null) {
      return { status: "skipped", reason: "outside-storage-root" } as const;
    }
    // Bind the merge checks to this directory before Git or provider calls.
    // Capturing after verification would silently authorize a replacement.
    const captured =
      safeRemovalPath === null
        ? null
        : yield* nativeRemover
            .capture(safeRemovalPath)
            .pipe(
              Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "remove-worktree" })),
            );
    yield* gitWorkflow.invalidateLocalStatus(worktreePath);
    const local = yield* gitWorkflow
      .localStatus({ cwd: worktreePath })
      .pipe(Effect.orElseSucceed(() => null));
    if (local?.isRepo) {
      if (captured === null) {
        return { status: "skipped", reason: "merge-unverified" } as const;
      }
      if (local.refName !== workerRefName || local.hasWorkingTreeChanges) {
        return { status: "skipped", reason: "merge-unverified" } as const;
      }
      const head = yield* git
        .resolveCommit({ cwd: worktreePath, revision: "HEAD" })
        .pipe(Effect.orElseSucceed(() => null));
      const mergedUrl = head ? yield* mergedAtCommit(worktreePath, head.commitSha) : null;
      if (!head || !mergedUrl) {
        return { status: "skipped", reason: "merge-unverified" } as const;
      }
      const receipt: VerifiedWorkerCleanup = {
        threadId,
        worktreePath,
        branchRef: workerRefName,
        mergedHeadOid: head.commitSha,
        mergedChangeRequestUrl: mergedUrl,
      };
      const recorded = yield* receipts
        .recordVerified(receipt)
        .pipe(
          Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "record-verification" })),
        );
      if (!recorded) return { status: "skipped", reason: "merge-unverified" } as const;
      const stored = yield* receipts
        .get(threadId)
        .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "read-thread" })));
      if (Option.isNone(stored) || stored.value.status !== "verified") {
        return { status: "skipped", reason: "merge-unverified" } as const;
      }
      // Provider lookup and durable receipt writes can take time. Retain any
      // edits or ref changes observed since the original clean Git status.
      yield* gitWorkflow.invalidateLocalStatus(worktreePath);
      const latest = yield* gitWorkflow
        .localStatus({ cwd: worktreePath })
        .pipe(Effect.orElseSucceed(() => null));
      const latestHead = yield* git
        .resolveCommit({ cwd: worktreePath, revision: "HEAD" })
        .pipe(Effect.orElseSucceed(() => null));
      if (
        !latest?.isRepo ||
        latest.refName !== workerRefName ||
        latest.hasWorkingTreeChanges ||
        latestHead?.commitSha.toLowerCase() !== head.commitSha.toLowerCase()
      ) {
        return { status: "skipped", reason: "merge-unverified" } as const;
      }
      // The native helper must use the ORIGINAL identity, never recapture a
      // potentially replaced checkout after the merge/status checks.
      // This does not fence writes through an already-open file descriptor.
      yield* nativeRemover
        .removeCaptured(captured)
        .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "remove-worktree" })));
      yield* receipts
        .markRemoved(receipt)
        .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "record-removal" })));
      yield* git
        .deleteBranchAtCommit({ cwd, refName: workerRefName, expectedCommitSha: head.commitSha })
        .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "delete-branch" })));
      yield* receipts
        .markComplete(receipt)
        .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "record-completion" })));
      return { status: "cleaned", worktreePath, deletedRefName: workerRefName } as const;
    } else {
      // A prior removal may have succeeded while branch deletion failed. If a
      // path still exists but is no longer a Git worktree, retain its files.
      const pathExists = yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
      if (pathExists) return { status: "skipped", reason: "merge-unverified" } as const;
      const branchExists = yield* git
        .localBranchRefExists({ cwd, refName: workerRefName })
        .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "read-thread" })));
      const stored = yield* receipts
        .get(threadId)
        .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "read-thread" })));
      const matchingReceipt =
        Option.isSome(stored) &&
        stored.value.worktreePath === worktreePath &&
        stored.value.branchRef === workerRefName
          ? stored.value
          : null;
      if (!branchExists) {
        if (!matchingReceipt) {
          return { status: "skipped", reason: "merge-unverified" } as const;
        }
        if (matchingReceipt.status === "complete") {
          return { status: "skipped", reason: "already-cleaned" } as const;
        }
        if (matchingReceipt.status !== "removed") {
          // A verified merge alone does not prove our remover ran.
          return { status: "skipped", reason: "safe-removal-unavailable" } as const;
        }
        yield* receipts
          .markComplete(matchingReceipt)
          .pipe(
            Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "record-completion" })),
          );
        return { status: "cleaned", worktreePath, deletedRefName: workerRefName } as const;
      }
      // A ref can exist while rev-parse fails (corrupt repository, unreadable
      // object, transient Git failure). None of those proves branch deletion.
      const branch = yield* git
        .resolveCommit({ cwd, revision: `refs/heads/${workerRefName}` })
        .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "read-thread" })));
      if (matchingReceipt?.status === "removed") {
        if (matchingReceipt.mergedHeadOid.toLowerCase() !== branch.commitSha.toLowerCase()) {
          return { status: "skipped", reason: "merge-unverified" } as const;
        }
        yield* git
          .deleteBranchAtCommit({
            cwd,
            refName: workerRefName,
            expectedCommitSha: matchingReceipt.mergedHeadOid,
          })
          .pipe(Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "delete-branch" })));
        yield* receipts
          .markComplete(matchingReceipt)
          .pipe(
            Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "record-completion" })),
          );
        return { status: "cleaned", worktreePath, deletedRefName: workerRefName } as const;
      }
      if (matchingReceipt?.status === "complete") {
        return { status: "skipped", reason: "merge-unverified" } as const;
      }
      const mergedUrl = yield* mergedAtCommit(cwd, branch.commitSha);
      if (!mergedUrl) {
        return { status: "skipped", reason: "merge-unverified" } as const;
      }
      const recorded = yield* receipts
        .recordVerified({
          threadId,
          worktreePath,
          branchRef: workerRefName,
          mergedHeadOid: branch.commitSha,
          mergedChangeRequestUrl: mergedUrl,
        })
        .pipe(
          Effect.mapError(() => new WorkerWorktreeCleanupError({ step: "record-verification" })),
        );
      if (!recorded) return { status: "skipped", reason: "merge-unverified" } as const;
      // A missing checkout plus a merged ref still says nothing about who
      // removed the checkout. Retain the ref and verified receipt for recovery.
      return { status: "skipped", reason: "safe-removal-unavailable" } as const;
    }
  });

  return WorkerWorktreeCleanup.of({ cleanupDeletedThread });
});

export const layer = Layer.effect(WorkerWorktreeCleanup, make());
