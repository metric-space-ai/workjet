// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  CommandId,
  MessageId,
  RemoteWorkerDispatchError,
  WorkjetWorkerPullRequest,
  type RemoteWorkerRequest,
  type ThreadId,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";

export const WorkerSubmission = Schema.Struct({
  pullRequest: WorkjetWorkerPullRequest,
  headOid: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
});
export type WorkerSubmission = typeof WorkerSubmission.Type;

/** Two durable commands make retries after a lost acknowledgement idempotent. */
export const publishWorkerSubmission = Effect.fn("publishWorkerSubmission")(function* (
  engine: OrchestrationEngineService["Service"],
  input: {
    readonly workerId: ThreadId;
    readonly parentId: ThreadId;
    readonly model: string;
    readonly pullRequest: WorkjetWorkerPullRequest;
    readonly createdAt: string;
  },
) {
  const messageId = MessageId.make(`worker-pr-result-${input.workerId}`);
  yield* engine.dispatch({
    type: "thread.message.assistant.delta",
    commandId: CommandId.make(`worker-pr-result-delta-${input.workerId}`),
    threadId: input.parentId,
    messageId,
    delta: `One-Shot Worker ${input.workerId} submitted [PR #${input.pullRequest.number}](${input.pullRequest.url}) (${input.model}).`,
    createdAt: input.createdAt,
  });
  yield* engine.dispatch({
    type: "thread.message.assistant.complete",
    commandId: CommandId.make(`worker-pr-result-complete-${input.workerId}`),
    threadId: input.parentId,
    messageId,
    createdAt: input.createdAt,
  });
});

/** The source channel binds the request; the source provider verifies the target's PR notice. */
export const reportRemoteWorkerSubmission = Effect.fn("reportRemoteWorkerSubmission")(function* (
  request: RemoteWorkerRequest,
  payload: unknown,
) {
  const fail = () => new RemoteWorkerDispatchError({ reason: "computer-unavailable" });
  const notice = yield* Schema.decodeUnknownEffect(WorkerSubmission)(payload).pipe(
    Effect.mapError(fail),
  );
  const environment = yield* ServerEnvironment;
  if (request.parent.environmentId !== (yield* environment.getEnvironmentId)) return yield* fail();
  const query = yield* ProjectionSnapshotQuery;
  const snapshot = yield* query.getCommandReadModel().pipe(Effect.mapError(fail));
  const parent = snapshot.threads.find((thread) => thread.id === request.parent.threadId);
  const project = snapshot.projects.find((project) => project.id === request.project.id);
  const branch = `workjet/worker/${request.requestId}`;
  if (
    !parent ||
    parent.deletedAt !== null ||
    parent.projectId !== request.project.id ||
    !project ||
    project.deletedAt !== null ||
    project.workspaceRoot === null ||
    notice.pullRequest.branch !== branch
  )
    return yield* fail();
  const registry = yield* SourceControlProviderRegistry;
  const provider = yield* registry
    .resolve({ cwd: project.workspaceRoot })
    .pipe(Effect.mapError(fail));
  const matches = yield* provider
    .listChangeRequests({
      cwd: project.workspaceRoot,
      headSelector: branch,
      state: "all",
      limit: 2,
    })
    .pipe(Effect.mapError(fail));
  const pr = matches[0];
  if (
    matches.length !== 1 ||
    !pr ||
    pr.provider !== provider.kind ||
    pr.provider !== notice.pullRequest.provider ||
    pr.number !== notice.pullRequest.number ||
    pr.url !== notice.pullRequest.url ||
    pr.headRefName !== branch ||
    pr.headCommitOid !== notice.headOid ||
    pr.isCrossRepository !== false
  )
    return yield* fail();
  yield* publishWorkerSubmission(yield* OrchestrationEngineService, {
    workerId: request.requestId,
    parentId: request.parent.threadId,
    model: request.modelSelection.model,
    pullRequest: notice.pullRequest,
    createdAt: request.createdAt,
  }).pipe(Effect.mapError(fail));
});
