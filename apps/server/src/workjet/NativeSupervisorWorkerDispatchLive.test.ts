import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  ProviderInstanceId,
  ThreadId,
  WorkjetComputerId,
  RemoteWorkerDispatchError,
  type RemoteWorkerResponse,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  reconcileNativeWorkerFailure,
  isNativeSupervisorWorkerSource,
} from "./NativeSupervisorWorkerDispatchLive.ts";
const intentId = ThreadId.make("00000000-0000-4000-8000-000000000001");
const response: RemoteWorkerResponse = {
  requestId: intentId,
  outcome: {
    status: "dispatched",
    result: {
      schemaVersion: 1,
      status: "dispatched",
      workerThreadId: intentId,
      environmentId: EnvironmentId.make("gpu3"),
      computerId: WorkjetComputerId.make("computer"),
      branch: `workjet/worker/${intentId}`,
      worktreePath: "/owned/worker",
      parent: {
        environmentId: EnvironmentId.make("source"),
        threadId: ThreadId.make("supervisor"),
      },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
      enabledCapabilityIds: [],
    },
  },
};
it.effect(
  "keeps an unacknowledged remote worker pending after current settings reject a retry",
  () =>
    Effect.gen(function* () {
      const result = yield* reconcileNativeWorkerFailure(
        () => Effect.succeed(Option.some({ response: null })),
        intentId,
        { reason: "computer-unavailable" },
      );
      assert.isTrue(Option.isNone(result));
    }),
);
it.effect(
  "reconciles a recorded successful worker even when current settings reject the retry",
  () =>
    Effect.gen(function* () {
      const result = yield* reconcileNativeWorkerFailure(
        (id) => {
          assert.equal(id, intentId);
          return Effect.succeed(Option.some({ response }));
        },
        intentId,
        { reason: "worker-profile-unavailable" },
      );
      if (response.outcome.status !== "dispatched")
        return yield* Effect.die("The success fixture must describe a dispatched worker");
      assert.deepEqual(result, Option.some(response.outcome.result));
    }),
);
it.effect("reports invalid project policy through the existing native failure contract", () =>
  Effect.gen(function* () {
    const result = yield* reconcileNativeWorkerFailure(
      () => Effect.succeed(Option.none()),
      intentId,
      { reason: "execution-policy-invalid" },
    );
    assert.deepEqual(
      result,
      Option.some({ schemaVersion: 1, status: "failed", reason: "capability-escalation" }),
    );
  }),
);

it.effect("never fabricates completion when the broker cannot establish the previous outcome", () =>
  Effect.gen(function* () {
    const result = yield* reconcileNativeWorkerFailure(
      () => Effect.fail(new RemoteWorkerDispatchError({ reason: "source-unavailable" })),
      intentId,
      { reason: "remote-dispatch-failed" },
    ).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    const terminal = yield* reconcileNativeWorkerFailure(
      () => Effect.succeed(Option.none()),
      intentId,
      { reason: "computer-unavailable" },
    );
    assert.deepEqual(
      terminal,
      Option.some({ schemaVersion: 1, status: "failed", reason: "computer-unavailable" }),
    );
  }),
);

it.effect("enumerates only live supervisors, leaving ordinary chats out of source failures", () =>
  Effect.sync(() => {
    const team = {
      role: "supervisor" as const,
      parentThreadId: null,
      projectId: ProjectId.make("project"),
      threadId: ThreadId.make("supervisor"),
      goal: "Coordinate the project",
      createdAt: "2026-10-10T00:00:00.000Z",
    };
    const parent = {
      deletedAt: null,
      archivedAt: null,
      workjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, team },
    };
    assert.isTrue(isNativeSupervisorWorkerSource(parent));
    assert.isFalse(isNativeSupervisorWorkerSource({ ...parent, archivedAt: team.createdAt }));
    assert.isFalse(isNativeSupervisorWorkerSource({ ...parent, deletedAt: team.createdAt }));
    assert.isFalse(
      isNativeSupervisorWorkerSource({ ...parent, workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG }),
    );
    assert.isFalse(
      isNativeSupervisorWorkerSource({
        ...parent,
        workjetConfig: {
          ...parent.workjetConfig,
          team: {
            ...team,
            role: "specialist",
            parentThreadId: team.threadId,
            domain: "Implementation",
          },
        },
      }),
    );
    assert.isFalse(
      isNativeSupervisorWorkerSource({
        ...parent,
        workjetConfig: {
          ...parent.workjetConfig,
          team: { ...team, role: "worker", parentThreadId: team.threadId, packageId: "package" },
        },
      }),
    );
  }),
);
