// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { RemoteWorkerDispatchError, type RemoteWorkerResult, type ThreadId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RemoteWorkerReceipt } from "./RemoteWorkerStore.ts";
import type { WorkerPullRequestReceipt } from "./WorkerPullRequestStore.ts";
import type { RegisteredNativeWorkerSource, NativeSupervisorWorkerSource } from "./NativeSupervisorWorkerDispatch.ts";
import { terminalReceiptFrom, type NativeWorkerTerminalReceipt } from "./NativeWorkerOutcome.ts";

export function makeNativeWorkerOutcomePublisher(dependencies: {
  readonly now: Effect.Effect<number>;
  readonly listStopped: (after: string) => Effect.Effect<ReadonlyArray<WorkerPullRequestReceipt>, RemoteWorkerDispatchError>;
  readonly readStartup: (id: ThreadId) => Effect.Effect<Option.Option<RemoteWorkerReceipt>, RemoteWorkerDispatchError>;
  readonly refresh: (receipt: WorkerPullRequestReceipt, startup: RemoteWorkerResult) => Effect.Effect<WorkerPullRequestReceipt, RemoteWorkerDispatchError>;
  readonly currentSource: (worker: RemoteWorkerReceipt) => Effect.Effect<NativeSupervisorWorkerSource, RemoteWorkerDispatchError>;
  readonly report: (source: RegisteredNativeWorkerSource, startup: RemoteWorkerResult, outcome: NativeWorkerTerminalReceipt) => Effect.Effect<number, RemoteWorkerDispatchError>;
}) {
  let cursor = "";
  const accepted = new Set<string>();
  const nextObservation = new Map<string, number>();
  const run = Effect.fn("NativeWorkerOutcomePublisher.run")(function* (
    sources: ReadonlyArray<RegisteredNativeWorkerSource>,
  ) {
    if (sources.length === 0) return;
    const receipts = yield* dependencies.listStopped(cursor);
    if (receipts.length > 16) return yield* new RemoteWorkerDispatchError({ reason: "source-unavailable" });
    cursor = receipts.at(-1)?.threadId ?? "";
    for (const receipt of receipts) {
      yield* Effect.gen(function* () {
        const saved = yield* dependencies.readStartup(receipt.threadId);
        if (Option.isNone(saved) || saved.value.response?.outcome.status !== "dispatched") return;
        const request = saved.value.request;
        const startup = saved.value.response.outcome.result;
        if (request.requestId !== startup.workerThreadId ||
            request.targetEnvironmentId !== startup.environmentId ||
            request.computerId !== startup.computerId ||
            request.parent.environmentId !== startup.parent.environmentId ||
            request.parent.threadId !== startup.parent.threadId) return;
        if (receipt.executionStopped !== 1) return;
        const current = yield* dependencies.currentSource(saved.value);
        const matched = sources.find(({ source, registration }) =>
          source.scope.connectionId === current.scope.connectionId &&
          source.scope.instanceId === current.scope.instanceId &&
          source.source.projectId === current.source.projectId &&
          source.source.sourceEnvironmentId === current.source.sourceEnvironmentId &&
          source.source.sourceSupervisorThreadId === current.source.sourceSupervisorThreadId &&
          registration.state === "active" &&
          registration.projectId === request.project.id &&
          registration.sourceEnvironmentId === request.parent.environmentId &&
          registration.sourceSupervisorThreadId === request.parent.threadId);
        if (!matched) return;
        const now = yield* dependencies.now;
        if (receipt.state === "open" && (nextObservation.get(receipt.threadId) ?? 0) > now) return;
        if (receipt.state === "open") {
          nextObservation.set(receipt.threadId, now + 60_000);
          if (nextObservation.size > 1024) {
            const oldest = nextObservation.keys().next().value;
            if (oldest !== undefined) nextObservation.delete(oldest);
          }
        }
        const observed = receipt.state === "open" ? yield* dependencies.refresh(receipt, startup) : receipt;
        const outcome = yield* terminalReceiptFrom(observed, startup);
        // Provider lookup can yield while the source binding changes. Re-read before native publication.
        const latest = yield* dependencies.currentSource(saved.value);
        if (latest.scope.connectionId !== current.scope.connectionId ||
            latest.scope.instanceId !== current.scope.instanceId ||
            latest.source.projectId !== current.source.projectId ||
            latest.source.sourceEnvironmentId !== current.source.sourceEnvironmentId ||
            latest.source.sourceSupervisorThreadId !== current.source.sourceSupervisorThreadId) return;
        const key = `${matched.source.scope.connectionId}/${matched.registration.registrationId}/${matched.registration.revision}/${receipt.threadId}/${observed.headOid}/${observed.state}`;
        if (accepted.has(key)) return;
        yield* dependencies.report(matched, startup, outcome);
        accepted.add(key);
        if (accepted.size > 1024) {
          const oldest = accepted.values().next().value;
          if (oldest !== undefined) accepted.delete(oldest);
        }
      }).pipe(Effect.ignore);
    }
  });
  return { run };
}
