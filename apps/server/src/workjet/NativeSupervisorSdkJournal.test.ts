// @effect-diagnostics nodeBuiltinImport:off -- Actual owned Node child fixtures, not actual SDK/model/authority evidence.
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { NativeSupervisorSdkJournal, type NativeSupervisorSdkObservation } from "./NativeSupervisorSdkJournal.ts";

const fixtureChild = Effect.fn("NativeSupervisorSdkJournal.fixtureChild")(function* () {
  const child = NodeChildProcess.spawn(process.execPath, [
    "-e", 'process.stdin.once("data", () => process.exit(0));',
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  }));
  return { child, closed, finish: () => child.stdin.end("finish") };
});

it.effect("joins nonempty actual child close, stream/query callbacks and serialized sink; no DTO stop claims", () =>
  Effect.gen(function* () {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observations: Array<NativeSupervisorSdkObservation> = [];
    const journal = new NativeSupervisorSdkJournal(async record => {
      await gate;
      observations.push(record);
    });
    const { child, closed, finish } = yield* fixtureChild();
    journal.captureOwnedSdkChild(child);
    const stream = journal.sdkStreamJoined();
    const query = journal.sdkQueryCloseReturned();
    let drained = false;
    const signal = new AbortController();
    const done = journal.drain(signal.signal).then(() => { drained = true; });
    finish();
    yield* Effect.promise(() => closed);
    expect(drained).toBe(false);
    expect(observations).toEqual([]);
    release();
    yield* Effect.promise(() => Promise.all([stream, query, done]));
    expect(observations.map(record => [record.sequence, record.kind])).toEqual([
      [0, "child-spawned"], [1, "sdk-stream-joined"],
      [2, "sdk-query-close-returned"], [3, "child-closed"],
    ]);
    expect(observations[0]).toMatchObject({ pid: child.pid });
    expect(observations[3]).toMatchObject({ pid: child.pid, exitCode: 0, signal: null });
    expect(journal.currentSdkSessionId()).toBeUndefined();
  }).pipe(Effect.scoped),
);
it.effect("does not drain an empty captured process set even when close callbacks are reported", () =>
  Effect.gen(function* () {
    const records: Array<NativeSupervisorSdkObservation> = [];
    const journal = new NativeSupervisorSdkJournal(async record => { records.push(record); });
    yield* Effect.promise(() => journal.sdkStreamJoined());
    yield* Effect.promise(() => journal.sdkQueryCloseReturned());
    const abort = new AbortController();
    const stopped = journal.drain(abort.signal).then(() => "unexpected-success", () => "aborted");
    abort.abort(new Error("fixture-empty-process-set"));
    expect(yield* Effect.promise(() => stopped)).toBe("aborted");
    expect(records.map(record => record.kind)).toEqual(["sdk-stream-joined", "sdk-query-close-returned"]);
  }).pipe(Effect.scoped),
);
it.effect("waits for every actually captured child and refuses duplicate capture", () =>
  Effect.gen(function* () {
    const journal = new NativeSupervisorSdkJournal(async () => {});
    const first = yield* fixtureChild();
    const second = yield* fixtureChild();
    journal.captureOwnedSdkChild(first.child);
    journal.captureOwnedSdkChild(second.child);
    expect(() => journal.captureOwnedSdkChild(first.child)).toThrow("already captured");
    yield* Effect.promise(() => journal.sdkStreamJoined());
    yield* Effect.promise(() => journal.sdkQueryCloseReturned());
    let drained = false;
    const signal = new AbortController();
    const stopped = journal.drain(signal.signal).then(() => { drained = true; });
    first.finish();
    yield* Effect.promise(() => first.closed);
    expect(drained).toBe(false);
    second.finish();
    yield* Effect.promise(() => stopped);
    expect(drained).toBe(true);
  }).pipe(Effect.scoped),
);
it.effect("sink failure cannot become a successful observed drain", () =>
  Effect.gen(function* () {
    const journal = new NativeSupervisorSdkJournal(async () => { throw new Error("fixture durable sink unavailable"); });
    const fixture = yield* fixtureChild();
    journal.captureOwnedSdkChild(fixture.child);
    const query = journal.sdkQueryCloseReturned().catch(() => undefined);
    fixture.finish();
    yield* Effect.promise(() => fixture.closed);
    yield* Effect.promise(() => query);
    const signal = new AbortController();
    const outcome = yield* Effect.promise(() => journal.drain(signal.signal).then(() => "unexpected-success", () => "sink-failed"));
    expect(outcome).toBe("sink-failed");
    expect(journal.currentSdkSessionId()).toBeUndefined();
  }).pipe(Effect.scoped),
);
