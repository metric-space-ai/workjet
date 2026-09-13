import { describe, expect, it } from "@effect/vitest";
import { WorkjetConnectionId, type WorkjetDecisionHubProvisionInput } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration55 from "../../persistence/Migrations/055_WorkjetDecisionHub.ts";
import migration59 from "../../persistence/Migrations/059_WorkjetCtoxConnectionBindings.ts";
import { DecisionHubMcpClient } from "./DecisionHubMcpClient.ts";
import { DecisionHubConnectionRegistry, layer } from "./DecisionHubConnectionRegistry.ts";

const input: WorkjetDecisionHubProvisionInput = {
  connectionId: WorkjetConnectionId.make("ctox-connection-a"),
  instanceId: "instance-a",
  displayName: "Instance A",
  source: "ctox_dev",
  endpoint: "https://mcp.ctox.dev/mcp/instance-a",
  token: "test-token-a",
};

const fixture = Effect.gen(function* () {
  yield* migration55;
  yield* migration59;
  const secrets = new Map<string, Uint8Array>();
  let writes = 0;
  const secretStore = ServerSecretStore.of({
    get: (name) =>
      Effect.sync(() => {
        const value = secrets.get(name);
        return value === undefined ? Option.none() : Option.some(value.slice());
      }),
    set: (name, value) =>
      Effect.sync(() => {
        secrets.set(name, value.slice());
        writes++;
      }),
    remove: (name) =>
      Effect.sync(() => {
        secrets.delete(name);
      }),
    create: () => Effect.die("Not used by the connection registry"),
    getOrCreateRandom: () => Effect.die("Not used by the connection registry"),
  });
  const client = DecisionHubMcpClient.of({
    probe: () => Effect.void,
    requestDecision: () => Effect.die("Not used by the connection registry"),
    getDecision: () => Effect.die("Not used by the connection registry"),
  });
  const open = DecisionHubConnectionRegistry.pipe(
    Effect.provide(layer),
    Effect.provideService(ServerSecretStore, secretStore),
    Effect.provideService(DecisionHubMcpClient, client),
  );
  return { open, writes: () => writes };
});

const otherInstance = {
  ...input,
  instanceId: "instance-b",
  endpoint: "https://mcp.ctox.dev/mcp/instance-b",
  token: "test-token-b",
};

describe("durable CTOX connection identity", () => {
  it.effect("rejects a managed endpoint naming another instance before storing credentials", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const registry = yield* test.open;
      expect(
        yield* Effect.flip(registry.provision({ ...input, endpoint: otherInstance.endpoint })),
      ).toMatchObject({ reason: "connection-instance-mismatch" });
      expect(test.writes()).toBe(0);
      expect(yield* registry.list).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("rejects reassignment before changing the credentials used by an existing thread", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const registry = yield* test.open;
      yield* registry.provision(input);
      expect(yield* Effect.flip(registry.provision(otherInstance))).toMatchObject({
        reason: "connection-instance-mismatch",
      });
      expect(test.writes()).toBe(1);
      expect(yield* registry.resolveReadyTarget(input.connectionId, input.instanceId)).toEqual({
        schemaVersion: 1,
        endpoint: input.endpoint,
        token: input.token,
      });
      expect(
        yield* Effect.flip(registry.resolveReadyTarget(input.connectionId, "instance-b")),
      ).toMatchObject({ reason: "connection-instance-mismatch" });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect(
    "retains identity across disconnect and registry reconstruction while allowing credential rotation",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture;
        const first = yield* test.open;
        yield* first.provision(input);
        expect(yield* first.disconnect(input.connectionId)).toBe(true);
        expect(yield* first.list).toEqual([]);
        const reopened = yield* test.open;
        expect(yield* Effect.flip(reopened.provision(otherInstance))).toMatchObject({
          reason: "connection-instance-mismatch",
        });
        expect(test.writes()).toBe(1);
        yield* reopened.provision({ ...input, token: "rotated-test-token" });
        expect(
          (yield* reopened.resolveReadyTarget(input.connectionId, input.instanceId)).token,
        ).toBe("rotated-test-token");
        expect(test.writes()).toBe(2);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("allows only one instance to claim a connection when independent registries race", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const first = yield* test.open;
      const second = yield* test.open;
      const attempts = yield* Effect.all(
        [
          first.provision(input).pipe(Effect.result),
          second.provision(otherInstance).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      expect(attempts.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(attempts.filter((result) => result._tag === "Failure")).toHaveLength(1);
      expect(test.writes()).toBe(1);
      const connections = yield* first.list;
      expect(connections).toHaveLength(1);
      const winner = connections[0]!;
      const target = yield* first.resolveReadyTarget(input.connectionId, winner.instanceId);
      expect(target.endpoint).toBe(`https://mcp.ctox.dev/mcp/${winner.instanceId}`);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
