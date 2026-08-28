// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Unified, redacted cross-mode notifications and pending-approval indicators
 * (docs/workjet-plan.md "Cross-mode workflow bridge", item 5).
 *
 * Both modes raise the same three moments — a link was created, an approval is
 * waiting, a result was submitted — and the user should see ONE list of them
 * regardless of which authority produced them. Clicking an entry routes
 * through `navigateToCrossModeTarget`, which is the only thing that knows how
 * to reach the owning mode safely.
 *
 * ── Redaction is the hard constraint ────────────────────────────────────────
 * This module follows the discipline `packages/contracts/src/
 * workjetMailboxAudit.ts` established for the Workjet mailbox: a notification
 * may carry ONLY
 *
 *   - bounded opaque ids (link id, approval id, and the target's addresses);
 *   - closed literal kinds, levels, and outcome CODES;
 *   - a non-negative sequence and a bounded timestamp;
 *   - title/detail strings BUILT from those ids and codes.
 *
 * It may NEVER carry Business OS record data, thread or message text, artifact
 * contents, provider payloads, or a counterpart's free text. The payload stays
 * in the owning authority and is read there once the navigation lands — which
 * is exactly why the notification carries a TARGET and not a summary.
 *
 * The enforcement is structural, not a review rule: every field below is a
 * bounded id, a closed literal, an integer, or a timestamp, so a would-be
 * payload has no field to travel in. An object carrying one decodes with the
 * excess key DROPPED. `crossModeNotification.test.ts` keeps a canary on that.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  crossModeModeLabel,
  CrossModeTarget,
  describeCrossModeTarget,
  normalizeCrossModeTarget,
  type CrossModeMode,
} from "./crossModeTarget";

export const CROSS_MODE_NOTIFICATION_SCHEMA_VERSION = 1;

const NotificationSchemaVersion = Schema.Literal(CROSS_MODE_NOTIFICATION_SCHEMA_VERSION);

/** The three notification-worthy cross-mode moments. */
export const CROSS_MODE_NOTIFICATION_KINDS = [
  "link-created",
  "approval-pending",
  "result-submitted",
] as const;
export type CrossModeNotificationKind = (typeof CROSS_MODE_NOTIFICATION_KINDS)[number];

/** Severity, derived from the event kind — never from a payload. */
export const CrossModeNotificationLevel = Schema.Literals(["info", "warning"]);
export type CrossModeNotificationLevel = typeof CrossModeNotificationLevel.Type;

/** Bounded opaque handle for a cross-mode link or approval. */
const CrossModeEventId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
);

const CrossModeSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const CrossModeTimestamp = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/),
);

/**
 * How a linked piece of work came back. A closed set of CODES: whatever the
 * counterpart actually wrote stays in the owning authority.
 */
export const CrossModeResultOutcome = Schema.Literals(["submitted", "accepted", "rejected"]);
export type CrossModeResultOutcome = typeof CrossModeResultOutcome.Type;

const eventBase = {
  schemaVersion: NotificationSchemaVersion,
  sequence: CrossModeSequence,
  occurredAt: CrossModeTimestamp,
  /** Where the user must go to act on this. The owning mode is in here. */
  target: CrossModeTarget,
} as const;

/**
 * The bounded event a mode raises. Not a wire contract — the sibling's
 * cross-mode contracts own that; this is what the renderer accepts from
 * whichever transport delivers it.
 */
export const CrossModeNotificationEvent = Schema.Union([
  /** A cross-mode link was minted and now points at `target`. */
  Schema.TaggedStruct("link-created", { ...eventBase, linkId: CrossModeEventId }),
  /** Work behind `target` is waiting for a human decision in its own mode. */
  Schema.TaggedStruct("approval-pending", {
    ...eventBase,
    approvalId: CrossModeEventId,
    linkId: Schema.optionalKey(CrossModeEventId),
  }),
  /** A linked piece of work reported back with a bounded outcome code. */
  Schema.TaggedStruct("result-submitted", {
    ...eventBase,
    linkId: CrossModeEventId,
    outcome: CrossModeResultOutcome,
  }),
]);
export type CrossModeNotificationEvent = typeof CrossModeNotificationEvent.Type;

/**
 * Bounded, human-safe text. Bounded here purely as a ceiling; the content is
 * BUILT by {@link toCrossModeNotification} from ids and codes.
 */
const NotificationText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const CrossModeNotification = Schema.Struct({
  schemaVersion: NotificationSchemaVersion,
  /** Stable per event; used as the list key and the dismissal handle. */
  notificationId: CrossModeEventId,
  kind: Schema.Literals(CROSS_MODE_NOTIFICATION_KINDS),
  level: CrossModeNotificationLevel,
  sequence: CrossModeSequence,
  occurredAt: CrossModeTimestamp,
  title: NotificationText,
  detail: NotificationText,
  /** Clicking the notification routes this through the link navigator. */
  target: CrossModeTarget,
  linkId: Schema.optionalKey(CrossModeEventId),
  approvalId: Schema.optionalKey(CrossModeEventId),
});
export type CrossModeNotification = typeof CrossModeNotification.Type;

const decodeEventOption = Schema.decodeUnknownOption(CrossModeNotificationEvent);

/** Decode an untrusted event, dropping excess keys. `null` when it is not one. */
export function decodeCrossModeNotificationEvent(
  value: unknown,
): CrossModeNotificationEvent | null {
  const decoded = decodeEventOption(value);
  return Option.isSome(decoded) ? decoded.value : null;
}

const OUTCOME_LABELS: Record<CrossModeResultOutcome, string> = {
  submitted: "submitted a result",
  accepted: "accepted the result",
  rejected: "rejected the result",
};

/**
 * Build the user-facing notification for an event. Every string is composed
 * from bounded ids and closed codes; no free text is read from anywhere,
 * because the event has no field that could hold any.
 */
export function toCrossModeNotification(event: CrossModeNotificationEvent): CrossModeNotification {
  const target = normalizeCrossModeTarget(event.target);
  const where = crossModeModeLabel(target.mode);
  const common = {
    schemaVersion: CROSS_MODE_NOTIFICATION_SCHEMA_VERSION,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    target,
  } as const;
  switch (event._tag) {
    case "link-created":
      return {
        ...common,
        notificationId: `link-created.${event.sequence}`,
        kind: "link-created",
        level: "info",
        title: `Cross-mode link created in ${where}`,
        detail: `Link ${event.linkId} points at ${describeCrossModeTarget(target)}.`,
        linkId: event.linkId,
      };
    case "approval-pending":
      return {
        ...common,
        notificationId: `approval-pending.${event.sequence}`,
        kind: "approval-pending",
        level: "warning",
        title: `${where} is waiting for approval`,
        detail: `Approval ${event.approvalId} is pending at ${describeCrossModeTarget(target)}.`,
        approvalId: event.approvalId,
        ...(event.linkId === undefined ? {} : { linkId: event.linkId }),
      };
    case "result-submitted":
      return {
        ...common,
        notificationId: `result-submitted.${event.sequence}`,
        kind: "result-submitted",
        level: "info",
        title: `${where} ${OUTCOME_LABELS[event.outcome]}`,
        detail: `Link ${event.linkId} ${OUTCOME_LABELS[event.outcome]} at ${describeCrossModeTarget(target)}.`,
        linkId: event.linkId,
      };
  }
}

/**
 * Pending approvals per owning mode. Counting only — the indicator says how
 * many decisions are waiting and where, never what they are about.
 */
export interface CrossModePendingApprovals {
  readonly total: number;
  readonly byMode: Readonly<Record<CrossModeMode, number>>;
}

export function countCrossModePendingApprovals(
  notifications: readonly CrossModeNotification[],
): CrossModePendingApprovals {
  let code = 0;
  let businessOs = 0;
  for (const notification of notifications) {
    if (notification.kind !== "approval-pending") continue;
    if (notification.target.mode === "code") code += 1;
    else businessOs += 1;
  }
  return { total: code + businessOs, byMode: { code, "business-os": businessOs } };
}

export type CrossModePendingApprovalView =
  | { readonly kind: "loading"; readonly label: string }
  | { readonly kind: "none"; readonly label: string }
  | {
      readonly kind: "pending";
      readonly label: string;
      readonly count: number;
      readonly target: CrossModeTarget;
    };

/**
 * The honest indicator state.
 *
 * "Honest" is doing real work here: the three states are distinct on purpose.
 * Before the owning authority has answered, the indicator says it does not
 * know yet — it must not render a confident `0`, because "no approvals" and
 * "not asked yet" are different facts and only one of them means the user can
 * stop looking. A settled zero says zero in words, rather than disappearing
 * and leaving the user unsure whether the check ran at all.
 */
export function resolveCrossModePendingApprovalView(input: {
  readonly settled: boolean;
  readonly approvals: CrossModePendingApprovals;
  /** Where a click should go. Required to render the pending state. */
  readonly target: CrossModeTarget | null;
}): CrossModePendingApprovalView {
  if (!input.settled) return { kind: "loading", label: "Checking for pending approvals…" };
  if (input.approvals.total === 0 || input.target === null) {
    return { kind: "none", label: "No approvals are waiting." };
  }
  const count = input.approvals.total;
  return {
    kind: "pending",
    count,
    target: input.target,
    label:
      count === 1
        ? `1 approval is waiting in ${crossModeModeLabel(input.target.mode)}`
        : `${count} approvals are waiting in ${crossModeModeLabel(input.target.mode)}`,
  };
}
