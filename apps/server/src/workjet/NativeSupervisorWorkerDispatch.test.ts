import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId, WorkjetConnectionId, NATIVE_SUPERVISOR_WORKER_CONTRACT, RemoteWorkerDispatchError, type NativeSupervisorWorkerIntent, type NativeSupervisorWorkerCompletion, type NativeSupervisorSourceRegistration } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { makeNativeSupervisorWorkerDispatch, type NativeSupervisorWorkerSource } from "./NativeSupervisorWorkerDispatch.ts";
const source: NativeSupervisorWorkerSource = {
  source: { sourceEnvironmentId: EnvironmentId.make("desktop"), sourceSupervisorThreadId: ThreadId.make("supervisor"), projectId: ProjectId.make("project") },
  scope: { connectionId: WorkjetConnectionId.make("native"), instanceId: "managed:source" },
};
const registration: NativeSupervisorSourceRegistration = { ...source.source, contract: NATIVE_SUPERVISOR_WORKER_CONTRACT, registrationId: "registration", revision: 1, ownerUserId: "owner", sourceInstanceId: source.scope.instanceId, authorityEpoch: 1, state: "active" };
const intent: NativeSupervisorWorkerIntent = { ...source.source, intentId: ThreadId.make("00000000-0000-4000-8000-000000000001"), registrationId: registration.registrationId, registrationRevision: 1, task: "Open exactly one PR" };
const completed: NativeSupervisorWorkerCompletion = { schemaVersion: 1, status: "failed", reason: "computer-unavailable" };
const failure = () => new RemoteWorkerDispatchError({ reason: "source-unavailable" });
function fixture() {
  let current = source;
  let intents: ReadonlyArray<NativeSupervisorWorkerIntent> = [intent];
  let pending = false;
  let loseAck = false;
  const dispatched: string[] = [];
  const completions: string[] = [];
  let polls = 0;
  const dependencies = {
    sources: Effect.succeed([source, { ...source, source: { ...source.source, sourceSupervisorThreadId: ThreadId.make("second-supervisor"), projectId: ProjectId.make("second-project") } }]),
    currentSource: () => Effect.sync(() => current),
    register: (value: NativeSupervisorWorkerSource) => Effect.succeed({ ...registration, ...value.source }),
    poll: () => Effect.sync(() => { polls++; return intents; }),
    dispatch: (_source: NativeSupervisorWorkerSource, value: NativeSupervisorWorkerIntent) => Effect.sync(() => { dispatched.push(value.intentId); return pending ? Option.none<NativeSupervisorWorkerCompletion>() : Option.some(completed); }),
    complete: () => Effect.gen(function* () { completions.push(intent.intentId); if (loseAck) { loseAck = false; return yield* failure(); } }),
  };
  return { dependencies, dispatched, completions, polls: () => polls, changeParent: () => { current = { ...source, source: { ...source.source, sourceSupervisorThreadId: ThreadId.make("foreign-parent") } }; }, setIntent: (value: NativeSupervisorWorkerIntent) => { intents = [value]; }, setPending: () => { pending = true; }, loseAck: () => { loseAck = true; } };
}
it.effect("polls once globally per native scope and retries the same intent after a lost completion ACK", () => Effect.gen(function* () {
  const f = fixture(); f.loseAck();
  const worker = makeNativeSupervisorWorkerDispatch(f.dependencies);
  yield* worker.runCycle; yield* worker.runCycle;
  assert.equal(f.polls(), 2);
  assert.deepEqual(f.dispatched, [intent.intentId, intent.intentId]);
  assert.deepEqual(f.completions, [intent.intentId, intent.intentId]);
}));
it.effect("rereads the actual parent after an awaited poll before granting dispatch", () => Effect.scoped(Effect.gen(function* () {
  const f = fixture();
  const entered = yield* Deferred.make<void>(); const release = yield* Deferred.make<void>();
  const worker = makeNativeSupervisorWorkerDispatch({ ...f.dependencies, poll: () => Effect.gen(function* () { yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release); return [intent]; }) });
  const fiber = yield* Effect.forkChild(worker.runCycle);
  yield* Deferred.await(entered); f.changeParent(); yield* Deferred.succeed(release, undefined); yield* Fiber.join(fiber);
  assert.deepEqual(f.dispatched, []); assert.deepEqual(f.completions, []);
})));
it.effect("denies foreign parents and stale registration revisions; pending requests are never completed", () => Effect.gen(function* () {
  for (const modified of [{ ...intent, sourceSupervisorThreadId: ThreadId.make("foreign") }, { ...intent, registrationRevision: 2 }]) {
    const f = fixture(); f.setIntent(modified); yield* makeNativeSupervisorWorkerDispatch(f.dependencies).runCycle;
    assert.deepEqual(f.dispatched, []); assert.deepEqual(f.completions, []);
  }
  const f = fixture(); f.setPending(); yield* makeNativeSupervisorWorkerDispatch(f.dependencies).runCycle;
  assert.deepEqual(f.dispatched, [intent.intentId]); assert.deepEqual(f.completions, []);
}));
