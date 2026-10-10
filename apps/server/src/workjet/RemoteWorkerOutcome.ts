// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { RemoteWorkerDispatchError, type RemoteWorkerRequest, type RemoteWorkerResult } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { WorkerSubmission } from "./WorkerSubmission.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import { WorkerPullRequestStore, type WorkerPullRequestReceipt } from "./WorkerPullRequestStore.ts";

/** Retain a verified submission on the source before the stopped target retires.
 * The existing source cycle can observe its later terminal state after target archival. */
export const retainRemoteWorkerOutcome = Effect.fn("retainRemoteWorkerOutcome")(function* (
  request: RemoteWorkerRequest, payload: unknown,
) {
  const fail = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
  const notice = yield* Schema.decodeUnknownEffect(WorkerSubmission)(payload).pipe(Effect.mapError(fail));
  const broker = yield* RemoteWorkerBroker;
  const saved = yield* broker.read(request.requestId);
  if (Option.isNone(saved) || saved.value.response?.outcome.status !== "dispatched")
    return yield* fail();
  const startup = saved.value.response.outcome.result;
  if (saved.value.request.parent.environmentId !== request.parent.environmentId ||
      saved.value.request.parent.threadId !== request.parent.threadId ||
      saved.value.request.project.id !== request.project.id ||
      startup.parent.environmentId !== request.parent.environmentId ||
      startup.parent.threadId !== request.parent.threadId ||
      startup.environmentId !== request.targetEnvironmentId ||
      startup.computerId !== request.computerId ||
      startup.workerThreadId !== request.requestId ||
      notice.pullRequest.provider !== "github" || notice.pullRequest.branch !== startup.branch)
    return yield* fail();
  const query = yield* ProjectionSnapshotQuery;
  const model = yield* query.getCommandReadModel().pipe(Effect.mapError(fail));
  const parent = model.threads.find((thread) => thread.id === request.parent.threadId);
  const project = model.projects.find((candidate) => candidate.id === request.project.id);
  if (!parent || parent.deletedAt !== null ||
      parent.projectId !== request.project.id || !project || project.deletedAt !== null ||
      project.workspaceRoot === null) return yield* fail();
  const provider = yield* (yield* SourceControlProviderRegistry)
    .resolve({ cwd: project.workspaceRoot }).pipe(Effect.mapError(fail));
  const matches = yield* provider.listChangeRequests({
    cwd: project.workspaceRoot, headSelector: startup.branch, state: "all", limit: 2,
  }).pipe(Effect.mapError(fail));
  const pr = matches[0];
  if (matches.length !== 1 || !pr || provider.kind !== "github" || pr.provider !== "github" ||
      pr.number !== notice.pullRequest.number || pr.url !== notice.pullRequest.url ||
      pr.headRefName !== startup.branch || pr.headCommitOid !== notice.headOid ||
      pr.isCrossRepository !== false)
    return yield* fail();
  const store = yield* WorkerPullRequestStore;
  const previous = yield* store.get(request.requestId).pipe(Effect.mapError(fail));
  if (Option.isSome(previous) && previous.value.headOid !== notice.headOid) return yield* fail();
  if (!(yield* store.observe({
    threadId: request.requestId, worktreePath: startup.worktreePath, branchRef: startup.branch,
    provider: pr.provider, prNumber: pr.number, prUrl: pr.url,
    headOid: notice.headOid, state: pr.state,
  }).pipe(Effect.mapError(fail)))) return yield* fail();
  yield* store.markExecutionStopped(request.requestId).pipe(Effect.mapError(fail));
  // This entrypoint is reached only after the target's provider and terminal stop acknowledgement.
});

/** Observe a retained source submission after its target thread has been archived.
 * Never use the remote worktree path as a source checkout or change its frozen PR/head. */
export const refreshRemoteWorkerOutcome = Effect.fn("refreshRemoteWorkerOutcome")(function* (
  receipt: WorkerPullRequestReceipt, startup: RemoteWorkerResult, request: RemoteWorkerRequest,
) {
  const fail = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
  if (receipt.executionStopped !== 1 || receipt.state !== "open" ||
      receipt.threadId !== startup.workerThreadId || receipt.worktreePath !== startup.worktreePath ||
      receipt.branchRef !== startup.branch || receipt.provider !== "github") return yield* fail();
  const model = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel().pipe(Effect.mapError(fail));
  const project = model.projects.find((candidate) => candidate.id === request.project.id);
  if (!project || project.deletedAt !== null || project.workspaceRoot === null) return yield* fail();
  const provider = yield* (yield* SourceControlProviderRegistry).resolve({ cwd: project.workspaceRoot }).pipe(Effect.mapError(fail));
  const matches = yield* provider.listChangeRequests({
    cwd: project.workspaceRoot, headSelector: startup.branch, state: "all", limit: 2,
  }).pipe(Effect.mapError(fail));
  const pr = matches[0];
  if (matches.length !== 1 || !pr || provider.kind !== "github" || pr.provider !== receipt.provider ||
      pr.number !== receipt.prNumber || pr.url !== receipt.prUrl ||
      pr.headRefName !== receipt.branchRef || pr.headCommitOid !== receipt.headOid ||
      pr.isCrossRepository !== false) return yield* fail();
  const store = yield* WorkerPullRequestStore;
  const observed = { ...receipt, state: pr.state };
  if (!(yield* store.observe(observed).pipe(Effect.mapError(fail)))) return yield* fail();
  return observed;
});
