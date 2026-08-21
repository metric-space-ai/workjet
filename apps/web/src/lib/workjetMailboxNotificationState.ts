// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Turns the Workjet mailbox audit stream into the bounded notifications a
 * human should see — the surface `server.ts:1109` was wired for and that "a
 * later slice renders".
 *
 * ── What was unread ─────────────────────────────────────────────────────────
 * The subscription atom existed and no component consumed it, so a
 * DEAD-LETTERED envelope — one that exhausted its delivery attempts and will
 * never arrive — surfaced nowhere at all. The sender saw a message that looked
 * sent; the recipient never got it; nothing told anyone. That is the failure
 * this closes, and it is the one the operator most needs to know about,
 * because it is silent by construction.
 *
 * ── Why the mapping lives in contracts, not here ────────────────────────────
 * `toWorkjetMailboxNotification` composes every string from bounded ids and
 * closed reason codes, and returns `null` for events outside the user-facing
 * subset. Re-deriving titles here would fork that redaction discipline into a
 * second place that could drift; this module only selects and orders.
 */
import {
  toWorkjetMailboxNotification,
  type WorkjetMailboxAuditEvent,
  type WorkjetMailboxNotification,
} from "@t3tools/contracts";

/**
 * Beyond this many the oldest are dropped. A stream is unbounded and a
 * notification list is a glance surface, not a log; the audit ledger remains
 * the record.
 */
export const WORKJET_MAILBOX_NOTIFICATION_LIMIT = 50;

/**
 * Newest first, capped, deduplicated by sequence.
 *
 * Ordering is by `sequence`, never `occurredAt`: the events are produced by
 * the server that owns the mailbox, two can share a millisecond, and a clock
 * that steps backwards must not reshuffle what the operator already read.
 *
 * Deduplication matters because a subscription re-delivers on reconnect. The
 * same dead-letter reported twice would read as two failed envelopes, which
 * would send someone looking for a second problem that does not exist.
 */
export function selectWorkjetMailboxNotifications(
  events: ReadonlyArray<WorkjetMailboxAuditEvent>,
): ReadonlyArray<WorkjetMailboxNotification> {
  const bySequence = new Map<number, WorkjetMailboxNotification>();
  for (const event of events) {
    const notification = toWorkjetMailboxNotification(event);
    if (notification === null) continue;
    bySequence.set(notification.sequence, notification);
  }
  return [...bySequence.values()]
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, WORKJET_MAILBOX_NOTIFICATION_LIMIT);
}

/**
 * The ones that describe something GOING WRONG, for a badge or a filter.
 *
 * `warning` is assigned by the contract from the event kind, never from a
 * payload, so this cannot be influenced by a peer.
 */
export function selectWorkjetMailboxWarnings(
  notifications: ReadonlyArray<WorkjetMailboxNotification>,
): ReadonlyArray<WorkjetMailboxNotification> {
  return notifications.filter((notification) => notification.level === "warning");
}
