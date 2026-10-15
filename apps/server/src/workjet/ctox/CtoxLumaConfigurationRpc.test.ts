import { assert, it } from "@effect/vitest";
import {
  WorkjetConfiguration,
  WorkjetConnectionId,
  WorkjetDecisionHubConnectionError,
  extractLumaInstanceDocument,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeCtoxLumaConfigurationRpc } from "./CtoxLumaConfigurationRpc.ts";

const scope = {
  connectionId: WorkjetConnectionId.make("instance-connection"),
  instanceId: "instance-a",
};
const configuration = extractLumaInstanceDocument(Schema.decodeSync(WorkjetConfiguration)({}));
const credentials = {
  endpoint: "https://native.invalid/mcp/instance-a",
  token: "synthetic-test-token",
};

it.effect(
  "reads and updates only the explicit authenticated instance, with the original revision",
  () =>
    Effect.gen(function* () {
      const scopes: Array<readonly [string, string | undefined]> = [];
      const writes: Array<number> = [];
      const rpc = makeCtoxLumaConfigurationRpc({
        connections: {
          resolveReadyTarget: (connectionId, instanceId) =>
            Effect.sync(() => {
              scopes.push([connectionId, instanceId]);
              return credentials;
            }),
        },
        client: {
          read: (target) => {
            assert.deepEqual(target, credentials);
            return Effect.succeed({ revision: 4, configuration, updatedAtMs: 1 });
          },
          save: (target, revision, value) =>
            Effect.sync(() => {
              assert.deepEqual(target, credentials);
              assert.deepEqual(value, configuration);
              writes.push(revision);
              return { status: "conflict" as const, revision: 5 };
            }),
        },
      });
      assert.equal((yield* rpc.read(scope)).revision, 4);
      assert.deepEqual(yield* rpc.update({ target: scope, expectedRevision: 4, configuration }), {
        status: "conflict",
        revision: 5,
      });
      assert.deepEqual(scopes, [
        [scope.connectionId, "instance-a"],
        [scope.connectionId, "instance-a"],
      ]);
      assert.deepEqual(writes, [4]);
    }),
);

it.effect("refuses a disconnected or mismatched instance before reading or writing", () =>
  Effect.gen(function* () {
    let calls = 0;
    const rpc = makeCtoxLumaConfigurationRpc({
      connections: {
        resolveReadyTarget: () =>
          Effect.fail(
            new WorkjetDecisionHubConnectionError({ reason: "connection-instance-mismatch" }),
          ),
      },
      client: {
        read: () =>
          Effect.sync(() => {
            calls++;
            return { revision: 0, configuration: null, updatedAtMs: null };
          }),
        save: () =>
          Effect.sync(() => {
            calls++;
            return { status: "saved" as const, revision: 1 };
          }),
      },
    });
    assert.equal((yield* Effect.flip(rpc.read(scope))).reason, "connection-unavailable");
    assert.equal(
      (yield* Effect.flip(rpc.update({ target: scope, expectedRevision: 0, configuration })))
        .reason,
      "connection-unavailable",
    );
    assert.equal(calls, 0);
  }),
);

it.effect(
  "dispatch uses the selected instance definitions and keeps computer enrollment local",
  () =>
    Effect.gen(function* () {
      const local = yield* Schema.decodeUnknownEffect(WorkjetConfiguration)({});
      const rpc = makeCtoxLumaConfigurationRpc({
        connections: {
          resolveReadyTarget: (_connection, instanceId) =>
            Effect.succeed({
              ...credentials,
              token: instanceId ?? "",
            }),
        },
        client: {
          read: (target) =>
            Effect.succeed({
              revision: 1,
              configuration: { ...configuration, managedSystemPrompt: target.token },
              updatedAtMs: 1,
            }),
          save: () => Effect.succeed({ status: "saved" as const, revision: 2 }),
        },
      });
      const first = yield* rpc.resolveDispatch(scope, local);
      const second = yield* rpc.resolveDispatch({ ...scope, instanceId: "instance-b" }, local);
      assert.equal(first.managedSystemPrompt, "instance-a");
      assert.equal(second.managedSystemPrompt, "instance-b");
      assert.strictEqual(first.computers, local.computers);
      assert.equal(first.selectedComputerId, local.selectedComputerId);
      assert.deepEqual(local, yield* Schema.decodeUnknownEffect(WorkjetConfiguration)({}));
    }),
);
