// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Renders the Workjet mailbox notifications selected from the audit stream —
 * the "later slice" `server.ts:1109` was wired for (docs/workjet-plan.md §8).
 *
 * The entry that justifies this surface is `envelope-dead-lettered`: an
 * envelope that exhausted its delivery attempts and will never arrive. It has
 * no other representation anywhere, so without this the sender sees a message
 * that looked sent, the recipient never receives it, and nothing tells anyone.
 *
 * ── Not clickable, on purpose ───────────────────────────────────────────────
 * Unlike the cross-mode rows beside it, these carry no navigation target. A
 * dead-lettered envelope has no thread to open — that is the whole problem
 * with it — and a budget-exceeded or approval-required event names a
 * delegation whose thread this component has no authorized way to resolve.
 * Rendering a button that goes nowhere would be worse than rendering text.
 *
 * Every string comes from `toWorkjetMailboxNotification`, which composes them
 * from bounded ids and closed codes. Nothing here reads a payload.
 */
import type { WorkjetMailboxNotification } from "@t3tools/contracts";
import { AlertTriangleIcon, InboxIcon } from "lucide-react";

import { cn } from "../lib/utils";

export function WorkjetMailboxNotificationRow({
  notification,
}: {
  readonly notification: WorkjetMailboxNotification;
}) {
  const isWarning = notification.level === "warning";
  const Icon = isWarning ? AlertTriangleIcon : InboxIcon;
  return (
    <li
      className="flex items-start gap-2 rounded-md border border-border bg-card px-2.5 py-2"
      data-workjet-mailbox-notification=""
      data-workjet-mailbox-notification-kind={notification.kind}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          isWarning ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {notification.title}
        </span>
        <span className="mt-0.5 block break-words text-xs text-muted-foreground">
          {notification.detail}
        </span>
      </div>
    </li>
  );
}

/**
 * Renders nothing when there is nothing. An empty "Mailbox (0)" box would
 * occupy the thread view permanently to say that the ordinary case is
 * happening, and these events are rare by nature.
 */
export function WorkjetMailboxNotificationList({
  notifications,
}: {
  readonly notifications: ReadonlyArray<WorkjetMailboxNotification>;
}) {
  if (notifications.length === 0) return null;
  const warningCount = notifications.filter(
    (notification) => notification.level === "warning",
  ).length;

  return (
    <section
      aria-label="Workjet mailbox activity"
      className="flex flex-col gap-2"
      data-workjet-mailbox-notifications=""
    >
      <h2 className="text-xs font-medium text-muted-foreground">
        {warningCount > 0
          ? `Mailbox — ${warningCount} need${warningCount === 1 ? "s" : ""} attention`
          : "Mailbox"}
      </h2>
      <ul className="flex flex-col gap-1.5">
        {notifications.map((notification) => (
          <WorkjetMailboxNotificationRow
            key={`${notification.kind}:${notification.sequence}`}
            notification={notification}
          />
        ))}
      </ul>
    </section>
  );
}
