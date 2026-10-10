import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetDecisionHubConnectionError,
  NATIVE_SUPERVISOR_WORKER_CONTRACT,
  type NativeSupervisorSourceRegistration,
  type NativeSupervisorWorkerIntent,
  type NativeSupervisorWorkerCompletion,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { CtoxMcpTransportError, type makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import { makeCtoxNativeSupervisorWorkers } from "./CtoxNativeSupervisorWorkers.ts";
const scope = { connectionId: WorkjetConnectionId.make("native"), instanceId: "managed:source" };
const source = {
  sourceEnvironmentId: EnvironmentId.make("desktop"),
  sourceSupervisorThreadId: ThreadId.make("supervisor"),
  projectId: ProjectId.make("project"),
};
const registration: NativeSupervisorSourceRegistration = {
  ...source,
  contract: NATIVE_SUPERVISOR_WORKER_CONTRACT,
  registrationId: "registration",
  revision: 3,
  ownerUserId: "owner",
  sourceInstanceId: scope.instanceId,
  authorityEpoch: 1,
  state: "active",
};
const intent: NativeSupervisorWorkerIntent = {
  ...source,
  intentId: ThreadId.make("00000000-0000-4000-8000-000000000001"),
  registrationId: registration.registrationId,
  registrationRevision: registration.revision,
  task: "One PR",
};
const dispatched: NativeSupervisorWorkerCompletion = {
  schemaVersion: 1,
  status: "dispatched",
  environmentId: EnvironmentId.make("gpu3"),
  workerThreadId: intent.intentId,
  computerId: WorkjetComputerId.make("native-computer"),
  branch: `workjet/worker/${intent.intentId}`,
  worktreePath: "/isolated/worker",
  parent: { environmentId: source.sourceEnvironmentId, threadId: source.sourceSupervisorThreadId },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  enabledCapabilityIds: [],
};
function fixture() {
  let connected = true;
  let token = "current-owner-token";
  let reply: unknown = registration;
  const calls: Array<{ token: string; args: Record<string, unknown> }> = [];
  const probes: string[][] = [];
  const transport: ReturnType<typeof makeCtoxMcpTransport> = {
    probe: (_target, tools) =>
      Effect.sync(() => {
        probes.push([...tools]);
        return undefined;
      }),
    callTool: (target, tool, args) =>
      Effect.sync(() => {
        assert.equal(tool, "business_os.workjet_worker_dispatch");
        calls.push({ token: target.token, args });
        return { structuredContent: reply };
      }),
  };
  const client = makeCtoxNativeSupervisorWorkers({
    transport,
    connections: {
      probe: () => Effect.die("No authentication rejection in this fixture"),
      resolveReadyTarget: (connectionId, instanceId) => {
        assert.equal(connectionId, scope.connectionId);
        assert.equal(instanceId, scope.instanceId);
        return connected
          ? Effect.succeed({ endpoint: "https://native.invalid/mcp", token })
          : Effect.fail(
              new WorkjetDecisionHubConnectionError({ reason: "connection-unavailable" }),
            );
      },
    },
  });
  return {
    client,
    calls,
    probes,
    reply: (value: unknown) => {
      reply = value;
    },
    disconnect: () => {
      connected = false;
    },
    rotate: () => {
      token = "new-current-owner-token";
    },
  };
}
it.effect(
  "resolves the current connection for every operation and checks exact source registration",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.client.register(scope, source);
      assert.deepEqual(f.probes, [["business_os.workjet_worker_dispatch"]]);
      f.rotate();
      f.reply({ contract: NATIVE_SUPERVISOR_WORKER_CONTRACT, intents: [] });
      yield* f.client.poll(scope, source.sourceEnvironmentId);
      assert.deepEqual(
        f.calls.map((call) => call.token),
        ["current-owner-token", "new-current-owner-token"],
      );
      assert.deepEqual(f.calls[1]?.args, {
        action: "poll",
        source_environment_id: source.sourceEnvironmentId,
      });
      f.reply({ ...registration, sourceSupervisorThreadId: "foreign" });
      assert.equal((yield* f.client.register(scope, source).pipe(Effect.result))._tag, "Failure");
      f.disconnect();
      const count = f.calls.length;
      assert.equal(
        (yield* f.client.poll(scope, source.sourceEnvironmentId).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(f.calls.length, count);
    }),
);
it.effect("rejects unbounded, foreign-environment and wrong-contract poll receipts", () =>
  Effect.gen(function* () {
    const f = fixture();
    for (const reply of [
      { contract: NATIVE_SUPERVISOR_WORKER_CONTRACT, intents: [intent, intent] },
      {
        contract: NATIVE_SUPERVISOR_WORKER_CONTRACT,
        intents: [{ ...intent, sourceEnvironmentId: "foreign" }],
      },
      { contract: "another-contract", intents: [intent] },
    ]) {
      f.reply(reply);
      assert.equal(
        (yield* f.client.poll(scope, source.sourceEnvironmentId).pipe(Effect.result))._tag,
        "Failure",
      );
    }
    f.reply({ contract: NATIVE_SUPERVISOR_WORKER_CONTRACT, intents: [intent] });
    assert.deepEqual(yield* f.client.poll(scope, source.sourceEnvironmentId), [intent]);
  }),
);
it.effect("completes only the exact parent, worker intent and matching native ACK", () =>
  Effect.gen(function* () {
    const f = fixture();
    assert.equal(dispatched.status, "dispatched");
    if (dispatched.status !== "dispatched") return;
    for (const result of [
      { ...dispatched, workerThreadId: ThreadId.make("another-worker") },
      {
        ...dispatched,
        parent: { ...dispatched.parent, threadId: ThreadId.make("foreign-parent") },
      },
    ])
      assert.equal(
        (yield* f.client.complete(scope, registration, intent, result).pipe(Effect.result))._tag,
        "Failure",
      );
    assert.equal(
      (yield* f.client
        .complete(scope, registration, { ...intent, registrationRevision: 4 }, dispatched)
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(f.calls.length, 0);
    const ack = {
      contract: NATIVE_SUPERVISOR_WORKER_CONTRACT,
      registrationId: registration.registrationId,
      revision: registration.revision,
      intentId: intent.intentId,
    };
    for (const reply of [
      { ...ack, intentId: "another-intent" },
      { ...ack, revision: 4 },
    ]) {
      f.reply(reply);
      assert.equal(
        (yield* f.client.complete(scope, registration, intent, dispatched).pipe(Effect.result))
          ._tag,
        "Failure",
      );
    }
    f.reply(ack);
    yield* f.client.complete(scope, registration, intent, dispatched);
    assert.deepEqual(f.calls.at(-1)?.args, {
      action: "complete",
      registration_id: registration.registrationId,
      revision: registration.revision,
      intent_id: intent.intentId,
      result: dispatched,
    });
  }),
);

it.effect(
  "publishes only an exact current-source terminal receipt and verifies the immutable native ACK",
  () =>
    Effect.gen(function* () {
      if (dispatched.status !== "dispatched")
        return yield* Effect.die("dispatched fixture required");
      const f = fixture();
      const outcome: import("../NativeWorkerOutcome.ts").NativeWorkerTerminalReceipt = {
        schema: "ctox.workjet.worker-outcome.v1",
        worker_thread_id: intent.intentId,
        environment_id: dispatched.environmentId,
        computer_id: dispatched.computerId,
        branch: dispatched.branch,
        execution_stopped: true,
        pull_request: {
          provider: "github",
          number: 7,
          url: "https://github.com/owner/repo/pull/7",
          head_oid: "a".repeat(40),
          state: "merged",
        },
      };
      const ack = {
        provenance: "authenticated_source_report",
        accepted_at_ms: 123,
        registration_revision: registration.revision,
        receipt: outcome,
      };
      f.reply(ack);
      assert.equal(yield* f.client.reportOutcome(scope, registration, dispatched, outcome), 123);
      assert.deepEqual(f.calls.at(-1)?.args, {
        action: "report_outcome",
        registration_id: registration.registrationId,
        revision: registration.revision,
        intent_id: intent.intentId,
        receipt: outcome,
      });
      f.rotate();
      yield* f.client.reportOutcome(scope, registration, dispatched, outcome);
      assert.equal(f.calls.at(-1)?.token, "new-current-owner-token");
      const count = f.calls.length;
      for (const altered of [
        { ...outcome, environment_id: "foreign" },
        { ...outcome, computer_id: "foreign" },
        { ...outcome, branch: "foreign" },
        { ...outcome, worker_thread_id: "foreign" },
      ])
        assert.equal(
          (yield* f.client
            .reportOutcome(scope, registration, dispatched, altered)
            .pipe(Effect.result))._tag,
          "Failure",
        );
      assert.equal(f.calls.length, count);
      for (const reply of [
        { ...ack, registration_revision: 4 },
        {
          ...ack,
          receipt: {
            ...outcome,
            pull_request: { ...outcome.pull_request, head_oid: "b".repeat(40) },
          },
        },
      ]) {
        f.reply(reply);
        assert.equal(
          (yield* f.client
            .reportOutcome(scope, registration, dispatched, outcome)
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }
      f.disconnect();
      const disconnected = f.calls.length;
      assert.equal(
        (yield* f.client
          .reportOutcome(scope, registration, dispatched, outcome)
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(f.calls.length, disconnected);
    }),
);

it.effect("retires a rejected shared source before registering the other project parents", () =>
  Effect.gen(function* () {
    let ready = true;
    let requests = 0;
    let authChecks = 0;
    const client = makeCtoxNativeSupervisorWorkers({
      connections: {
        resolveReadyTarget: () =>
          ready
            ? Effect.succeed({ endpoint: "https://native.invalid/mcp", token: "rejected-token" })
            : Effect.fail(
                new WorkjetDecisionHubConnectionError({ reason: "connection-unavailable" }),
              ),
        probe: () =>
          Effect.sync(() => {
            authChecks++;
            ready = false;
            return {
              connectionId: scope.connectionId,
              instanceId: scope.instanceId,
              displayName: "Project workers",
              source: "ctox_dev" as const,
              status: "needs_auth" as const,
              reason: "authentication-required",
            };
          }),
      },
      transport: {
        probe: () =>
          Effect.suspend(() => {
            requests++;
            return Effect.fail(new CtoxMcpTransportError({ reason: "authentication-required" }));
          }),
        callTool: () => Effect.die("A rejected probe cannot call a worker tool"),
      },
    });
    for (let index = 0; index < 12; index++) {
      const result = yield* client
        .register(scope, { ...source, sourceSupervisorThreadId: ThreadId.make("parent-" + index) })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }
    assert.equal(requests, 1);
    assert.equal(authChecks, 1);
  }),
);

it.effect("keeps a newly authorized source usable after a late rejection of the old token", () =>
  Effect.gen(function* () {
    let checks = 0;
    const client = makeCtoxNativeSupervisorWorkers({
      connections: {
        resolveReadyTarget: () =>
          Effect.succeed({ endpoint: "https://native.invalid/mcp", token: "current-token" }),
        probe: () =>
          Effect.sync(() => {
            checks++;
            return {
              connectionId: scope.connectionId,
              instanceId: scope.instanceId,
              displayName: "Project workers",
              source: "ctox_dev" as const,
              status: "ready" as const,
              reason: null,
            };
          }),
      },
      transport: {
        probe: () => Effect.succeed(undefined),
        callTool: () =>
          checks === 0
            ? Effect.fail(new CtoxMcpTransportError({ reason: "authentication-required" }))
            : Effect.succeed({ structuredContent: registration }),
      },
    });
    assert.equal((yield* client.register(scope, source).pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(yield* client.register(scope, source), registration);
    assert.equal(checks, 1);
  }),
);
