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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

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
 * The CTOX half of the config map, derived from the connections that exist RIGHT
 * NOW. Kept out of `deriveProviderInstanceConfigMap` on purpose: that helper is
 * pure over settings, and giving it a database read would make every caller —
 * including the initial boot path — depend on the connection registry.
 *
 * One provider instance per bound connection, never one per instance: two
 * connections to the same CTOX instance are two different credentials, and the
 * driver refuses a thread whose binding names the other one.
 *
 * An explicit `providerInstances` entry always wins, exactly as it does for the
 * legacy mirror, so a hand-configured CTOX row is never overwritten by a
 * derived one.
 */
export const mergeCtoxProviderInstances = (
  configMap: ProviderInstanceConfigMap,
  summaries: ReadonlyArray<WorkjetConnectionSummary>,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...configMap };
  for (const summary of summaries) {
    // A connection that never reached "ready" has no usable target; a row for it
    // would be the instance-less, never-connectable entry we refuse to create.
    if (summary.status !== "ready") continue;
    const instanceId = `ctox_${summary.connectionId}`;
    if (instanceId in merged) continue;
    merged[instanceId] = {
      driver: CTOX_DRIVER_KIND,
      config: { ctoxInstanceId: summary.instanceId, connectionId: summary.connectionId },
    };
  }
  return merged as ProviderInstanceConfigMap;
};

const SettingsWatcherLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const mutator = yield* ProviderInstanceRegistryMutator;
    const serverSettings = yield* ServerSettingsService;
    const connections = yield* Effect.serviceOption(DecisionHubConnectionRegistry);

    /**
     * Reconciliation is serialized. Two sources now feed it — settings and
     * connections — and each recomputes the WHOLE map from a fresh read. Run
     * concurrently, a slower read can finish last and reinstate the state it
     * observed before the other source's change, silently undoing it.
     */
    const gate = yield* Semaphore.make(1);
    const reconcileNow = (settings: ServerSettings) =>
      gate
        .withPermits(1)(
          Effect.gen(function* () {
            const configMap = deriveProviderInstanceConfigMap(settings);
            const withCtox = yield* Option.match(connections, {
              onNone: () => Effect.succeed(configMap),
              onSome: (registry) =>
                registry.list.pipe(
                  Effect.map((summaries) => mergeCtoxProviderInstances(configMap, summaries)),
                  // A registry that cannot be read must not erase the CTOX rows a
                  // previous successful read produced; leaving the map untouched
                  // keeps existing instances alive until the next event.
                  Effect.orElseSucceed(() => configMap),
                ),
            });
            return yield* mutator.reconcile(withCtox);
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
          ),
        );

    // SUBSCRIBE FIRST, then read the initial state. The other order drops every
    // change that lands in between — precisely the window in which a connection
    // provisioned during startup would go missing until the next unrelated
    // settings write.
    const connectionChanges = Option.match(connections, {
      onNone: () => Stream.empty as Stream.Stream<void>,
      onSome: (registry) => registry.changes,
    });
    yield* connectionChanges.pipe(
      Stream.runForEach(() =>
        serverSettings.getSettings.pipe(
          Effect.flatMap(reconcileNow),
          Effect.catchCause((cause) =>
            Effect.logError("ProviderInstanceRegistry connection reconcile failed", cause),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* serverSettings.streamChanges.pipe(Stream.runForEach(reconcileNow), Effect.forkScoped);
    // The initial pass now runs behind both subscriptions.
    yield* serverSettings.getSettings.pipe(Effect.flatMap(reconcileNow), Effect.ignore);
  }),
);

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
  BuiltInDriversEnv | ServerSettingsService
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
) as Layer.Layer<ProviderInstanceRegistry, never, BuiltInDriversEnv | ServerSettingsService>;
