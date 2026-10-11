import type { CtoxManagedDiscoveryResult, CtoxManagedInstance } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Result from "effect/Result";
import { DesktopKeyRecoveryError, type DesktopKeyRecovery } from "../app/DesktopKeyRecovery.ts";
import type {
  CtoxElectronSessionDescriptorError,
  CtoxElectronSessionOperationError,
} from "./CtoxElectronSessions.ts";
import type { CtoxManagedLaunchError } from "./CtoxManagedLaunch.ts";
import { accessState } from "./CtoxInstancePreferences.ts";

/** Managed credentials are issued by the control plane, never decoded from the accountless registry. */
export const recoverManagedAfterLogin = Effect.fn("ctox.keyRecovery.afterLogin")(function* (input: {
  readonly discovery: CtoxManagedDiscoveryResult;
  readonly recovery: DesktopKeyRecovery["Service"];
  readonly reconnect: (
    instance: CtoxManagedInstance,
  ) => Effect.Effect<
    unknown,
    CtoxManagedLaunchError | CtoxElectronSessionDescriptorError | CtoxElectronSessionOperationError
  >;
}) {
  const state = yield* input.recovery.inspect;
  if (state?.pendingLogin !== true) return;
  if (input.discovery._tag !== "ready") return;
  const instances: CtoxManagedInstance[] = [];
  for (const instance of input.discovery.instances) {
    if (
      instance.source === "ctox_dev" &&
      instance.id.startsWith("managed:") &&
      instance.status === "available" &&
      (yield* accessState(instance.id)) === "enabled"
    )
      instances.push(instance);
  }
  // The durable claim precedes all exchanges. Repeated refreshes and restarts cannot re-pair.
  if (
    input.recovery.beginManagedRepair !== undefined &&
    !(yield* input.recovery.beginManagedRepair(instances.map((instance) => instance.id)))
  )
    return;
  yield* Effect.forEach(
    instances,
    (instance, index) =>
      Effect.gen(function* () {
        // At most two starts per second and two exchanges in flight; never retry this generation.
        if (index >= 2) yield* Effect.sleep(Duration.seconds(1));
        yield* Effect.logInfo("CTOX instance repair started", {
          generation: state.generation,
          instanceId: instance.id,
        });
        const result = yield* input
          .reconnect(instance)
          .pipe(Effect.timeout(Duration.seconds(30)), Effect.result);
        const outcome = Result.isSuccess(result) ? "repaired" : "repair_failed";
        if (input.recovery.recordInstanceRepair !== undefined)
          yield* input.recovery.recordInstanceRepair(instance.id, outcome);
        yield* Effect.logInfo("CTOX instance repair finished", {
          generation: state.generation,
          instanceId: instance.id,
          outcome,
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
  yield* input.recovery.completeLogin;
});
