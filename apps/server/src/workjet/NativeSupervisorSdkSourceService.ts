// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off -- Resolve private paths for the original service-owned Source child.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type NativeSupervisorManagedRuntime,
  type NativeSupervisorSourceEnrollment,
  type NativeSupervisorSourceSelection,
} from "./NativeSupervisorSourceEnrollment.ts";
import { acquireNativeSupervisorSourceTransport } from "./NativeSupervisorSourceTransport.ts";
import { runNextNativeSupervisorSdkTurn } from "./NativeSupervisorSdkExecutor.ts";

export class NativeSupervisorSdkSourceServiceError extends Schema.TaggedErrorClass<NativeSupervisorSdkSourceServiceError>()(
  "NativeSupervisorSdkSourceServiceError",
  {
    reason: Schema.Literals(["retired", "turn-active", "sdk-failed"]),
  },
) {}

/** Private Source-service activation seam. The installed managed-runtime locator
 * must enroll the original Source first. No UI setting, renderer/RPC request,
 * executable label or startup snapshot can manufacture the retained plan.
 * The owning server scope outlives windows; closing it joins the actual SDK
 * holder before the original Source transport finalizer runs. */
export const openSelectedNativeSupervisorSdkSourceService = Effect.fn(
  "NativeSupervisorSdkSourceService.open",
)(function* (options: {
  readonly enrollment: NativeSupervisorSourceEnrollment["Service"];
  readonly selection: NativeSupervisorSourceSelection;
  /** Supplied only by the protected managed-runtime locator on first start. */
  readonly managedRuntime?: NativeSupervisorManagedRuntime;
  readonly privateServiceDirectory: string;
  readonly sdkExecutable: string;
}) {
  const plan = yield* options.managedRuntime === undefined
    ? options.enrollment.resolve(options.selection)
    : options.enrollment.prepare(options.selection, options.managedRuntime);
  const source = yield* acquireNativeSupervisorSourceTransport({
    executable: plan.runtime.ctoxExecutable,
    originalNativeRoot: plan.runtime.nativeRoot,
    ipcDirectory: NodePath.join(options.privateServiceDirectory, "source"),
    selected: {
      instanceId: plan.selection.nativeInstanceId,
      computerId: plan.selection.computerId,
    },
  });
  yield* options.enrollment.retainStarted(plan, source.startup);
  const lifetime = new AbortController();
  let retired = false;
  let active: Promise<Awaited<ReturnType<typeof runNextNativeSupervisorSdkTurn>>> | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      retired = true;
      lifetime.abort(new Error("Original Source service scope closed."));
      if (active) await active.catch(() => {});
    }),
  );
  const runNext = Effect.fn("NativeSupervisorSdkSourceService.runNext")(function* () {
    if (retired) return yield* new NativeSupervisorSdkSourceServiceError({ reason: "retired" });
    if (active) return yield* new NativeSupervisorSdkSourceServiceError({ reason: "turn-active" });
    const running = runNextNativeSupervisorSdkTurn({
      source,
      sdkExecutable: options.sdkExecutable,
      privateStateDirectory: NodePath.join(options.privateServiceDirectory, "sdk"),
      serviceSignal: lifetime.signal,
    });
    active = running;
    // Caller cancellation cannot clear custody of a still-running private query.
    void running.then(
      () => {
        if (active === running) active = undefined;
      },
      () => {
        retired = true;
        if (active === running) active = undefined;
      },
    );
    return yield* Effect.tryPromise({
      try: () => running,
      catch: () => new NativeSupervisorSdkSourceServiceError({ reason: "sdk-failed" }),
    });
  });
  return Object.freeze({ runNext });
});
