import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkjetConnectionId,
  NATIVE_SUPERVISOR_WORKER_CONTRACT,
  RemoteWorkerDispatchError,
  type NativeSupervisorWorkerIntent,
  type NativeSupervisorWorkerCompletion,
  type NativeSupervisorSourceRegistration,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import {
  makeNativeSupervisorWorkerDispatch,
  type NativeSupervisorWorkerSource,
} from "./NativeSupervisorWorkerDispatch.ts";
const source: NativeSupervisorWorkerSource = {
  source: {
    sourceEnvironmentId: EnvironmentId.make("desktop"),
    sourceSupervisorThreadId: ThreadId.make("supervisor"),
    projectId: ProjectId.make("project"),
  },
  scope: { connectionId: WorkjetConnectionId.make("native"), instanceId: "managed:source" },
};
const registration: NativeSupervisorSourceRegistration = {
  ...source.source,
  contract: NATIVE_SUPERVISOR_WORKER_CONTRACT,
  registrationId: "registration",
  revision: 1,
  ownerUserId: "owner",
  sourceInstanceId: source.scope.instanceId,
  authorityEpoch: 1,
  state: "active",
};
const intent: NativeSupervisorWorkerIntent = {
  ...source.source,
  intentId: ThreadId.make("00000000-0000-4000-8000-000000000001"),
  registrationId: registration.registrationId,
  registrationRevision: 1,
  task: "Open exactly one PR",
};
const completed: NativeSupervisorWorkerCompletion = {
  schemaVersion: 1,
  status: "failed",
  reason: "computer-unavailable",
};
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
    sources: Effect.succeed([
      source,
      {
        ...source,
        source: {
          ...source.source,
          sourceSupervisorThreadId: ThreadId.make("second-supervisor"),
          projectId: ProjectId.make("second-project"),
        },
      },
    ]),
    currentSource: () => Effect.sync(() => current),
    register: (value: NativeSupervisorWorkerSource) =>
      Effect.succeed({ ...registration, ...value.source }),
    poll: () =>
      Effect.sync(() => {
        polls++;
        return intents;
      }),
    dispatch: (_source: NativeSupervisorWorkerSource, value: NativeSupervisorWorkerIntent) =>
      Effect.sync(() => {
        dispatched.push(value.intentId);
        return pending ? Option.none<NativeSupervisorWorkerCompletion>() : Option.some(completed);
      }),
    complete: () =>
      Effect.gen(function* () {
        completions.push(intent.intentId);
        if (loseAck) {
          loseAck = false;
          return yield* failure();
        }
      }),
  };
  return {
    dependencies,
    dispatched,
    completions,
    polls: () => polls,
    changeParent: () => {
      current = {
        ...source,
        source: { ...source.source, sourceSupervisorThreadId: ThreadId.make("foreign-parent") },
      };
    },
    setIntent: (value: NativeSupervisorWorkerIntent) => {
      intents = [value];
    },
    setPending: () => {
      pending = true;
    },
    loseAck: () => {
      loseAck = true;
    },
  };
}
it.effect(
  "polls once globally per native scope and retries the same intent after a lost completion ACK",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.loseAck();
      const worker = makeNativeSupervisorWorkerDispatch(f.dependencies);
      yield* worker.runCycle;
      yield* worker.runCycle;
      assert.equal(f.polls(), 2);
      assert.deepEqual(f.dispatched, [intent.intentId, intent.intentId]);
      assert.deepEqual(f.completions, [intent.intentId, intent.intentId]);
    }),
);
it.effect("rereads the actual parent after an awaited poll before granting dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = fixture();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const worker = makeNativeSupervisorWorkerDispatch({
        ...f.dependencies,
        poll: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return [intent];
          }),
      });
      const fiber = yield* Effect.forkChild(worker.runCycle);
      yield* Deferred.await(entered);
      f.changeParent();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      assert.deepEqual(f.dispatched, []);
      assert.deepEqual(f.completions, []);
    }),
  ),
);
it.effect(
  "denies foreign parents and stale registration revisions; pending requests are never completed",
  () =>
    Effect.gen(function* () {
      for (const modified of [
        { ...intent, sourceSupervisorThreadId: ThreadId.make("foreign") },
        { ...intent, registrationRevision: 2 },
      ]) {
        const f = fixture();
        f.setIntent(modified);
        yield* makeNativeSupervisorWorkerDispatch(f.dependencies).runCycle;
        assert.deepEqual(f.dispatched, []);
        assert.deepEqual(f.completions, []);
      }
      const f = fixture();
      f.setPending();
      yield* makeNativeSupervisorWorkerDispatch(f.dependencies).runCycle;
      assert.deepEqual(f.dispatched, [intent.intentId]);
      assert.deepEqual(f.completions, []);
    }),
);

it.effect(
  "reports retained outcomes in the existing cycle even when there are no new intents",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      let reports = 0;
      const service = makeNativeSupervisorWorkerDispatch({
        ...f.dependencies,
        poll: () => Effect.succeed([]),
        reportOutcomes: (sources) =>
          Effect.sync(() => {
            reports++;
            assert.equal(sources.length, 2);
            assert.equal(sources[0]?.registration.registrationId, registration.registrationId);
          }),
      });
      yield* service.runCycle;
      assert.equal(reports, 1);
      assert.deepEqual(f.dispatched, []);
    }),
);

it.effect("backs off only the denied source while its instance keeps polling and reporting", () =>
  Effect.gen(function* () {
    const f = fixture();
    let now = 0;
    const attempts: string[] = [];
    let polls = 0;
    const reports: string[][] = [];
    const healthy = {
      ...source,
      source: { ...source.source, sourceSupervisorThreadId: ThreadId.make("healthy") },
    };
    const service = makeNativeSupervisorWorkerDispatch({
      ...f.dependencies,
      now: Effect.sync(() => now),
      sources: Effect.succeed([source, healthy]),
      register: (value) => {
        attempts.push(value.source.sourceSupervisorThreadId);
        return value.source.sourceSupervisorThreadId === source.source.sourceSupervisorThreadId
          ? Effect.fail(failure())
          : Effect.succeed({ ...registration, ...value.source });
      },
      poll: () => {
        polls++;
        return Effect.succeed([]);
      },
      reportOutcomes: (sources) =>
        Effect.sync(() => {
          reports.push(sources.map(({ source }) => source.source.sourceSupervisorThreadId));
        }),
    });
    yield* service.runCycle;
    yield* service.runCycle;
    now = 59_999;
    yield* service.runCycle;
    assert.deepEqual(attempts, ["supervisor", "healthy"]);
    assert.equal(polls, 3);
    assert.deepEqual(reports, [["healthy"], ["healthy"], ["healthy"]]);
    now = 60_000;
    yield* service.runCycle;
    assert.deepEqual(attempts, ["supervisor", "healthy", "supervisor"]);
    assert.equal(polls, 4);
    assert.deepEqual(reports[3], ["healthy"]);
  }),
);
it.effect("drops registration backoff when the actual source binding changes", () =>
  Effect.gen(function* () {
    const f = fixture();
    let current = source;
    const attempts: string[] = [];
    const service = makeNativeSupervisorWorkerDispatch({
      ...f.dependencies,
      now: Effect.succeed(0),
      sources: Effect.sync(() => [current]),
      register: (value) => {
        attempts.push(value.source.sourceSupervisorThreadId);
        return Effect.fail(failure());
      },
    });
    yield* service.runCycle;
    current = {
      ...source,
      source: { ...source.source, sourceSupervisorThreadId: ThreadId.make("replacement") },
    };
    yield* service.runCycle;
    current = source;
    yield* service.runCycle;
    assert.deepEqual(attempts, ["supervisor", "replacement", "supervisor"]);
  }),
);
it.effect("backs off polling and outcomes only for the instance whose poll failed", () =>
  Effect.gen(function* () {
    const f = fixture();
    let now = 0;
    const polls: string[] = [];
    const reports: string[][] = [];
    const other = {
      ...source,
      scope: { ...source.scope, instanceId: "other-instance" },
    };
    const service = makeNativeSupervisorWorkerDispatch({
      ...f.dependencies,
      now: Effect.sync(() => now),
      sources: Effect.succeed([source, other]),
      poll: (scope) => {
        polls.push(scope.instanceId);
        return scope.instanceId === source.scope.instanceId
          ? Effect.fail(failure())
          : Effect.succeed([]);
      },
      reportOutcomes: (sources) =>
        Effect.sync(() => {
          reports.push(sources.map(({ source }) => source.scope.instanceId));
        }),
    });
    yield* service.runCycle;
    yield* service.runCycle;
    now = 59_999;
    yield* service.runCycle;
    assert.deepEqual(polls, [
      "managed:source",
      "other-instance",
      "other-instance",
      "other-instance",
    ]);
    assert.deepEqual(reports, [["other-instance"], ["other-instance"], ["other-instance"]]);
    now = 60_000;
    yield* service.runCycle;
    assert.deepEqual(polls.slice(-2), ["managed:source", "other-instance"]);
  }),
);
