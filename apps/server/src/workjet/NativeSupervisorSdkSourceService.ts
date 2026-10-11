// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Resolve private paths for the original service-owned Source child.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { type ProjectId } from "@workjet/contracts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { UsageService } from "../usage/UsageService.ts";
import { currentProjectTokenBudgetContext } from "../usage/projectTokenBudgetContext.ts";
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
  /** Enabled only by the protected producer after qualifying the native reader. */
  readonly includeConfirmedGoalRead?: boolean;
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
  const budgetQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
  const budgetUsage = yield* Effect.serviceOption(UsageService);
  const readTokenBudgetContext =
    Option.isSome(budgetQuery) && Option.isSome(budgetUsage)
      ? (projectId: ProjectId) =>
          Effect.runPromise(
            currentProjectTokenBudgetContext(projectId).pipe(
              Effect.provideService(ProjectionSnapshotQuery, budgetQuery.value),
              Effect.provideService(UsageService, budgetUsage.value),
              Effect.catchCause(() => Effect.succeed(null)),
            ),
          )
      : undefined;
  const observeAssistantUsage =
    Option.isSome(budgetQuery) &&
    Option.isSome(budgetUsage) &&
    budgetUsage.value.recordAssistantUsage
      ? async (
          projectId: ProjectId,
          message: import("@anthropic-ai/claude-agent-sdk").SDKAssistantMessage,
        ) => {
          const model = await Effect.runPromise(budgetQuery.value.getCommandReadModel());
          const supervisors = model.threads.filter(
            (thread) =>
              thread.workjetConfig.schemaVersion === 2 &&
              thread.workjetConfig.team?.role === "supervisor" &&
              (thread.projectId === projectId ||
                thread.workjetConfig.ctoxProject?.nativeProjectId === projectId),
          );
          if (supervisors.length !== 1 || !message.message.usage) return;
          const record = budgetUsage.value.recordAssistantUsage!;
          await Effect.runPromise(
            record({
              threadId: supervisors[0]!.id,
              sessionId: message.session_id,
              messageId: message.message.id,
              model: message.message.model,
              createdAt: new Date().toISOString(),
              usage: {
                input_tokens: message.message.usage.input_tokens,
                output_tokens: message.message.usage.output_tokens,
                ...(message.message.usage.cache_read_input_tokens == null
                  ? {}
                  : {
                      cache_read_input_tokens: message.message.usage.cache_read_input_tokens,
                    }),
                ...(message.message.usage.cache_creation_input_tokens == null
                  ? {}
                  : {
                      cache_creation_input_tokens:
                        message.message.usage.cache_creation_input_tokens,
                    }),
              },
            }),
          );
        }
      : undefined;
  const runNext = Effect.fn("NativeSupervisorSdkSourceService.runNext")(function* () {
    if (retired) return yield* new NativeSupervisorSdkSourceServiceError({ reason: "retired" });
    if (active) return yield* new NativeSupervisorSdkSourceServiceError({ reason: "turn-active" });
    const running = runNextNativeSupervisorSdkTurn({
      source,
      ...(readTokenBudgetContext ? { readTokenBudgetContext } : {}),
      ...(observeAssistantUsage ? { observeAssistantUsage } : {}),
      sdkExecutable: options.sdkExecutable,
      privateStateDirectory: NodePath.join(options.privateServiceDirectory, "sdk"),
      serviceSignal: lifetime.signal,
      ...(options.includeConfirmedGoalRead === true ? { includeConfirmedGoalRead: true } : {}),
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
