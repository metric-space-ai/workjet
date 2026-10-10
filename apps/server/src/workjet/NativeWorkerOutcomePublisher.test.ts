// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, it } from "@effect/vitest";
import { RemoteWorkerDispatchError, WorkjetComputerId, type RemoteWorkerResult } from "@workjet/contracts";
import type { RegisteredNativeWorkerSource } from "./NativeSupervisorWorkerDispatch.ts";
import type { NativeWorkerTerminalReceipt } from "./NativeWorkerOutcome.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeNativeWorkerOutcomePublisher } from "./NativeWorkerOutcomePublisher.ts";
import { persisted, registration, source, startup, worker } from "./nativeWorkerOutcomeFixture.ts";
import type { WorkerPullRequestReceipt } from "./WorkerPullRequestStore.ts";
function fixture() {
  let receipt: WorkerPullRequestReceipt = persisted;
  let current = source;
  let hasStartup = true;
  let acknowledgement = startup;
  let lostAck = false;
  let now = 0;
  const reports: string[] = [];
  const dependencies = {
    listStopped: (after: string) => Effect.succeed(after === "" ? [receipt] : []),
    refresh: (saved: WorkerPullRequestReceipt) => Effect.succeed(saved),
    readStartup: () => Effect.succeed(hasStartup ? Option.some({
      request: worker, worktreePath: startup.worktreePath,
      response: { requestId: worker.requestId, outcome: { status: "dispatched" as const, result: acknowledgement } },
    }) : Option.none()),
    currentSource: () => Effect.sync(() => current),
    report: (_source: RegisteredNativeWorkerSource, _startup: RemoteWorkerResult, outcome: NativeWorkerTerminalReceipt) => Effect.gen(function* () {
      reports.push(outcome.pull_request.state);
      if (lostAck) { lostAck = false; return yield* new RemoteWorkerDispatchError({ reason: "source-unavailable" }); }
      return 123;
    }),
  };
  return { dependencies, reports, changeReceipt: (value: WorkerPullRequestReceipt) => { receipt = value; },
    revoke: () => { current = { ...source, scope: { ...source.scope, instanceId: "replacement" } }; },
    advance: () => { now += 60_000; },
    changeStartup: (value: RemoteWorkerResult) => { acknowledgement = value; },
    noStartup: () => { hasStartup = false; }, loseAck: () => { lostAck = true; },
  };
}
const registered = [{ source, registration }];
it.effect("replays an exact lost ACK, caches only success, and recovers after source restart", () =>
  Effect.gen(function* () {
    const f = fixture(); f.loseAck();
    const publisher = makeNativeWorkerOutcomePublisher(f.dependencies);
    yield* publisher.run(registered); yield* publisher.run(registered); yield* publisher.run(registered);
    yield* publisher.run(registered); yield* publisher.run(registered);
    assert.deepEqual(f.reports, ["merged", "merged"]);
    yield* makeNativeWorkerOutcomePublisher(f.dependencies).run(registered);
    assert.deepEqual(f.reports, ["merged", "merged", "merged"]);
  }));
it.effect("does not publish an open/executing receipt, missing startup, or replaced source", () =>
  Effect.gen(function* () {
    for (const receipt of [{ ...persisted, state: "open" as const }, { ...persisted, executionStopped: 0 }]) {
      const f = fixture(); f.changeReceipt(receipt);
      yield* makeNativeWorkerOutcomePublisher(f.dependencies).run(registered);
      assert.deepEqual(f.reports, []);
    }
    for (const mutate of [(f: ReturnType<typeof fixture>) => f.noStartup(), (f: ReturnType<typeof fixture>) => f.revoke()]) {
      const f = fixture(); mutate(f);
      yield* makeNativeWorkerOutcomePublisher(f.dependencies).run(registered);
      assert.deepEqual(f.reports, []);
    }
  }));
it.effect("rejects an unbounded candidate page and never polls without registered source authority", () =>
  Effect.gen(function* () {
    const f = fixture();
    const publisher = makeNativeWorkerOutcomePublisher({ ...f.dependencies,
      listStopped: () => Effect.succeed(Array.from({ length: 17 }, () => persisted)) });
    assert.equal((yield* publisher.run(registered).pipe(Effect.result))._tag, "Failure");
    yield* publisher.run([]);
    assert.deepEqual(f.reports, []);
  }));

it.effect("refreshes a retained open PR to terminal without a live target and replays after restart", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.changeReceipt({ ...persisted, state: "open" });
    let state: "open" | "merged" = "open";
    let refreshes = 0;
    const dependencies = { ...f.dependencies,
      refresh: (receipt: WorkerPullRequestReceipt) => Effect.sync(() => {
        refreshes++; return { ...receipt, state };
      }),
    };
    const publisher = makeNativeWorkerOutcomePublisher(dependencies);
    yield* publisher.run(registered);
    assert.deepEqual(f.reports, []);
    state = "merged";
    // The existing five-second dispatch cycle does not spam GitHub while a submitted PR stays open.
    yield* publisher.run(registered); yield* publisher.run(registered);
    assert.equal(refreshes, 1);
    f.advance();
    yield* publisher.run(registered); yield* publisher.run(registered);
    assert.deepEqual(f.reports, ["merged"]);
    yield* makeNativeWorkerOutcomePublisher(dependencies).run(registered);
    assert.equal(refreshes, 3);
    assert.deepEqual(f.reports, ["merged", "merged"]);
  }));

it.effect("re-reads source authority after provider observation and refuses a binding swap", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.changeReceipt({ ...persisted, state: "open" });
    const publisher = makeNativeWorkerOutcomePublisher({ ...f.dependencies,
      refresh: () => Effect.sync(() => { f.revoke(); return persisted; }),
    });
    yield* publisher.run(registered);
    assert.deepEqual(f.reports, []);
  }));

it.effect("refuses a startup acknowledgement for a different worker, target or parent", () =>
  Effect.gen(function* () {
    for (const wrong of [
      { ...startup, workerThreadId: worker.parent.threadId },
      { ...startup, environmentId: worker.parent.environmentId },
      { ...startup, computerId: WorkjetComputerId.make("foreign-computer") },
      { ...startup, parent: { ...startup.parent, threadId: worker.requestId } },
      { ...startup, parent: { ...startup.parent, environmentId: worker.targetEnvironmentId } },
    ]) {
      const f = fixture(); f.changeStartup(wrong);
      yield* makeNativeWorkerOutcomePublisher(f.dependencies).run(registered);
      assert.deepEqual(f.reports, []);
    }
  }));
