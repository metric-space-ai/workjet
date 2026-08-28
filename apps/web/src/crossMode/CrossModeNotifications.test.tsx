import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  CrossModeNotificationList,
  CrossModeNotificationRow,
  CrossModePendingApprovalIndicator,
} from "./CrossModeNotifications";
import {
  decodeCrossModeNotificationEvent,
  resolveCrossModePendingApprovalView,
  toCrossModeNotification,
  type CrossModeNotification,
} from "./crossModeNotification";
import type { CrossModeNotificationSnapshot } from "./crossModeNotificationStore";
import type { CrossModeTarget } from "./crossModeTarget";

type ClickableProps = Record<string, unknown> & { readonly onClick?: () => void };

function findByMarker(node: ReactNode, marker: string): ClickableProps | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = (child as ReactElement<ClickableProps>).props;
    if (props[marker] !== undefined) return props;
    const found = findByMarker(props["children"] as ReactNode, marker);
    if (found) return found;
  }
  return null;
}

const PAYLOAD = "CUSTOMER_RECORD_MUST_NEVER_LEAK";

const businessOsTarget: CrossModeTarget = {
  mode: "business-os",
  ctoxInstanceId: "instance-alpha",
  businessOsObject: { kind: "deal", id: "deal-7", moduleId: "crm" },
};

function buildNotification(overrides: Record<string, unknown> = {}): CrossModeNotification {
  const event = decodeCrossModeNotificationEvent({
    _tag: "approval-pending",
    schemaVersion: 1,
    sequence: 2,
    occurredAt: "2026-08-20T09:00:00.000Z",
    target: businessOsTarget,
    approvalId: "approval-0002",
    ...overrides,
  });
  if (event === null) throw new Error("sample event must decode");
  return toCrossModeNotification(event);
}

const snapshotOf = (
  notifications: readonly CrossModeNotification[],
  settled = true,
): CrossModeNotificationSnapshot => ({ settled, notifications });

describe("CrossModeNotificationRow", () => {
  it("routes a click to the caller with the notification's target", () => {
    const opened: CrossModeTarget[] = [];
    const element = CrossModeNotificationRow({
      notification: buildNotification(),
      onOpen: (target) => opened.push(target),
      onDismiss: () => undefined,
    });

    const open = findByMarker(element, "data-cross-mode-notification-open");
    expect(open).not.toBeNull();
    open?.onClick?.();

    // The row never navigates itself: it hands the target back, and the
    // container is what pushes it through the link navigator.
    expect(opened).toEqual([businessOsTarget]);
  });

  it("dismisses by notification id", () => {
    const dismissed: string[] = [];
    const notification = buildNotification();
    const element = CrossModeNotificationRow({
      notification,
      onOpen: () => undefined,
      onDismiss: (id) => dismissed.push(id),
    });

    findByMarker(element, "data-cross-mode-notification-dismiss")?.onClick?.();
    expect(dismissed).toEqual([notification.notificationId]);
  });

  it("renders only the built title and detail — no payload can appear", () => {
    const notification = buildNotification({
      recordBody: { customer: PAYLOAD },
      target: { ...businessOsTarget, note: PAYLOAD },
    });
    const markup = renderToStaticMarkup(
      CrossModeNotificationRow({
        notification,
        onOpen: () => undefined,
        onDismiss: () => undefined,
      }),
    );

    expect(markup).not.toContain(PAYLOAD);
    expect(markup).toContain("approval-0002");
    expect(markup).toContain("instance-alpha");
    expect(markup).toContain('data-cross-mode-notification-kind="approval-pending"');
  });
});

describe("CrossModeNotificationList", () => {
  it("says it is still checking before any authority has reported", () => {
    const markup = renderToStaticMarkup(
      CrossModeNotificationList({
        snapshot: snapshotOf([], false),
        onOpen: () => undefined,
        onDismiss: () => undefined,
      }),
    );

    expect(markup).toContain("data-cross-mode-notifications-loading");
    expect(markup).toContain("Checking both modes");
    expect(markup).not.toContain("data-cross-mode-notifications-empty");
  });

  it("says there is nothing once an authority has reported nothing", () => {
    const markup = renderToStaticMarkup(
      CrossModeNotificationList({
        snapshot: snapshotOf([]),
        onOpen: () => undefined,
        onDismiss: () => undefined,
      }),
    );

    expect(markup).toContain("data-cross-mode-notifications-empty");
    expect(markup).toContain("No cross-mode activity");
    expect(markup).not.toContain("data-cross-mode-notifications-loading");
  });

  it("renders one row per notification", () => {
    const markup = renderToStaticMarkup(
      CrossModeNotificationList({
        snapshot: snapshotOf([
          buildNotification(),
          buildNotification({ _tag: "link-created", sequence: 1, linkId: "link-0001" }),
        ]),
        onOpen: () => undefined,
        onDismiss: () => undefined,
      }),
    );

    expect(markup.split("data-cross-mode-notification=").length - 1).toBe(2);
    expect(markup).toContain('data-cross-mode-notification-kind="link-created"');
  });
});

describe("CrossModePendingApprovalIndicator", () => {
  const none = { total: 0, byMode: { code: 0, "business-os": 0 } } as const;

  it("offers nothing to click while the answer is unknown or empty", () => {
    for (const settled of [false, true]) {
      const element = CrossModePendingApprovalIndicator({
        view: resolveCrossModePendingApprovalView({ settled, approvals: none, target: null }),
        onOpen: () => undefined,
      });
      expect(findByMarker(element, "data-cross-mode-approval-open")).toBeNull();
      const markup = renderToStaticMarkup(element);
      expect(markup).toContain(settled ? "No approvals are waiting" : "Checking for pending");
    }
  });

  it("routes the pending indicator through the caller's navigator", () => {
    const opened: CrossModeTarget[] = [];
    const element = CrossModePendingApprovalIndicator({
      view: resolveCrossModePendingApprovalView({
        settled: true,
        approvals: { total: 2, byMode: { code: 0, "business-os": 2 } },
        target: businessOsTarget,
      }),
      onOpen: (target) => opened.push(target),
    });

    const open = findByMarker(element, "data-cross-mode-approval-open");
    expect(open).not.toBeNull();
    open?.onClick?.();
    expect(opened).toEqual([businessOsTarget]);
    expect(renderToStaticMarkup(element)).toContain("2 approvals are waiting in Business OS");
  });
});
