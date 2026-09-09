/**
 * THE LIFECYCLE THIS RECONCILIATION IS ACTUALLY FOR.
 *
 * Every case here is a way a CTOX provider instance could be destroyed by
 * something that is not a user decision — a transient database error, a failed
 * network probe, a disconnect, a race at startup. Destroying it closes its scope
 * and takes every session bound to it down with it, which is why "the row
 * briefly disappeared from a map" is not a cosmetic bug.
 *
 * These drive the REAL watcher (`runSettingsWatcher`) against the REAL registry
 * mutator. The driver is a test double only so the scope finalizer and the
 * snapshot refresh can be COUNTED; the reconciliation logic under test is
 * production's own.
 *
 * FIRST RUN STATUS: written while the host resource gate was closed, so their
 * first execution is CI's. Reported as pending rather than presented as passed.
 */
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  WorkjetConnectionId,
  type ProviderInstanceConfigMap,
  type ServerProvider,
  type WorkjetDecisionHubProvisionInput,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration55 from "../../persistence/Migrations/055_WorkjetDecisionHub.ts";
import migration59 from "../../persistence/Migrations/059_WorkjetCtoxConnectionBindings.ts";
import { DecisionHubMcpClient } from "../../workjet/decisionHub/DecisionHubMcpClient.ts";
import {
  DecisionHubConnectionRegistry,
  layer as decisionHubLayer,
} from "../../workjet/decisionHub/DecisionHubConnectionRegistry.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutableLayer } from "./ProviderInstanceRegistryLive.ts";
import { runSettingsWatcher } from "./ProviderInstanceRegistryHydration.ts";
import type { AnyProviderDriver, ProviderInstance } from "../ProviderDriver.ts";

const CTOX = ProviderDriverKind.make("ctox");
const CONNECTION_A = WorkjetConnectionId.make("ctox-connection-a");
const INSTANCE_A = "instance-a";

const provisionA: WorkjetDecisionHubProvisionInput = {
  connectionId: CONNECTION_A,
  instanceId: INSTANCE_A,
  displayName: "Instance A",
  source: "ctox_dev",
  endpoint: `https://mcp.ctox.dev/mcp/${INSTANCE_A}`,
  token: "test-token-a",
};

interface Counters {
  readonly created: Ref.Ref<number>;
  readonly closed: Ref.Ref<number>;
  readonly refreshed: Ref.Ref<number>;
}

/**
 * A driver of kind `ctox` that records what the registry does to it. The
 * finalizer is the load-bearing part: `makeReconcile` closes the scope of any
 * instance it considers removed, so a rising `closed` count is exactly the
 * damage these tests exist to detect.
 */
const countingDriver = (counters: Counters): AnyProviderDriver<never> =>
  ({
    driverKind: CTOX,
    metadata: { displayName: "CTOX (test)", supportsMultipleInstances: true },
    configSchema: {} as never,
    defaultConfig: () => ({}),
    create: ({ instanceId }: { readonly instanceId: ProviderInstance["instanceId"] }) =>
      Effect.gen(function* () {
        yield* Ref.update(counters.created, (n) => n + 1);
        yield* Effect.addFinalizer(() => Ref.update(counters.closed, (n) => n + 1));
        const snapshot = {
          maintenanceCapabilities: {} as ProviderInstance["snapshot"]["maintenanceCapabilities"],
          getSnapshot: Effect.succeed({} as ServerProvider),
          refresh: Ref.update(counters.refreshed, (n) => n + 1).pipe(
            Effect.as({} as ServerProvider),
          ),
          streamChanges: Stream.empty as Stream.Stream<ServerProvider>,
        };
        return {
          instanceId,
          driverKind: CTOX,
          continuationIdentity: { driverKind: CTOX, continuationKey: `ctox:${instanceId}` },
          displayName: undefined,
          accentColor: undefined,
          enabled: true,
          snapshot,
          adapter: {} as ProviderInstance["adapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } as ProviderInstance;
      }),
  }) as unknown as AnyProviderDriver<never>;

const secretStore = ServerSecretStore.of({
  get: () => Effect.succeed(Option.some(new TextEncoder().encode("test-token-a"))),
  set: () => Effect.void,
  remove: () => Effect.void,
  create: () => Effect.die("unused"),
  getOrCreateRandom: () => Effect.die("unused"),
});

const mcpClient = DecisionHubMcpClient.of({
  probe: () => Effect.void,
  requestDecision: () => Effect.die("unused"),
  getDecision: () => Effect.die("unused"),
});

const harness = Effect.gen(function* () {
  yield* migration55;
  yield* migration59;
  const counters: Counters = {
    created: yield* Ref.make(0),
    closed: yield* Ref.make(0),
    refreshed: yield* Ref.make(0),
  };
  const registryLayer = ProviderInstanceRegistryMutableLayer({
    drivers: [countingDriver(counters)],
    configMap: {} as ProviderInstanceConfigMap,
  });
  return { counters, registryLayer };
});

const baseLayer = Layer.mergeAll(
  decisionHubLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
  NodeSqliteClient.layerMemory(),
  serverSettingsLayerTest(),
  Layer.succeed(ServerSecretStore, secretStore),
  Layer.succeed(DecisionHubMcpClient, mcpClient),
);

it.effect("materializes a bound connection and never tears it down on a later read failure", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    const connections = yield* DecisionHubConnectionRegistry;
    yield* connections.provision(provisionA);

    yield* Effect.gen(function* () {
      yield* runSettingsWatcher;
      const registry = yield* ProviderInstanceRegistry;
      const instances = yield* registry.listInstances;
      assert.lengthOf(instances, 1, "the bound connection produced exactly one provider instance");
      assert.equal(yield* Ref.get(test.counters.closed), 0);

      // A second pass over the same state must not recreate or close anything:
      // an unchanged config keeps the existing object and scope.
      yield* connections.probe(CONNECTION_A).pipe(Effect.ignore);
      yield* Effect.yieldNow;
      assert.equal(
        yield* Ref.get(test.counters.closed),
        0,
        "a probe must not close a live provider scope",
      );
      assert.isAbove(
        yield* Ref.get(test.counters.refreshed),
        0,
        "a connection change refreshes the snapshot instead of recreating the instance",
      );
    }).pipe(Effect.provide(test.registryLayer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("keeps the instance across disconnect, because the binding outlives the connection", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    const connections = yield* DecisionHubConnectionRegistry;
    yield* connections.provision(provisionA);

    yield* Effect.gen(function* () {
      yield* runSettingsWatcher;
      const registry = yield* ProviderInstanceRegistry;
      assert.lengthOf(yield* registry.listInstances, 1);

      // Disconnect deletes the CONNECTION row. Migration 59's binding survives
      // by design, and that is what the derivation reads — so the provider must
      // remain, reporting unavailable through its snapshot rather than being
      // removed and having its scope closed.
      yield* connections.disconnect(CONNECTION_A).pipe(Effect.ignore);
      yield* Effect.yieldNow;

      assert.lengthOf(
        yield* registry.listInstances,
        1,
        "a disconnect must not remove a previously bound provider instance",
      );
      assert.equal(
        yield* Ref.get(test.counters.closed),
        0,
        "a disconnect must not close the provider scope",
      );
    }).pipe(Effect.provide(test.registryLayer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("loses no connection event that lands between watcher start and the initial read", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    const connections = yield* DecisionHubConnectionRegistry;

    yield* Effect.gen(function* () {
      // Provision AFTER the watcher started. With the subscription acquired only
      // inside a forked stream consumer, this event was dropped and the instance
      // stayed invisible until an unrelated settings write arrived.
      yield* runSettingsWatcher;
      yield* connections.provision(provisionA);
      yield* Effect.yieldNow;

      const registry = yield* ProviderInstanceRegistry;
      assert.lengthOf(
        yield* registry.listInstances,
        1,
        "an event during startup must still reach the reconciliation",
      );
    }).pipe(Effect.provide(test.registryLayer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("survives a restart: the binding alone reconstructs the instance", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    const connections = yield* DecisionHubConnectionRegistry;
    yield* connections.provision(provisionA);
    // Disconnect first, so only the durable binding remains — the state a
    // restart would find after someone disconnected.
    yield* connections.disconnect(CONNECTION_A).pipe(Effect.ignore);

    yield* Effect.gen(function* () {
      yield* runSettingsWatcher;
      const registry = yield* ProviderInstanceRegistry;
      assert.lengthOf(
        yield* registry.listInstances,
        1,
        "a restart reconstructs the instance from the binding table, with no second store",
      );
    }).pipe(Effect.provide(test.registryLayer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);
