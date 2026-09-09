/**
 * THE TYPED PROJECTION THE NATIVE ADAPTER IS MISSING.
 *
 * `ProviderAdapterShape` hands its methods a `threadId` and nothing else. The
 * CTOX scope resolver needs two more facts that only the server holds: which
 * Workjet authority this is, and which CTOX connection the thread's own
 * capability binding names. This module is that lookup, and nothing else.
 *
 * WHY IT RE-DERIVES INSTEAD OF CACHING.
 *
 * `ProviderService.prepareMcpSession` already computes the same
 * `ThreadCapabilityContext` on the MCP path. Stashing its result for the
 * adapter to read later would make the two paths agree only by accident and
 * only until one of them was reordered. Re-deriving from the same persisted
 * config and the same live connection summaries makes them agree by
 * construction — that is the point of the shared resolver.
 *
 * Reachability is not re-implemented here either. `resolveThreadCapabilityContext`
 * only yields `ctoxBusinessOsBinding` when the bound connection is currently
 * KNOWN and REACHABLE, so a stored-but-disconnected instance produces no
 * binding, and the scope resolver refuses. Migration 59's durable identity pin
 * survives a disconnect by design and therefore cannot answer "is it up" — it
 * is checked separately, for a different question.
 */
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  WorkjetThreadConfig,
  type EnvironmentId,
  type ThreadId,
  type WorkjetConnectionId,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { DecisionHubConnectionRegistry } from "../decisionHub/DecisionHubConnectionRegistry.ts";
import * as ProviderSessionDirectory from "../../provider/Services/ProviderSessionDirectory.ts";
import { resolveThreadCapabilityContext } from "../ThreadCapabilityContext.ts";

// Same decode ProviderService uses for the same persisted payload.
const decodeWorkjetThreadConfig = Schema.decodeUnknownOption(WorkjetThreadConfig);

export interface CtoxThreadBindingFacts {
  readonly environmentId: EnvironmentId;
  /** Absent whenever the thread has no currently reachable, bound CTOX connection. */
  readonly binding:
    | { readonly connectionId: WorkjetConnectionId; readonly instanceId: string }
    | undefined;
}

export class CtoxThreadBindingSource extends Context.Service<
  CtoxThreadBindingSource,
  {
    readonly forThread: (threadId: ThreadId) => Effect.Effect<CtoxThreadBindingFacts>;
  }
>()("workjet/workjet/ctox/CtoxThreadBinding/CtoxThreadBindingSource") {}

/** Read the thread's persisted Workjet config out of its runtime binding. */
const persistedWorkjetConfig = (runtimePayload: unknown) => {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return DEFAULT_WORKJET_THREAD_CONFIG;
  }
  const raw = "workjetConfig" in runtimePayload ? runtimePayload.workjetConfig : undefined;
  return Option.getOrElse(decodeWorkjetThreadConfig(raw), () => DEFAULT_WORKJET_THREAD_CONFIG);
};

export const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment;
  const sessions = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const connections = yield* Effect.serviceOption(DecisionHubConnectionRegistry);

  const forThread = (threadId: ThreadId): Effect.Effect<CtoxThreadBindingFacts> =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const found = yield* sessions
        .getBinding(threadId)
        .pipe(
          Effect.orElseSucceed(() =>
            Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
          ),
        );
      if (Option.isNone(found)) return { environmentId, binding: undefined };

      const workjetConfig = persistedWorkjetConfig(found.value.runtimePayload);
      const summaries = yield* Option.match(connections, {
        onNone: () => Effect.succeed([]),
        onSome: (registry) => registry.list.pipe(Effect.orElseSucceed(() => [])),
      });
      const context = resolveThreadCapabilityContext(workjetConfig, undefined, {
        knownConnectionIds: new Set(summaries.map(({ connectionId }) => connectionId)),
        // "Ready" is the only state that may authorize a native start. A
        // configured-but-unreachable instance must stay visible as unavailable
        // rather than silently start work.
        reachableConnectionIds: new Set(
          summaries
            .filter(({ status }) => status === "ready")
            .map(({ connectionId }) => connectionId),
        ),
        connectionInstances: new Map(
          summaries.map(({ connectionId, instanceId }) => [connectionId, instanceId]),
        ),
      });

      return {
        environmentId,
        ...(context.ctoxBusinessOsBinding
          ? { binding: context.ctoxBusinessOsBinding }
          : { binding: undefined }),
      };
    });

  return { forThread } as const;
});

export const CtoxThreadBindingSourceLive = Layer.effect(CtoxThreadBindingSource, make);
