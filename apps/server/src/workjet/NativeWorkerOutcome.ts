// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { RemoteWorkerDispatchError, type RemoteWorkerResult } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { WorkerPullRequestReceipt } from "./WorkerPullRequestStore.ts";

// Consumer of CTOX's workjet-worker-outcome-v1.json; reports are not reviewed completion.
const bounded = (max: number) => Schema.NonEmptyString.check(Schema.isMaxLength(max));
export const NativeWorkerTerminalReceipt = Schema.Struct({
  schema: Schema.Literal("ctox.workjet.worker-outcome.v1"),
  worker_thread_id: bounded(128),
  environment_id: bounded(256),
  computer_id: bounded(256),
  branch: bounded(256),
  execution_stopped: Schema.Literal(true),
  pull_request: Schema.Struct({
    provider: Schema.Literal("github"),
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    url: bounded(2048),
    head_oid: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
    state: Schema.Literals(["merged", "closed"]),
  }),
}).check(Schema.makeFilter((receipt) =>
  receipt.branch === `workjet/worker/${receipt.worker_thread_id}` &&
  new RegExp(`^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/${receipt.pull_request.number}$`).test(receipt.pull_request.url)
  || "Outcome must match an isolated branch and exact GitHub PR URL"));
export type NativeWorkerTerminalReceipt = typeof NativeWorkerTerminalReceipt.Type;

export const terminalReceiptFrom = Effect.fn("NativeWorkerOutcome.fromPersistedReceipt")(function* (
  receipt: WorkerPullRequestReceipt,
  startup: RemoteWorkerResult,
) {
  const fail = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
  if (receipt.threadId !== startup.workerThreadId ||
      receipt.worktreePath !== startup.worktreePath ||
      receipt.branchRef !== startup.branch ||
      receipt.executionStopped !== 1)
    return yield* fail();
  return yield* Schema.decodeUnknownEffect(NativeWorkerTerminalReceipt)({
    schema: "ctox.workjet.worker-outcome.v1",
    worker_thread_id: receipt.threadId,
    environment_id: startup.environmentId,
    computer_id: startup.computerId,
    branch: receipt.branchRef,
    execution_stopped: true,
    pull_request: {
      provider: receipt.provider, number: receipt.prNumber, url: receipt.prUrl,
      head_oid: receipt.headOid, state: receipt.state,
    },
  }).pipe(Effect.mapError(fail));
});
