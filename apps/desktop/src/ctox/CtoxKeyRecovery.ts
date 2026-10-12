import type { CtoxManagedDiscoveryResult, CtoxManagedInstance } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  DesktopKeyRecoveryError,
  DesktopKeyRecovery,
  type RepairFailure,
} from "../app/DesktopKeyRecovery.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { CtoxDevAuth } from "./CtoxDevAuth.ts";
import { CtoxElectronSessions } from "./CtoxElectronSessions.ts";
import { CtoxManagedLaunch } from "./CtoxManagedLaunch.ts";
import type {
  CtoxElectronSessionDescriptorError,
  CtoxElectronSessionOperationError,
} from "./CtoxElectronSessions.ts";
import { CtoxManagedLaunchError } from "./CtoxManagedLaunch.ts";
import { accessState } from "./CtoxInstancePreferences.ts";
const isLaunchError = Schema.is(CtoxManagedLaunchError);

/** Managed credentials are issued by the control plane, never decoded from the accountless registry. */
export const recoverManagedAfterLogin = Effect.fn("ctox.keyRecovery.afterLogin")(function* (input: {
  readonly discovery: CtoxManagedDiscoveryResult;
  readonly recovery: DesktopKeyRecovery["Service"];
  readonly successfulLoginId?: string;
  readonly reconnect: (
    instance: CtoxManagedInstance,
  ) => Effect.Effect<
    unknown,
    CtoxManagedLaunchError | CtoxElectronSessionDescriptorError | CtoxElectronSessionOperationError
  >;
}) {
  if (input.discovery._tag !== "ready" || input.discovery.sessionVerified !== true) return;
  if (
    input.successfulLoginId !== undefined &&
    input.recovery.restartManagedRepairAfterLogin !== undefined
  )
    yield* input.recovery.restartManagedRepairAfterLogin(input.successfulLoginId);
  if (input.recovery.prepareManagedRetry !== undefined) yield* input.recovery.prepareManagedRetry();
  const state = yield* input.recovery.inspect;
  if (state === undefined || state.managedRepairStarted) return;
  const instances: CtoxManagedInstance[] = [];
  for (const instance of input.discovery.instances) {
    if (
      instance.source === "ctox_dev" &&
      instance.id.startsWith("managed:") &&
      (state.repairTargets === undefined || state.repairTargets.includes(instance.id)) &&
      instance.status === "available" &&
      (yield* accessState(instance.id)) === "enabled"
    )
      instances.push(instance);
  }

  // The durable claim precedes all exchanges. Repeated refreshes and restarts cannot re-pair.
  if (
    input.recovery.beginManagedRepair !== undefined &&
    !(yield* input.recovery.beginManagedRepair(
      instances.map((instance) => instance.id),
      state.generation,
    ))
  )
    return;
  yield* Effect.forEach(
    instances,
    (instance, index) =>
      Effect.gen(function* () {
        // At most two starts per second and two exchanges in flight.
        if (index >= 2) yield* Effect.sleep(Duration.seconds(1));
        yield* Effect.logInfo("CTOX instance repair started", {
          generation: state.generation,
          instanceId: instance.id,
        });
        const result = yield* input
          .reconnect(instance)
          .pipe(Effect.timeout(Duration.seconds(30)), Effect.result);
        const launchError =
          Result.isFailure(result) && isLaunchError(result.failure) ? result.failure : undefined;
        const failure: RepairFailure | undefined = Result.isSuccess(result)
          ? undefined
          : {
              failureClass:
                launchError?.reason ?? (launchError === undefined ? "retryable" : "repair_failed"),
              operation: launchError?.operation ?? "launch-token",
              ...(launchError?.httpStatus === undefined
                ? {}
                : { httpStatus: launchError.httpStatus }),
            };
        const outcome = failure?.failureClass ?? "repaired";
        yield* Effect.annotateCurrentSpan({ outcome, ...(failure ?? {}) });
        if (input.recovery.recordInstanceRepair !== undefined)
          yield* input.recovery.recordInstanceRepair(
            instance.id,
            outcome,
            state.generation,
            failure,
          );
        yield* Effect.logInfo("CTOX instance repair finished", {
          generation: state.generation,
          instanceId: instance.id,
          outcome,
          ...(failure ?? {}),
        });
      }).pipe(
        Effect.withSpan("ctox.keyRecovery.instance", {
          attributes: { instanceId: instance.id, generation: state.generation },
        }),
      ),
    { concurrency: 2, discard: true },
  ).pipe(
    Effect.mapError(
      () => new DesktopKeyRecoveryError({ operation: "reconnect managed instances" }),
    ),
  );
  if ((yield* input.recovery.inspect)?.generation === state.generation)
    yield* input.recovery.completeLogin;
});

/** Scoped desktop owner: independent of renderer refreshes; the marker owns all admission. */
export class CtoxRepairScheduler extends Context.Service<CtoxRepairScheduler, object>()(
  "@workjet/desktop/ctox/CtoxKeyRecovery/CtoxRepairScheduler",
) {}
export const layer = Layer.effect(
  CtoxRepairScheduler,
  Effect.gen(function* () {
    const recovery = yield* DesktopKeyRecovery;
    const auth = yield* CtoxDevAuth;
    const sessions = yield* CtoxElectronSessions;
    const launches = yield* CtoxManagedLaunch;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.gen(function* () {
            const state = yield* recovery.inspect;
            const now = yield* Clock.currentTimeMillis;
            if (
              state !== undefined &&
              (!state.managedRepairStarted ||
                ((state.discoveryRetry ||
                  state.instanceRepairs?.some((entry) => entry.state === "retryable")) &&
                  now >= (state.nextAt ?? 0)))
            ) {
              if (recovery.prepareManagedRetry !== undefined) yield* recovery.prepareManagedRetry();
              const prepared = yield* recovery.inspect;
              const discovery = yield* auth.refresh.pipe(
                Effect.orElseSucceed(() => ({ _tag: "failed", code: "network_error" }) as const),
              );
              if (discovery._tag !== "ready" || discovery.sessionVerified !== true) {
                const deviceStatus = yield* (
                  auth.deviceStatus ?? Effect.succeed({ state: "not_configured" as const })
                ).pipe(Effect.orElseSucceed(() => ({ state: "active" as const })));
                if (prepared !== undefined && recovery.deferManagedDiscovery !== undefined)
                  yield* recovery.deferManagedDiscovery(
                    prepared.generation,
                    discovery._tag === "signed_out" && deviceStatus.state !== "active",
                  );
              }
              yield* recoverManagedAfterLogin({
                discovery,
                recovery,
                reconnect: (instance) =>
                  Effect.andThen(sessions.instance(instance), launches.launch(instance)),
              });
            }
          }).pipe(Effect.ignore);
          yield* Effect.sleep(Duration.seconds(30));
        }
      }),
    );
    return {};
  }),
);
