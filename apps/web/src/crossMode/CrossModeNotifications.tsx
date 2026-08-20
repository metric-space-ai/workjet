// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The user-facing half of docs/workjet-plan.md "Cross-mode workflow bridge"
 * item 5: one list of redacted cross-mode notifications and one honest
 * pending-approval indicator, both of which route a click through the link
 * navigator rather than navigating themselves.
 *
 * Two rules shape everything below.
 *
 * 1. A notification shows what the OWNING AUTHORITY can be asked about — ids,
 *    codes, and a target — never the record behind them. The text rendered
 *    here is built in `crossModeNotification.ts` from those ids and codes; this
 *    file adds no data of its own, which is why it takes a
 *    `CrossModeNotification` and not a free-form view model.
 * 2. Clicking routes through `navigateToCrossModeTarget`. That is the only
 *    path that tears the other mode's heavy surface down first, so a
 *    notification must never call `router.navigate` or flip the product mode
 *    on its own.
 *
 * The empty and zero states are deliberately distinct: "nobody has reported
 * yet" and "an authority reported nothing" are different facts, and collapsing
 * them into one blank panel would tell the user something that is not known.
 *
 * ── Not mounted in the shell yet, on purpose ────────────────────────────────
 * Nothing publishes into `crossModeNotificationStore` until the cross-mode
 * link RPCs land (they are owned alongside the link contract). Mounting
 * `CrossModeNotificationCenter` now would put a panel in the sidebar that can
 * only ever say "no cross-mode activity", which is a worse lie than showing
 * nothing. It is wired, tested, and ready: the shell mounts it in the same
 * change that starts feeding the store.
 */
import { AlertTriangleIcon, ArrowUpRightIcon, LinkIcon, XIcon } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";

import { cn } from "../lib/utils";
import {
  countCrossModePendingApprovals,
  resolveCrossModePendingApprovalView,
  type CrossModeNotification,
  type CrossModePendingApprovalView,
} from "./crossModeNotification";
import {
  crossModeNotificationStore,
  type CrossModeNotificationSnapshot,
} from "./crossModeNotificationStore";
import { crossModeModeLabel, type CrossModeTarget } from "./crossModeTarget";
import { useCrossModeNavigator } from "./useCrossModeNavigator";

export function CrossModeNotificationRow({
  notification,
  onOpen,
  onDismiss,
}: {
  readonly notification: CrossModeNotification;
  readonly onOpen: (target: CrossModeTarget) => void;
  readonly onDismiss: (notificationId: string) => void;
}) {
  const isWarning = notification.level === "warning";
  const Icon = isWarning ? AlertTriangleIcon : LinkIcon;
  return (
    <li
      className="flex items-start gap-2 rounded-md border border-border bg-card px-2.5 py-2"
      data-cross-mode-notification=""
      data-cross-mode-notification-kind={notification.kind}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          isWarning ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <button
        className="min-w-0 flex-1 text-left"
        data-cross-mode-notification-open=""
        onClick={() => onOpen(notification.target)}
        type="button"
      >
        <span className="flex items-center gap-1 text-sm font-medium text-foreground">
          <span className="truncate">{notification.title}</span>
          <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </span>
        <span className="mt-0.5 block break-words text-xs text-muted-foreground">
          {notification.detail}
        </span>
        <span className="sr-only">
          {` Open in ${crossModeModeLabel(notification.target.mode)}.`}
        </span>
      </button>
      <button
        aria-label="Dismiss notification"
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        data-cross-mode-notification-dismiss=""
        onClick={() => onDismiss(notification.notificationId)}
        type="button"
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </li>
  );
}

export function CrossModeNotificationList({
  snapshot,
  onOpen,
  onDismiss,
}: {
  readonly snapshot: CrossModeNotificationSnapshot;
  readonly onOpen: (target: CrossModeTarget) => void;
  readonly onDismiss: (notificationId: string) => void;
}) {
  if (!snapshot.settled) {
    return (
      <p
        className="px-2.5 py-2 text-xs text-muted-foreground"
        data-cross-mode-notifications-loading=""
        role="status"
      >
        Checking both modes for cross-mode activity…
      </p>
    );
  }
  if (snapshot.notifications.length === 0) {
    return (
      <p
        className="px-2.5 py-2 text-xs text-muted-foreground"
        data-cross-mode-notifications-empty=""
        role="status"
      >
        No cross-mode activity. Links, approvals, and results appear here.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5" data-cross-mode-notifications="">
      {snapshot.notifications.map((notification) => (
        <CrossModeNotificationRow
          key={notification.notificationId}
          notification={notification}
          onDismiss={onDismiss}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

export function CrossModePendingApprovalIndicator({
  view,
  onOpen,
}: {
  readonly view: CrossModePendingApprovalView;
  readonly onOpen: (target: CrossModeTarget) => void;
}) {
  if (view.kind === "loading") {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-cross-mode-approval-indicator="loading"
        role="status"
      >
        {view.label}
      </p>
    );
  }
  if (view.kind === "none") {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-cross-mode-approval-indicator="none"
        role="status"
      >
        {view.label}
      </p>
    );
  }
  return (
    <button
      className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium text-foreground"
      data-cross-mode-approval-indicator="pending"
      data-cross-mode-approval-open=""
      onClick={() => onOpen(view.target)}
      type="button"
    >
      <AlertTriangleIcon aria-hidden className="size-3.5 text-destructive" />
      {view.label}
    </button>
  );
}

/**
 * Container: subscribes to the bounded store and routes every click through
 * the navigator. Rendered wherever the shell wants the list; it holds no state
 * of its own, so mounting it twice is harmless.
 */
export function CrossModeNotificationCenter() {
  const snapshot = useSyncExternalStore(
    crossModeNotificationStore.subscribe,
    crossModeNotificationStore.getSnapshot,
    crossModeNotificationStore.getSnapshot,
  );
  const navigate = useCrossModeNavigator();
  const onOpen = useCallback(
    (target: CrossModeTarget) => {
      void navigate(target);
    },
    [navigate],
  );
  const onDismiss = useCallback((notificationId: string) => {
    crossModeNotificationStore.dismiss(notificationId);
  }, []);

  const approvals = countCrossModePendingApprovals(snapshot.notifications);
  const firstApproval =
    snapshot.notifications.find((entry) => entry.kind === "approval-pending") ?? null;
  const view = resolveCrossModePendingApprovalView({
    settled: snapshot.settled,
    approvals,
    target: firstApproval?.target ?? null,
  });

  return (
    <section aria-label="Cross-mode activity" className="flex flex-col gap-2">
      <CrossModePendingApprovalIndicator onOpen={onOpen} view={view} />
      <CrossModeNotificationList onDismiss={onDismiss} onOpen={onOpen} snapshot={snapshot} />
    </section>
  );
}
