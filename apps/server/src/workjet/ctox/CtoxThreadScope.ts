/**
 * THE SERVER-SIDE CTOX SCOPE RESOLVER.
 *
 * Answers one question for the native CTOX harness: *which* Business OS module
 * — on *which* instance, over *which* connection — is this Dev thread allowed
 * to act on. It is the only place that answer is produced, so the selection
 * path and the production dispatch path cannot drift into disagreeing.
 *
 * WHAT THIS DELIBERATELY REFUSES TO DO.
 *
 * The tempting shortcuts are all wrong, and each one is a real failure mode
 * rather than a hypothetical:
 *
 *   - A module constant, or a module guessed from a thread title, would let any
 *     thread reach some app. `inventory` was exactly such a placeholder in the
 *     adapter draft.
 *   - `getByThread` alone is not authorization. A link says a thread and an
 *     object are related; it does not say the caller may act on it now, and it
 *     may be expired or belong to another Workjet authority.
 *   - Picking a connection by scanning the registry — first hit, newest, sorted
 *     — silently chooses between two live connections to the same instance. The
 *     thread's own capability binding is the only unique answer, so that is the
 *     only input accepted here. No binding is a refusal, never a search.
 *   - `workjet_ctox_connection_bindings` (migration 59) is an identity PIN that
 *     deliberately survives disconnect. It proves "this connection has always
 *     meant that instance", never "this connection is up". Reachability is the
 *     caller's job; this module only refuses a connection pinned to a different
 *     instance.
 *
 * Every rejection is a named reason, because "not executable" has to be
 * explainable to a user who is looking at a thread that will not start.
 */
import type { EnvironmentId, ThreadId, WorkjetConnectionId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { requireCtoxConnectionInstance } from "./CtoxConnectionBinding.ts";
import { WorkjetCrossModeLinkStore } from "../crossmode/WorkjetCrossModeLinkStore.ts";

export class CtoxThreadScopeError extends Schema.TaggedErrorClass<CtoxThreadScopeError>()(
  "CtoxThreadScopeError",
  {
    reason: Schema.Literals([
      /** The thread has no CTOX Business OS capability binding. */
      "no-thread-binding",
      /** The thread implements no Business OS object. */
      "no-business-os-link",
      /** The link carried an expiry and it has passed. */
      "link-expired",
      /** The stored link names another thread. */
      "link-thread-mismatch",
      /** The stored link belongs to another Workjet authority. */
      "link-environment-mismatch",
      /** The link's CTOX instance is not the instance this thread is bound to. */
      "instance-mismatch",
      /** The connection is pinned to a different instance, or unreadable. */
      "connection-unverified",
      /** The link store could not be read. */
      "link-store-unavailable",
    ]),
  },
) {
  override get message(): string {
    return `This thread has no executable CTOX scope: ${this.reason}.`;
  }
}

/**
 * One resolved scope. `record_id` is present whenever the link names a Business
 * OS object, which today is always: the contract's `objectKind` is an opaque
 * branded slug with no module-level value, so there is no case in which the
 * object id must be dropped. If a module-level kind is ever added, that is the
 * point where it has to be handled — not by guessing here.
 */
export interface CtoxThreadScope {
  readonly connectionId: WorkjetConnectionId;
  readonly ctoxInstanceId: string;
  readonly task: {
    readonly module_id: string;
    readonly record_id?: string;
  };
}

export interface CtoxThreadScopeInput {
  readonly threadId: ThreadId;
  /** This Workjet authority. A link created under another one is not ours. */
  readonly environmentId: EnvironmentId;
  /**
   * The thread's own CTOX capability binding, as
   * `ThreadCapabilityContext.ctoxBusinessOsBinding` produced it. Passed in
   * rather than looked up so this module never has to choose between
   * connections.
   */
  readonly binding:
    | { readonly connectionId: WorkjetConnectionId; readonly instanceId: string }
    | undefined;
  /** Epoch millis used for the expiry comparison, supplied by the caller. */
  readonly nowMillis: number;
}

export const resolveCtoxThreadScope = Effect.fn("ctox.resolveThreadScope")(function* (
  input: CtoxThreadScopeInput,
) {
  const refuse = (reason: CtoxThreadScopeError["reason"]) => new CtoxThreadScopeError({ reason });

  const binding = input.binding;
  if (!binding) return yield* refuse("no-thread-binding");

  const store = yield* WorkjetCrossModeLinkStore;
  const found = yield* store
    .getByThread(input.threadId)
    .pipe(Effect.mapError(() => refuse("link-store-unavailable")));
  if (Option.isNone(found)) return yield* refuse("no-business-os-link");
  const record = found.value;
  const { ctox, code } = record.link;

  // The store is keyed by thread, but a corrupt or migrated row could still
  // name another one; the identity is cheap to re-assert and expensive to
  // assume.
  if (code.threadId !== input.threadId) return yield* refuse("link-thread-mismatch");
  if (code.environmentId !== input.environmentId) {
    return yield* refuse("link-environment-mismatch");
  }
  // `null` means "no expiry", never "expired" — the store's own contract.
  if (record.expiresAtMillis !== null && record.expiresAtMillis <= input.nowMillis) {
    return yield* refuse("link-expired");
  }
  // The renderer's selected instance, the Workjet computer and the native CTOX
  // instance are three different identities. Only the last one may decide where
  // native work runs, and it has to be the one the thread is bound to.
  if (ctox.instanceId !== binding.instanceId) return yield* refuse("instance-mismatch");

  yield* requireCtoxConnectionInstance(binding.connectionId, binding.instanceId).pipe(
    Effect.mapError(() => refuse("connection-unverified")),
  );

  return {
    connectionId: binding.connectionId,
    ctoxInstanceId: binding.instanceId,
    task: { module_id: ctox.moduleId, record_id: ctox.objectId },
  } satisfies CtoxThreadScope;
});
