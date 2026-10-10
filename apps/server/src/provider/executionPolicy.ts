import type { ProviderDriverKind, WorkjetThreadConfig } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderValidationError } from "./Errors.ts";

const hasPersistedPolicy = Schema.is(
  Schema.Struct({
    workjetConfig: Schema.Struct({ executionPolicy: Schema.Unknown }),
  }),
);

const unsupportedPolicy = (operation: string, provider: ProviderDriverKind) =>
  new ProviderValidationError({
    operation,
    issue: `Autonomous worktree execution is unsupported by '${provider}': no enforced team-worktree/host and secret-isolation admission is available. Full access is not an alternative. Keep the existing project policy or select a harness after its containment support is delivered.`,
  });

/**
 * No shipped adapter yet proves current team/worktree/host admission,
 * contained command descendants, file tools, secret isolation and escalation.
 * Keep launch closed until a concrete consumer enforces the complete boundary.
 */
export const requireEnforcedExecutionPolicy = Effect.fn("requireEnforcedExecutionPolicy")(
  function* (
    operation: string,
    provider: ProviderDriverKind,
    config: WorkjetThreadConfig | undefined,
  ) {
    if (config?.schemaVersion !== 2 || config.executionPolicy === undefined) return;
    return yield* unsupportedPolicy(operation, provider);
  },
);

/** A damaged/future config must not lose its policy through legacy decoding. */
export const requirePersistedEnforcedExecutionPolicy = Effect.fn(
  "requirePersistedEnforcedExecutionPolicy",
)(function* (operation: string, provider: ProviderDriverKind, runtimePayload: unknown) {
  if (!hasPersistedPolicy(runtimePayload)) return;
  return yield* unsupportedPolicy(operation, provider);
});
