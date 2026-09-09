/**
 * THE NATIVE CTOX HARNESS AS A REAL PROVIDER DRIVER.
 *
 * Every other driver in this directory owns a process: it finds a binary,
 * spawns it, watches it, and updates it. This one owns nothing. CTOX is
 * already running as the selected instance's own service, and the entire point
 * of the Dev/Ops unification is that Workjet talks to THAT service rather than
 * starting a second one. So there is no executable path, no version probe, no
 * maintenance capability and no gateway route here — and their absence is the
 * feature, not an omission to be filled in later.
 *
 * WHAT ONE INSTANCE OF THIS DRIVER MEANS.
 *
 * Exactly one CTOX instance, reached over exactly one connection, both named in
 * the config. That pinning is what makes "a running thread is never re-bound by
 * a global instance switch" enforceable: switching the header's selection can
 * only change which provider instance a NEW thread picks, never where an open
 * session sends its turns.
 *
 * WHY THERE IS NO DEFAULT INSTANCE.
 *
 * `deriveProviderInstanceConfigMap` only materializes a built-in driver's
 * default when `settings.providers[driverKind]` exists, and no such legacy
 * mirror is added for CTOX. Registering here therefore creates no provider row
 * on its own: a CTOX row exists only where a real binding was configured. An
 * instance-less "CTOX" entry advertising itself as ready would be a lie about a
 * service nobody is connected to.
 */
import {
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
  type WorkjetConnectionId,
} from "@workjet/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderAdapterRequestError, ProviderDriverError } from "../Errors.ts";
import { makeCtoxAdapter, CTOX_NATIVE_MODEL, type CtoxTaskScope } from "../Layers/CtoxAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { DecisionHubConnectionRegistry } from "../../workjet/decisionHub/DecisionHubConnectionRegistry.ts";
import { makeCtoxMcpTransport } from "../../workjet/ctox/CtoxMcpTransport.ts";
import { CtoxNativeRequests } from "../../workjet/ctox/CtoxNativeRequests.ts";
import { makeCtoxNativeTaskClient } from "../../workjet/ctox/CtoxNativeTaskClient.ts";
import { CtoxThreadBindingSource } from "../../workjet/ctox/CtoxThreadBinding.ts";
import { resolveCtoxThreadScope } from "../../workjet/ctox/CtoxThreadScope.ts";
import { WorkjetCrossModeLinkStore } from "../../workjet/crossmode/WorkjetCrossModeLinkStore.ts";

export const CTOX_DRIVER_KIND = ProviderDriverKind.make("ctox");

/**
 * The whole configuration of a CTOX provider instance: which native instance,
 * over which connection. There is deliberately no endpoint, token, model or
 * binary field — an endpoint or credential here would be a second, competing
 * source of truth next to the connection registry, and a model field would be
 * an independent model route the instance does not have.
 */
export const CtoxProviderConfig = Schema.Struct({
  ctoxInstanceId: Schema.String,
  connectionId: Schema.String,
});
export type CtoxProviderConfig = typeof CtoxProviderConfig.Type;

/**
 * Only the HTTP client is required to CONSTRUCT an instance. Everything the
 * native path needs — the connection registry, the request ledger, the thread
 * binding projection and the link store — is resolved optionally, and a missing
 * one makes the instance report itself unavailable.
 *
 * That is not defensiveness. `BuiltInDriversEnv` is the union of every driver's
 * requirement, so a hard dependency here would force the session-directory
 * chain into every site that builds the registry, tests included, to support a
 * driver those sites never exercise.
 */
export type CtoxDriverEnv = HttpClient.HttpClient;

const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: CTOX_DRIVER_KIND,
  packageName: null,
});

/**
 * CTOX runs no model of its own for Workjet's account: commit messages, branch
 * names and PR text come from a model route this driver does not own. Reporting
 * the missing capability keeps the caller honest; returning invented text would
 * be a silent second model route, which rule 5 of the brief forbids outright.
 */
const unsupportedTextGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "CTOX uses the model configuration of its own instance and exposes no text-generation route to Workjet.",
    }),
  );

/**
 * Why this is exported: the rule "a thread may only run on the exact instance
 * AND connection this provider instance is pinned to" is the one that keeps a
 * global selection switch from retargeting live work. It is worth asserting
 * directly rather than only through a fully assembled driver.
 */
export const nativeBindingMismatchDetail = (
  scope: { readonly ctoxInstanceId: string; readonly connectionId: string },
  pinned: { readonly ctoxInstanceId: string; readonly connectionId: string },
): string | null => {
  if (scope.ctoxInstanceId !== pinned.ctoxInstanceId) {
    return `This thread belongs to CTOX instance ${scope.ctoxInstanceId}, not ${pinned.ctoxInstanceId}.`;
  }
  if (scope.connectionId !== pinned.connectionId) {
    return `This thread is bound to connection ${scope.connectionId}; this provider instance sends over ${pinned.connectionId}.`;
  }
  return null;
};

export const CtoxDriver: ProviderDriver<CtoxProviderConfig, CtoxDriverEnv> = {
  driverKind: CTOX_DRIVER_KIND,
  metadata: {
    displayName: "CTOX",
    // One instance per bound CTOX service, which is the normal case for anyone
    // running more than one tenant.
    supportsMultipleInstances: true,
  },
  configSchema: CtoxProviderConfig,
  // Deliberately unbound. A default that named some instance would invent a
  // binding; the registry surfaces such an entry as unavailable instead.
  defaultConfig: (): CtoxProviderConfig => ({ ctoxInstanceId: "", connectionId: "" }),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const transport = makeCtoxMcpTransport(yield* HttpClient.HttpClient);
      const connectionsOption = yield* Effect.serviceOption(DecisionHubConnectionRegistry);
      const requestsOption = yield* Effect.serviceOption(CtoxNativeRequests);
      const bindingsOption = yield* Effect.serviceOption(CtoxThreadBindingSource);
      const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
      const linkStoreOption = yield* Effect.serviceOption(WorkjetCrossModeLinkStore);

      const ctoxInstanceId = config.ctoxInstanceId.trim();
      const connectionId = config.connectionId.trim() as WorkjetConnectionId;
      if (!ctoxInstanceId || !connectionId) {
        return yield* new ProviderDriverError({
          driver: CTOX_DRIVER_KIND,
          instanceId,
          detail:
            "A CTOX provider instance must name the CTOX instance and the connection it is bound to.",
        });
      }
      if (
        Option.isNone(connectionsOption) ||
        Option.isNone(requestsOption) ||
        Option.isNone(bindingsOption) ||
        Option.isNone(sqlOption) ||
        Option.isNone(linkStoreOption)
      ) {
        return yield* new ProviderDriverError({
          driver: CTOX_DRIVER_KIND,
          instanceId,
          detail:
            "This build has no CTOX connection registry, request ledger or thread binding source.",
        });
      }
      const connections = connectionsOption.value;
      const requests = requestsOption.value;
      const bindings = bindingsOption.value;

      const client = makeCtoxNativeTaskClient({ connections, requests, transport });
      // The adapter invokes `resolveTaskScope` from its own fiber, which
      // carries no driver context. Capturing here keeps the resolver's services
      // with the closure instead of leaking them into the adapter's R channel.
      const scopeServices = Context.empty().pipe(
        Context.add(SqlClient.SqlClient, sqlOption.value),
        Context.add(WorkjetCrossModeLinkStore, linkStoreOption.value),
      );

      /**
       * The production dispatch path and the selection path resolve scope
       * through the SAME function, so a thread that the composer offers CTOX
       * for is exactly a thread that can start.
       */
      const resolveTaskScope = (
        threadId: Parameters<Parameters<typeof makeCtoxAdapter>[0]["resolveTaskScope"]>[0],
      ): Effect.Effect<CtoxTaskScope, ProviderAdapterRequestError> =>
        Effect.gen(function* () {
          const facts = yield* bindings.forThread(threadId);
          const scope = yield* resolveCtoxThreadScope({
            threadId,
            environmentId: facts.environmentId,
            binding: facts.binding,
            nowMillis: yield* Clock.currentTimeMillis,
          });
          // BOTH ids have to match, not just the instance. The adapter submits
          // over the connection this provider instance was built with, so
          // checking only the instance would let a thread bound to connection A
          // be acted on through connection B — and two connections to the same
          // CTOX instance can carry different agent tokens and scopes. Checking
          // the instance alone also misses nothing else: it is the connection
          // that carries the credential.
          if (scope.ctoxInstanceId !== ctoxInstanceId || scope.connectionId !== connectionId) {
            return yield* new ProviderAdapterRequestError({
              provider: CTOX_DRIVER_KIND,
              method: "resolveTaskScope",
              detail:
                nativeBindingMismatchDetail(scope, { ctoxInstanceId, connectionId }) ??
                "This thread is not bound to this provider instance.",
            });
          }
          return scope.task;
        }).pipe(
          Effect.provide(scopeServices),
          Effect.catchTag(
            "CtoxThreadScopeError",
            (error) =>
              new ProviderAdapterRequestError({
                provider: CTOX_DRIVER_KIND,
                method: "resolveTaskScope",
                detail: error.message,
              }),
          ),
        );

      const adapter = yield* makeCtoxAdapter({
        instanceId,
        ctoxInstanceId,
        connectionId,
        client,
        resolveTaskScope,
      });

      const presentationName = displayName?.trim() || `CTOX · ${ctoxInstanceId}`;
      const buildSnapshot = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        // `resolveReadyTarget` proves the STORED connection status is ready and
        // that a usable target exists — it runs no network probe. Reporting that
        // as confirmed live reachability would be exactly the fake-ready row
        // this driver exists to avoid, so the message says what was actually
        // checked; the native submission carries its own transport probe.
        const bound = yield* connections.resolveReadyTarget(connectionId, ctoxInstanceId).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        const base = buildServerProvider({
          presentation: { displayName: presentationName },
          enabled,
          checkedAt,
          // The instance manages its own models; Workjet offers no catalog for
          // this provider rather than mirroring one it cannot route to.
          models: [],
          skills: [],
          probe: {
            installed: true,
            version: null,
            status: bound ? "ready" : "error",
            auth: { status: bound ? "authenticated" : "unknown" },
            message: bound
              ? `Managed by CTOX instance ${ctoxInstanceId}; its connection is recorded as ready.`
              : `The connection bound to CTOX instance ${ctoxInstanceId} is not recorded as ready.`,
          },
        });
        return {
          ...base,
          instanceId,
          driver: CTOX_DRIVER_KIND,
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          ...(bound ? {} : { availability: "unavailable" as const }),
        } satisfies ServerProvider;
      });

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: CTOX_DRIVER_KIND,
        instanceId,
      });

      // `Effect.succeed(initial)` froze the first reading forever: refresh
      // produced a fresh object nothing could observe, and streamChanges never
      // emitted. The Ref IS the current snapshot; the PubSub is how a consumer
      // learns it changed.
      const current = yield* Ref.make(yield* buildSnapshot);
      const changes = yield* PubSub.unbounded<ServerProvider>();
      const snapshot = {
        maintenanceCapabilities: MAINTENANCE,
        getSnapshot: Ref.get(current),
        refresh: buildSnapshot.pipe(
          Effect.tap((next) => Ref.set(current, next)),
          Effect.tap((next) => PubSub.publish(changes, next)),
        ),
        streamChanges: Stream.fromPubSub(changes),
      };

      return {
        instanceId,
        driverKind: CTOX_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: {
          generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
          generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
          generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
          generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
        },
      } satisfies ProviderInstance;
    }),
};

export { CTOX_NATIVE_MODEL };
