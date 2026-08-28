// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { WorkjetMailboxNotification } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkjetMailboxNotificationList } from "./WorkjetMailboxNotifications";

const notification = (
  overrides: Partial<WorkjetMailboxNotification> = {},
): WorkjetMailboxNotification =>
  ({
    schemaVersion: 1,
    kind: "envelope-dead-lettered",
    level: "warning",
    sequence: 1,
    occurredAt: "2026-08-20T10:00:00.000Z",
    title: "Envelope could not be delivered",
    detail: "Envelope env-1 was dead-lettered after 5 delivery attempts.",
    envelopeId: "env-1",
    ...overrides,
  }) as WorkjetMailboxNotification;

describe("WorkjetMailboxNotificationList", () => {
  it("renders a dead-lettered envelope, which had no representation at all", () => {
    const markup = renderToStaticMarkup(
      <WorkjetMailboxNotificationList notifications={[notification()]} />,
    );

    expect(markup).toContain("env-1");
    expect(markup).toContain('data-workjet-mailbox-notification-kind="envelope-dead-lettered"');
  });

  it("renders nothing at all when there is nothing", () => {
    // An empty "Mailbox (0)" box would permanently occupy the thread view to
    // announce that the ordinary case is happening. These events are rare.
    expect(renderToStaticMarkup(<WorkjetMailboxNotificationList notifications={[]} />)).toBe("");
  });

  it("counts what needs attention, and says it in the heading", () => {
    const markup = renderToStaticMarkup(
      <WorkjetMailboxNotificationList
        notifications={[
          notification({ sequence: 1 }),
          notification({ sequence: 2 }),
          notification({ sequence: 3, kind: "delegation-completed", level: "info" }),
        ]}
      />,
    );

    expect(markup).toContain("2 need");
    expect(markup).not.toContain("3 need");
  });

  it("offers no navigation, because a dead-lettered envelope has nowhere to go", () => {
    // That is precisely what is wrong with it. A button that went nowhere
    // would be worse than text.
    const markup = renderToStaticMarkup(
      <WorkjetMailboxNotificationList notifications={[notification()]} />,
    );

    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<a ");
  });

  it("renders only what the contract composed, never a payload", () => {
    // The title and detail are built from bounded ids and closed codes by
    // toWorkjetMailboxNotification. This component adds no string of its own
    // beyond the heading, so nothing here can leak content.
    const markup = renderToStaticMarkup(
      <WorkjetMailboxNotificationList
        notifications={[notification({ detail: "Envelope env-9 was dead-lettered." })]}
      />,
    );

    expect(markup).toContain("Envelope env-9 was dead-lettered.");
  });
});
