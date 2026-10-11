import type { CtoxManagedDiscoveryResult, CtoxManagedInstance } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import { DesktopKeyRecoveryError, type DesktopKeyRecovery } from "../app/DesktopKeyRecovery.ts";

/** Managed credentials are issued by the control plane, never decoded from the accountless registry. */
export const recoverManagedAfterLogin = Effect.fn("ctox.keyRecovery.afterLogin")(function* (input: {
  readonly discovery: CtoxManagedDiscoveryResult;
  readonly recovery: DesktopKeyRecovery["Service"];
  readonly reconnect: (instance: CtoxManagedInstance) => Effect.Effect<unknown, unknown>;
}) {
  const state = yield* input.recovery.inspect;
  if (state?.pendingLogin !== true) return;
  if (input.discovery._tag !== "ready") return;
  yield* Effect.forEach(
    input.discovery.instances.filter(
      (instance) => instance.source === "ctox_dev" && instance.status === "available",
    ),
    input.reconnect,
    { concurrency: 2, discard: true },
  ).pipe(
    Effect.mapError(
      () => new DesktopKeyRecoveryError({ operation: "reconnect managed instances" }),
    ),
  );
  yield* input.recovery.completeLogin;
});
