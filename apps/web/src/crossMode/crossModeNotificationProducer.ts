// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Raises the cross-mode moments the CODE side can observe.
 *
 * ── Why this exists, and why it is not a subscription ───────────────────────
 * The notification model and its store were built and tested, and then nothing
 * ever called `publish`, so the panel would have rendered permanently empty.
 * The obvious fix — subscribe to a server stream — is not available: the
 * cross-mode RPCs are all request/response (`openInCode`, `getThreadLink`,
 * `listLinks`, `submit`), and there is no cross-mode subscription anywhere in
 * `rpc.ts`. The model's own doc says both modes "raise the same three
 * moments", so the moments are raised where they HAPPEN, which on this side is
 * the RPC call sites.
 *
 * ── Two of three moments, deliberately ──────────────────────────────────────
 * `link-created` and `result-submitted` both have an unambiguous Code-side
 * trigger: the call that mints the link, and the call that reports work back.
 * `approval-pending` does NOT — an approval starts waiting inside the OWNING
 * mode, which for a Business OS approval is not this process at all, and
 * there is no local event that fires when it does. Guessing a trigger would
 * produce a notification that appears at the wrong time or never clears, which
 * is worse than the surface honestly showing no approvals. That third moment
 * needs either a push channel or a Business OS-side producer, and it stays
 * unimplemented on purpose.
 *
 * Everything here is address-only. It builds events out of ids, closed codes
 * and a target — never a summary, an artifact, or a counterpart's text —
 * because `crossModeNotification.ts` would drop those fields anyway and a
 * producer that tried to pass them would be quietly lying about what travels.
 */
import { crossModeNotificationStore } from "./crossModeNotificationStore";
import type { CrossModeTarget } from "./crossModeTarget";

/**
 * Monotonic within a session, which is all `sequence` is for: ordering the
 * list. It is deliberately NOT derived from a clock — two events in the same
 * millisecond must still order, and a clock that steps backwards must not
 * reshuffle what the user already saw.
 */
let nextSequence = 0;
const takeSequence = (): number => {
  const value = nextSequence;
  nextSequence += 1;
  return value;
};

/** Reset between tests; never called in the app. */
export const resetCrossModeSequenceForTests = (): void => {
  nextSequence = 0;
};

export interface CrossModeMomentInput {
  readonly linkId: string;
  readonly target: CrossModeTarget;
  readonly occurredAt: string;
}

/** A cross-mode link was minted and now points at `target`. */
export const publishCrossModeLinkCreated = (input: CrossModeMomentInput): void => {
  crossModeNotificationStore.publish({
    _tag: "link-created",
    schemaVersion: 1,
    sequence: takeSequence(),
    occurredAt: input.occurredAt,
    target: input.target,
    linkId: input.linkId,
  });
};

/**
 * Linked work reported back. `outcome` is a closed code, not prose: the
 * summary the user typed stays in the owning authority and is read there once
 * the navigation lands, which is exactly why a notification carries a TARGET
 * rather than a description.
 */
export const publishCrossModeResultSubmitted = (
  input: CrossModeMomentInput & { readonly outcome: "submitted" | "accepted" | "rejected" },
): void => {
  crossModeNotificationStore.publish({
    _tag: "result-submitted",
    schemaVersion: 1,
    sequence: takeSequence(),
    occurredAt: input.occurredAt,
    target: input.target,
    linkId: input.linkId,
    outcome: input.outcome,
  });
};
