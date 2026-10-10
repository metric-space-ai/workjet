// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { RemoteWorkerDispatchError, type RemoteWorkerRequest } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { NativeWorkerTerminalReceipt, terminalReceiptFrom } from "./NativeWorkerOutcome.ts";
import { RemoteWorkerBroker } from "./RemoteWorkerBroker.ts";
import { WorkerPullRequestStore } from "./WorkerPullRequestStore.ts";

/** Copy only a stopped target's persisted terminal receipt, checked against the
 * frozen startup and the source's own GitHub observation. Model prose is never a receipt. */
export const retainRemoteWorkerOutcome = Effect.fn("retainRemoteWorkerOutcome")(function* (
  request: RemoteWorkerRequest, payload: unknown,
) {
  const fail = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
  const outcome = (yield* Schema.decodeUnknownEffect(Schema.Struct({ outcome: NativeWorkerTerminalReceipt }))(payload)
    .pipe(Effect.mapError(fail))).outcome;
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
      outcome.worker_thread_id !== startup.workerThreadId ||
      outcome.environment_id !== startup.environmentId || outcome.computer_id !== startup.computerId ||
      outcome.branch !== startup.branch)
    return yield* fail();
  const query = yield* ProjectionSnapshotQuery;
  const model = yield* query.getCommandReadModel().pipe(Effect.mapError(fail));
  const parent = model.threads.find((thread) => thread.id === request.parent.threadId);
  const project = model.projects.find((candidate) => candidate.id === request.project.id);
  if (!parent || parent.deletedAt !== null || parent.archivedAt !== null ||
      parent.projectId !== request.project.id || !project || project.deletedAt !== null ||
      project.workspaceRoot === null) return yield* fail();
  const provider = yield* (yield* SourceControlProviderRegistry)
    .resolve({ cwd: project.workspaceRoot }).pipe(Effect.mapError(fail));
  const matches = yield* provider.listChangeRequests({
    cwd: project.workspaceRoot, headSelector: startup.branch, state: "all", limit: 2,
  }).pipe(Effect.mapError(fail));
  const pr = matches[0];
  if (matches.length !== 1 || !pr || provider.kind !== "github" || pr.provider !== "github" ||
      pr.number !== outcome.pull_request.number || pr.url !== outcome.pull_request.url ||
      pr.headRefName !== startup.branch || pr.headCommitOid !== outcome.pull_request.head_oid ||
      pr.state !== outcome.pull_request.state || pr.isCrossRepository !== false)
    return yield* fail();
  const store = yield* WorkerPullRequestStore;
  if (!(yield* store.observe({
    threadId: request.requestId, worktreePath: startup.worktreePath, branchRef: startup.branch,
    provider: pr.provider, prNumber: pr.number, prUrl: pr.url,
    headOid: outcome.pull_request.head_oid, state: pr.state,
  }).pipe(Effect.mapError(fail)))) return yield* fail();
  yield* store.markExecutionStopped(request.requestId).pipe(Effect.mapError(fail));
  const retained = yield* store.get(request.requestId).pipe(Effect.mapError(fail));
  if (Option.isNone(retained)) return yield* fail();
  yield* terminalReceiptFrom(retained.value, startup);
});
