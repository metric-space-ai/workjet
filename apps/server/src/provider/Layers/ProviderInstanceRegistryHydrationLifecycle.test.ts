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
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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

/**
 * One token per completed reconciliation ATTEMPT, aborted runs included. The
 * read-failure case produces no registry change and no refresh, so there is no
 * other signal to wait on — and `yieldNow` would only prove that the scheduler
 * ran, not that the reconciliation finished.
 */
const makeBarrier = Effect.gen(function* () {
  const settled = yield* Queue.unbounded<void>();
  return {
    onSettled: Queue.offer(settled, undefined).pipe(Effect.asVoid),
    /** Wait for the next reconciliation to finish, whatever its outcome. */
    awaitSettled: Queue.take(settled).pipe(Effect.asVoid),
    drain: Queue.takeAll(settled).pipe(Effect.asVoid),
  };
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

it.effect("keeps a materialized instance alive through a real binding-read failure", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    const barrier = yield* makeBarrier;
    const connections = yield* DecisionHubConnectionRegistry;
    const sql = yield* SqlClient.SqlClient;
    yield* connections.provision(provisionA);

    yield* Effect.gen(function* () {
      yield* runSettingsWatcher({ onSettled: barrier.onSettled });
      const registry = yield* ProviderInstanceRegistry;
      const before = (yield* registry.listInstances)[0];
      assert.isDefined(before, "the bound connection materialized before the failure");
      const createdBefore = yield* Ref.get(test.counters.created);
      yield* barrier.drain;

      // A REAL read failure, not a stand-in: the table `readCtoxBindings` reads
      // is gone, so the query fails inside the production path. A successful
      // probe against a fake peer would have proved nothing here.
      yield* sql`DROP TABLE workjet_ctox_connection_bindings`;
      yield* connections.probe(CONNECTION_A);
      yield* barrier.awaitSettled;

      const after = (yield* registry.listInstances)[0];
      assert.strictEqual(after, before, "the very same instance object survived the failed read");
      assert.equal(
        yield* Ref.get(test.counters.closed),
        0,
        "a failed read must never close a live provider scope",
      );
      assert.equal(
        yield* Ref.get(test.counters.created),
        createdBefore,
        "and must not recreate the instance either",
      );

      // Recovery: once the read works again, reconciliation resumes normally.
      yield* sql`
        CREATE TABLE workjet_ctox_connection_bindings (
          connection_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO workjet_ctox_connection_bindings (connection_id, instance_id, created_at_ms)
        VALUES (${CONNECTION_A}, ${INSTANCE_A}, 0)
      `;
      yield* connections.probe(CONNECTION_A);
      yield* barrier.awaitSettled;
      assert.lengthOf(yield* registry.listInstances, 1, "reconciliation recovered after the fault");
      assert.equal(yield* Ref.get(test.counters.closed), 0);
    }).pipe(Effect.provide(test.registryLayer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("refreshes the existing snapshot on a connection event instead of rebuilding it", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    const barrier = yield* makeBarrier;
    const connections = yield* DecisionHubConnectionRegistry;
    yield* connections.provision(provisionA);

    yield* Effect.gen(function* () {
      yield* runSettingsWatcher({ onSettled: barrier.onSettled });
      const registry = yield* ProviderInstanceRegistry;
      const before = (yield* registry.listInstances)[0];
      yield* barrier.drain;
      // Captured AFTER initialization: initial hydration already refreshes, so a
      // bare `refreshed > 0` would have been satisfied before the event under
      // test even happened.
      const refreshedBefore = yield* Ref.get(test.counters.refreshed);

      yield* connections.probe(CONNECTION_A);
      yield* barrier.awaitSettled;

      assert.isAbove(
        yield* Ref.get(test.counters.refreshed),
        refreshedBefore,
        "the connection event refreshed the snapshot",
      );
      assert.strictEqual(
        (yield* registry.listInstances)[0],
        before,
        "through the same instance object — not by recreating it and closing its sessions",
      );
      assert.equal(yield* Ref.get(test.counters.closed), 0);
    }).pipe(Effect.provide(test.registryLayer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("keeps the instance across disconnect, because the binding outlives the connection", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    const barrier = yield* makeBarrier;
    const connections = yield* DecisionHubConnectionRegistry;
    yield* connections.provision(provisionA);

    yield* Effect.gen(function* () {
      yield* runSettingsWatcher({ onSettled: barrier.onSettled });
      const registry = yield* ProviderInstanceRegistry;
      const before = (yield* registry.listInstances)[0];
      assert.isDefined(before);
      yield* barrier.drain;

      // Disconnect deletes the CONNECTION row. Migration 59's binding survives by
      // design and is what the derivation reads, so the provider must remain and
      // report unavailable through its snapshot rather than be removed.
      assert.isTrue(yield* connections.disconnect(CONNECTION_A), "the disconnect really happened");
      yield* barrier.awaitSettled;

      assert.strictEqual(
        (yield* registry.listInstances)[0],
        before,
        "a disconnect must not remove or replace a previously bound provider instance",
      );
      assert.equal(yield* Ref.get(test.counters.closed), 0);
    }).pipe(Effect.provide(test.registryLayer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("loses no connection event published while the initial read is still running", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    const barrier = yield* makeBarrier;
    const connections = yield* DecisionHubConnectionRegistry;

    yield* Effect.gen(function* () {
      // `runSettingsWatcher` only returns AFTER its initial reconciliation, so
      // provisioning after it would sit outside the window entirely — the
      // previous version of this test could not fail for the reason it claimed.
      // Forking it and publishing while the first pass is still in flight is the
      // actual race: with the subscription acquired inside a forked consumer,
      // this event was dropped.
      yield* Effect.forkScoped(runSettingsWatcher({ onSettled: barrier.onSettled }));
      yield* connections.provision(provisionA);

      // Wait for reconciliations to settle until the event has been absorbed.
      // Both the initial pass and the event's own pass offer a token; the
      // instance must exist once they have.
      yield* barrier.awaitSettled;
      yield* barrier.awaitSettled;

      const registry = yield* ProviderInstanceRegistry;
      assert.lengthOf(
        yield* registry.listInstances,
        1,
        "an event published during startup must still reach the reconciliation",
      );
    }).pipe(Effect.provide(test.registryLayer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

it.effect("reconstructs the instance in a fresh registry after a restart", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    const connections = yield* DecisionHubConnectionRegistry;
    yield* connections.provision(provisionA);

    // First registry lifetime, closed deliberately at the end of its scope. That
    // close is expected and is counted separately from the forbidden closes the
    // other cases assert on.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const barrier = yield* makeBarrier;
        yield* runSettingsWatcher({ onSettled: barrier.onSettled });
        assert.lengthOf(yield* (yield* ProviderInstanceRegistry).listInstances, 1);
      }).pipe(Effect.provide(test.registryLayer)),
    );
    assert.isAbove(
      yield* Ref.get(test.counters.closed),
      0,
      "closing the registry scope really tore the first instance down",
    );

    // A SECOND registry, built from scratch against the same durable binding
    // table — the state a restarted server finds.
    const second = yield* harness;
    yield* Effect.gen(function* () {
      const barrier = yield* makeBarrier;
      yield* runSettingsWatcher({ onSettled: barrier.onSettled });
      assert.lengthOf(
        yield* (yield* ProviderInstanceRegistry).listInstances,
        1,
        "the binding table alone reconstructs the instance, with no second store",
      );
      assert.equal(
        yield* Ref.get(second.counters.closed),
        0,
        "and the reconstructed instance is not immediately torn down again",
      );
    }).pipe(Effect.provide(second.registryLayer));
  }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);
