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
import {
  WorkerPullRequestStore,
  sameWorkerPullRequest,
  receiptMatchesThread,
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
      if (stopped === undefined || !stopped.terminated) return;
      if (!(yield* terminals.closeForCleanup({ threadId: thread.id }))) return;
      yield* store.markExecutionStopped(thread.id);
    }
    // Preserve checkout/history for closed or dirty/unpublished work. Merge cleanup remains separate.
    yield* engine.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`worker-pr-archive-${thread.id}`),
      threadId: thread.id,
    });
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
    if (previous && previous.state !== "open") {
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
      // A native terminal receipt is monotonic. Resume after lost acknowledgement
      // or restart even when the source-control provider is temporarily unavailable.
      if (!config.pullRequest) {
        yield* engine.dispatch({
          type: "thread.workjet-config.set",
          commandId: CommandId.make(`worker-pr-bind-${thread.id}`),
          threadId: thread.id,
          workjetConfig: retainedThread.workjetConfig,
          createdAt: thread.createdAt,
        });
        return;
      }
      yield* retire(thread, previous.executionStopped === 1);
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
      (pr.headCommitOid !== head.commitSha &&
        !(previous && pr.state !== "open" && receiptMatchesThread(previous, thread)))
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
      // Wait for the committed projection before acting on this binding.
      return;
    }
    if (pr.state === "open") return;
    yield* retire(thread, false);
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
