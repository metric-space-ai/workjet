/**
 * ProviderInstanceRegistryHydration — derive a `ProviderInstanceConfigMap`
 * from `ServerSettings` and keep `ProviderInstanceRegistry` in sync with it.
 *
 * The server still reads two shapes:
 *
 *   1. `settings.providerInstances` — the new driver-agnostic map the
 *      registry expects. Keyed by `ProviderInstanceId`, values are
 *      `ProviderInstanceConfig` envelopes.
 *   2. `settings.providers.<kind>` — the legacy single-instance-per-driver
 *      fields (`providers.codex`, `providers.claudeAgent`, …). These are
 *      the source of truth for every deployment that hasn't been migrated
 *      yet to an explicit `providerInstances` entry.
 *
 * This module bridges (2) into (1) and wires the resulting map into a
 * mutable registry. For every built-in driver whose id is not already
 * present in `providerInstances` (keyed on
 * `defaultInstanceIdForDriver(driverKind)` — literally the driver kind as a
 * routing slug), we synthesize an envelope from the legacy field. The
 * registry decodes both flavours through the same `configSchema` and ends
 * up with one uniform `ProviderInstance` per entry.
 *
 * Explicit `providerInstances` entries always win — users can already
 * override the legacy `providers.<kind>` blob by authoring a
 * `providerInstances.codex` entry with a matching driver, and we don't
 * want the synthesized envelope to silently stomp their config.
 *
 * Hot-reload
 * ----------
 * On layer build we:
 *   1. Read the current `ServerSettings` once and use it to seed the
 *      registry's initial state via `ProviderInstanceRegistryMutableLayer`.
 *   2. Fork a daemon fiber (lifetime tied to the layer's scope) that
 *      subscribes to `ServerSettingsService.streamChanges` and calls
 *      `ProviderInstanceRegistryMutator.reconcile` on every emission.
 *
 * Failures inside the watcher are logged and swallowed so a single bad
 * settings emission cannot kill the registry. Unknown drivers and invalid
 * configs already round-trip through the registry's own "unavailable"
 * shadow bucket.
 *
 * @module provider/Layers/ProviderInstanceRegistryHydration
 */
import {
  defaultInstanceIdForDriver,
  type ProviderInstanceConfig,
  type WorkjetConnectionSummary,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "../builtInDrivers.ts";
import { CTOX_DRIVER_KIND } from "../Drivers/CtoxDriver.ts";
import { DecisionHubConnectionRegistry } from "../../workjet/decisionHub/DecisionHubConnectionRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { ProviderInstanceRegistryMutableLayer } from "./ProviderInstanceRegistryLive.ts";

/**
 * Synthesize a `ProviderInstanceConfigMap` from a `ServerSettings` snapshot.
 *
 * Strategy:
 *   1. Copy all explicit `settings.providerInstances` entries verbatim.
 *   2. For each built-in driver whose `defaultInstanceIdForDriver(id)` key
 *      is *not* already in the explicit map, synthesize an entry from the
 *      matching legacy `settings.providers.<kind>` blob.
 *
 * The returned map is the input the registry consumes; pure & exported
 * separately so the hydration logic can be exercised by unit tests
 * without layering.
 */
export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) {
      // Explicit `providerInstances` entry for this slot — user-authored
      // config always wins over the legacy mirror.
      continue;
    }

    // Only built-in drivers have a legacy mirror; the registry's
    // `providers` struct is keyed on the same literal slug as
    // `driverKind`. Access is dynamic (the driver kind is a branded string),
    // but it's constrained to `keyof settings.providers` by the union of
    // built-in driver kinds.
    const legacyKey = driver.driverKind as keyof ServerSettings["providers"];
    const legacyConfig = settings.providers[legacyKey];
    if (legacyConfig === undefined) {
      continue;
    }

    merged[instanceId] = {
      driver: driver.driverKind,
      config: legacyConfig,
    };
  }

  return merged as ProviderInstanceConfigMap;
};

/**
 * Layer that consumes `ProviderInstanceRegistryMutator` and forks a
 * settings-watcher fiber. The fiber's lifetime is tied to the enclosing
 * layer scope (process lifetime in production), so it is interrupted on
 * shutdown without leaking.
 *
 * Errors inside the watcher are logged and swallowed — the registry's own
 * "unavailable" bucket already absorbs unknown drivers and invalid
 * configs, so the only way the watcher could fail is a settings stream
 * tear-down, which logs and exits cleanly.
 */
/**
 * The CTOX half of the config map.
 *
 * The durable source is `workjet_ctox_connection_bindings` (migration 59), NOT
 * the live connection list. That table is first-writer-wins and deliberately
 * survives a disconnect, which is exactly the property this needs: an instance
 * that was once genuinely bound stays a known instance across probe failures,
 * disconnects and restarts, and reports itself unavailable instead of vanishing.
 *
 * Deriving from the live list instead — the previous version of this function —
 * removed the row whenever a connection was not `ready`. `makeReconcile` then
 * saw a missing key, classified it as removed and CLOSED its scope
 * (ProviderInstanceRegistryLive:230), so a failed probe tore down a live
 * provider instance and any session bound to it. Reconstructing from the
 * binding table also means no second registry store: the table already is the
 * authoritative record.
 *
 * One instance per bound CONNECTION, never per CTOX instance: two connections
 * to one instance are two credentials, and the driver refuses a thread bound to
 * the other one. An explicit `providerInstances` entry always wins.
 */
export const mergeCtoxProviderInstances = (
  configMap: ProviderInstanceConfigMap,
  bindings: ReadonlyArray<{ readonly connectionId: string; readonly instanceId: string }>,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...configMap };
  for (const binding of bindings) {
    const instanceId = `ctox_${binding.connectionId}`;
    if (instanceId in merged) continue;
    merged[instanceId] = {
      driver: CTOX_DRIVER_KIND,
      config: { ctoxInstanceId: binding.instanceId, connectionId: binding.connectionId },
    };
  }
  return merged as ProviderInstanceConfigMap;
};

/** The confirmed bindings, read from the durable table rather than a cache. */
const readCtoxBindings = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`
      SELECT connection_id AS "connectionId", instance_id AS "instanceId"
      FROM workjet_ctox_connection_bindings
    `,
  ),
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ connectionId: Schema.String, instanceId: Schema.String })),
    ),
  ),
);

/**
 * Exported so a test can drive the REAL watcher rather than a re-implementation
 * of it. `SettingsWatcherLive` below is nothing but this effect wrapped in a
 * layer, so production and test exercise the same code path — a separate
 * reconciliation simulator would only ever prove that the simulator works.
 */
export const runSettingsWatcher = (options: {
  /**
   * Ran after EVERY reconciliation attempt, successful or aborted. Production
   * passes nothing; a test uses it as a completion barrier, because the case
   * that matters most — a read failure aborting the run — produces no registry
   * change and therefore no other signal to wait on. Waiting on `yieldNow` or a
   * sleep instead would make the test pass for timing reasons rather than for
   * the behaviour under test.
   */
  readonly onSettled?: Effect.Effect<void>;
  /**
   * Runs after both subscriptions are acquired and BEFORE the initial read.
   * Production passes nothing. A test uses it to publish an event inside
   * exactly the window this ordering exists to protect — forking the watcher
   * and racing it is not a proof, it is a coin toss.
   */
  readonly onSubscribed?: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const mutator = yield* ProviderInstanceRegistryMutator;
    const registry = yield* ProviderInstanceRegistry;
    const serverSettings = yield* ServerSettingsService;
    const connections = yield* Effect.serviceOption(DecisionHubConnectionRegistry);

    /**
     * Reconciliation is an INVALIDATION, not the delivery of a payload.
     *
     * Passing an already-read settings snapshot in would let a run that waited
     * on the semaphore write back the state it observed before someone else's
     * change — the newest event would lose. So the permit comes first, and both
     * sources are read fresh behind it. The event only says "something moved".
     */
    const gate = yield* Semaphore.make(1);
    const reconcileNow = gate
      .withPermits(1)(
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const configMap = deriveProviderInstanceConfigMap(settings);
          if (Option.isNone(connections)) {
            // No connection registry in this build: no CTOX row can exist, so a
            // plain reconcile is the whole job.
            return yield* mutator.reconcile(configMap);
          }
          // A failed read must ABORT the run. Reconciling the settings-only map
          // would present every derived CTOX row as removed, and makeReconcile
          // closes the scopes of removed ids — a transient database error would
          // tear down live provider instances.
          // SqlClient is a real requirement of this layer, not an optional
          // extra: the binding table is where CTOX instances come from. Making
          // it optional to satisfy a compiler would have silently skipped the
          // whole derivation wherever it was absent — a behaviour difference
          // introduced to dodge an error rather than to fix one.
          const bindings = yield* readCtoxBindings;
          yield* mutator.reconcile(mergeCtoxProviderInstances(configMap, bindings));
          // Reconcile alone refreshes nothing. An instance whose config is
          // unchanged keeps its existing object and scope
          // (ProviderInstanceRegistryLive:261-265), and CtoxDriver updates its
          // snapshot only inside `snapshot.refresh` — so a connection going
          // offline would leave the provider showing its last status forever.
          // Refreshing through the instance's OWN snapshot service is what makes
          // a connection change visible, without recreating the provider object
          // and tearing down the sessions bound to it.
          const instances = yield* registry.listInstances;
          yield* Effect.forEach(
            instances.filter((instance) => instance.driverKind === CTOX_DRIVER_KIND),
            (instance) => instance.snapshot.refresh.pipe(Effect.ignore),
            { discard: true },
          );
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
        ),
        // Runs after EVERY attempt, aborted ones included. Production passes
        // nothing; a test uses it as its completion barrier.
        Effect.ensuring(options.onSettled ?? Effect.void),
      );

    /**
     * Acquire the subscriptions in THIS fiber before anything reads initial
     * state. `Stream.fromPubSub` only registers its subscriber once the
     * consumer runs, so forking a stream consumer first — the previous version
     * here — guarantees nothing: a connection provisioned in that window stayed
     * invisible until an unrelated settings write happened to arrive.
     */
    const connectionEvents = yield* Option.match(connections, {
      onNone: () => Effect.succeedNone,
      onSome: (registry) => registry.subscribeChanges.pipe(Effect.asSome),
    });
    const settingsEvents = yield* serverSettings.subscribeChanges;

    yield* Option.match(connectionEvents, {
      onNone: () => Effect.void,
      onSome: (events) =>
        events.pipe(
          Stream.runForEach(() => reconcileNow),
          Effect.forkScoped,
          Effect.asVoid,
        ),
    });
    yield* settingsEvents.pipe(
      Stream.runForEach(() => reconcileNow),
      Effect.forkScoped,
    );

    // Only now: the initial pass runs behind both live subscriptions.
    yield* reconcileNow;
  });

const SettingsWatcherLive = Layer.effectDiscard(runSettingsWatcher({}));

/**
 * Hydrate `ProviderInstanceRegistry` from `ServerSettings` and keep it in
 * sync with subsequent `streamChanges` emissions.
 *
 * The Layer's two halves:
 *   - `ProviderInstanceRegistryMutableLayer` produces the registry +
 *     mutator from the initial config map. Its scope owns every
 *     per-instance child scope created during reconcile.
 *   - `SettingsWatcherLive` consumes the mutator and runs a daemon fiber
 *     in the same scope.
 *
 * Composing via `Layer.provideMerge` makes the watcher's deps available
 * from the mutable layer while still surfacing the registry as an output.
 * The mutator tag is technically also exposed; only this module imports
 * it, so the visibility leak is harmless in practice.
 */
export const ProviderInstanceRegistryHydrationLive: Layer.Layer<
  ProviderInstanceRegistry,
  never,
  BuiltInDriversEnv | ServerSettingsService | SqlClient.SqlClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const initialConfigMap =
      initialSettings === undefined
        ? ({} as ProviderInstanceConfigMap)
        : deriveProviderInstanceConfigMap(initialSettings);

    const mutableLayer = ProviderInstanceRegistryMutableLayer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
    });

    return SettingsWatcherLive.pipe(Layer.provideMerge(mutableLayer));
  }),
) as Layer.Layer<
  ProviderInstanceRegistry,
  never,
  BuiltInDriversEnv | ServerSettingsService | SqlClient.SqlClient
>;
