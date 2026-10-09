// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  CommandId,
  type OrchestrationThread,
  type WorkjetWorkerPullRequest,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Duration from "effect/Duration";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { forkParked } from "../serverActivation.ts";
import { readWorkerSourceHarness } from "./WorkerSourceHarness.ts";
import {
  WorkerPullRequestStore,
  sameWorkerPullRequest,
  receiptMatchesThread,
  type WorkerPullRequestReceipt,
} from "./WorkerPullRequestStore.ts";

export const WORKER_PR_CYCLE_INTERVAL = Duration.minutes(1);
const BATCH_SIZE = 16;

export const make = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const registry = yield* SourceControlProviderRegistry;
  const git = yield* GitVcsDriver;
  const provider = yield* ProviderService;
  const terminals = yield* TerminalManager;
  const store = yield* WorkerPullRequestStore;
  const mutex = yield* Semaphore.make(1);
  let cursor = 0;

  const retire = Effect.fn("WorkerPullRequestLifecycle.retire")(function* (
    thread: OrchestrationThread,
    executionStopped: boolean,
  ) {
    if (!executionStopped) {
      const stopped = yield* provider.stopSession({ threadId: thread.id });
      if (stopped === undefined) {
        const sessions = yield* provider.listSessions();
        if (sessions.some((session) => session.threadId === thread.id)) return;
      } else if (!stopped.terminated) return;
      if (!(yield* terminals.closeForCleanup({ threadId: thread.id }))) return;
      const harness = readWorkerSourceHarness(thread.id);
      if (harness) yield* Effect.promise(() => harness.retire());
      yield* store.markExecutionStopped(thread.id);
    }
    // Preserve checkout and history after submission; merge cleanup remains separate.
    yield* engine.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`worker-pr-archive-${thread.id}`),
      threadId: thread.id,
    });
  });

  const finishSubmission = Effect.fn("WorkerPullRequestLifecycle.finishSubmission")(function* (
    thread: OrchestrationThread,
    receipt: WorkerPullRequestReceipt,
  ) {
    const title = `#${receipt.prNumber}: ${thread.modelSelection.model}`;
    if (thread.title !== title) {
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`worker-pr-title-${thread.id}`),
        threadId: thread.id,
        title,
      });
    }
    const model = yield* query.getCommandReadModel();
    const committed = model.threads.find((candidate) => candidate.id === thread.id);
    if (
      !committed ||
      committed.deletedAt !== null ||
      committed.archivedAt !== null ||
      committed.title !== title ||
      !receiptMatchesThread(receipt, committed)
    ) return;
    yield* retire(committed, receipt.executionStopped === 1);
  });

  const reconcile = Effect.fn("WorkerPullRequestLifecycle.reconcile")(function* (
    thread: OrchestrationThread,
  ) {
    const config = thread.workjetConfig;
    const cwd = thread.worktreePath;
    const branch = thread.branch;
    if (
      config.schemaVersion !== 2 ||
      config.role !== "worker" ||
      config.team?.role !== "worker" ||
      cwd === null ||
      branch !== `workjet/worker/${thread.id}`
    )
      return;
    const previous = Option.getOrUndefined(yield* store.get(thread.id));
    if (previous) {
      const retainedIdentity: WorkjetWorkerPullRequest = {
        provider: previous.provider,
        number: previous.prNumber,
        url: previous.prUrl,
        branch: previous.branchRef,
      };
      const retainedThread = {
        ...thread,
        workjetConfig: { ...config, pullRequest: config.pullRequest ?? retainedIdentity },
      };
      if (!receiptMatchesThread(previous, retainedThread)) return;
      // Verified submission is monotonic, including open PRs. Recover without a provider lookup.
      if (!config.pullRequest) {
        yield* engine.dispatch({
          type: "thread.workjet-config.set",
          commandId: CommandId.make(`worker-pr-bind-${thread.id}`),
          threadId: thread.id,
          workjetConfig: retainedThread.workjetConfig,
          createdAt: thread.createdAt,
        });
      }
      yield* finishSubmission(thread, previous);
      return;
    }
    const local = yield* git.statusDetailsLocal(cwd);
    if (!local.isRepo || local.branch !== branch) return;
    const head = yield* git.resolveCommit({ cwd, revision: "HEAD" });
    const source = yield* registry.resolve({ cwd });
    // Exactly one PR for this isolated branch. Ambiguous/forked/missing results never retire it.
    const candidates = yield* source.listChangeRequests({
      cwd,
      headSelector: branch,
      state: "all",
      limit: 2,
    });
    if (candidates.length !== 1) return;
    const pr = candidates[0];
    if (
      !pr ||
      pr.provider !== source.kind ||
      pr.headRefName !== branch ||
      pr.isCrossRepository !== false ||
      !pr.headCommitOid ||
      pr.headCommitOid !== head.commitSha
    )
      return;
    const identity: WorkjetWorkerPullRequest = {
      provider: pr.provider,
      number: pr.number,
      url: pr.url,
      branch,
    };
    if (config.pullRequest && !sameWorkerPullRequest(config.pullRequest, identity)) return;
    if (
      !(yield* store.observe({
        threadId: thread.id,
        worktreePath: cwd,
        branchRef: branch,
        provider: pr.provider,
        prNumber: pr.number,
        prUrl: pr.url,
        headOid: pr.headCommitOid,
        state: pr.state,
      }))
    )
      return;
    if (!config.pullRequest) {
      yield* engine.dispatch({
        type: "thread.workjet-config.set",
        commandId: CommandId.make(`worker-pr-bind-${thread.id}`),
        threadId: thread.id,
        workjetConfig: { ...config, pullRequest: identity },
        createdAt: thread.createdAt,
      });
      // The committed projection is read below before retirement.
    }
    const receipt = Option.getOrUndefined(yield* store.get(thread.id));
    if (receipt) yield* finishSubmission(thread, receipt);
  });

  const runCycle = mutex
    .withPermit(
      Effect.gen(function* () {
        const model = yield* query.getCommandReadModel();
        const workers = model.threads.filter(
          (thread) =>
            thread.deletedAt === null &&
            thread.archivedAt === null &&
            thread.workjetConfig.schemaVersion === 2 &&
            thread.workjetConfig.team?.role === "worker",
        );
        if (workers.length === 0) {
          cursor = 0;
          return;
        }
        const start = cursor % workers.length;
        const batch = Array.from(
          { length: Math.min(BATCH_SIZE, workers.length) },
          (_, index) => workers[(start + index) % workers.length],
        );
        cursor = (start + batch.length) % workers.length;
        for (const thread of batch) {
          if (!thread) continue;
          yield* reconcile(thread).pipe(
            Effect.timeout(Duration.seconds(20)),
            Effect.catchCause(() => Effect.void),
          );
        }
      }),
    )
    .pipe(
      Effect.timeout(Duration.minutes(6)),
      Effect.catchCause(() => Effect.void),
    );
  return { runCycle };
});

export class WorkerPullRequestLifecycle extends Context.Service<
  WorkerPullRequestLifecycle,
  Effect.Success<typeof make>
>()("workjet/workjet/WorkerPullRequestLifecycle") {}
export const layer = Layer.effect(
  WorkerPullRequestLifecycle,
  Effect.gen(function* () {
    const service = yield* make;
    yield* forkParked(
      service.runCycle.pipe(Effect.repeat(Schedule.spaced(WORKER_PR_CYCLE_INTERVAL))),
    );
    return service;
  }),
);
