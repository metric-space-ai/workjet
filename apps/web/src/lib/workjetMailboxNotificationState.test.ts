// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { WorkjetMailboxAuditEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accumulateWorkjetMailboxNotification,
  selectWorkjetMailboxNotifications,
  selectWorkjetMailboxWarnings,
  WORKJET_MAILBOX_NOTIFICATION_LIMIT,
} from "./workjetMailboxNotificationState";

const deadLetter = (sequence: number, occurredAt: string): WorkjetMailboxAuditEvent =>
  ({
    _tag: "envelope-dead-lettered",
    schemaVersion: 1,
    sequence,
    occurredAt,
    envelopeId: `env-${sequence}`,
    attemptCount: 5,
  }) as unknown as WorkjetMailboxAuditEvent;

describe("workjet mailbox notifications", () => {
  it("surfaces a dead-lettered envelope, which reached no surface at all before", () => {
    // The silent failure this closes: the sender saw a message that looked
    // sent, the recipient never got it, and nothing told anyone.
    const [notification] = selectWorkjetMailboxNotifications([
      deadLetter(1, "2026-08-20T10:00:00.000Z"),
    ]);

    expect(notification?.kind).toBe("envelope-dead-lettered");
    expect(notification?.level).toBe("warning");
    expect(notification?.detail).toContain("env-1");
  });

  it("orders by sequence, not by the clock", () => {
    // The producing server owns these; two can share a millisecond, and a
    // backwards clock must not reshuffle what the operator already read.
    const selected = selectWorkjetMailboxNotifications([
      deadLetter(1, "2026-08-20T12:00:00.000Z"),
      deadLetter(2, "2026-08-20T09:00:00.000Z"),
    ]);

    expect(selected.map((entry) => entry.sequence)).toEqual([2, 1]);
  });

  it("deduplicates a re-delivered event, so one failure is not read as two", () => {
    // A subscription re-delivers on reconnect. The same dead-letter counted
    // twice would send someone looking for a second problem that is not there.
    const selected = selectWorkjetMailboxNotifications([
      deadLetter(7, "2026-08-20T10:00:00.000Z"),
      deadLetter(7, "2026-08-20T10:00:00.000Z"),
    ]);

    expect(selected).toHaveLength(1);
  });

  it("caps the list, because a stream is unbounded and a glance surface is not", () => {
    const many = Array.from({ length: WORKJET_MAILBOX_NOTIFICATION_LIMIT + 10 }, (_unused, index) =>
      deadLetter(index, "2026-08-20T10:00:00.000Z"),
    );

    const selected = selectWorkjetMailboxNotifications(many);
    expect(selected).toHaveLength(WORKJET_MAILBOX_NOTIFICATION_LIMIT);
    // The NEWEST survive; dropping the newest would hide the live problem.
    expect(selected[0]?.sequence).toBe(WORKJET_MAILBOX_NOTIFICATION_LIMIT + 9);
  });

  it("drops events outside the user-facing subset instead of rendering them raw", () => {
    const notNotifiable = {
      _tag: "envelope-enqueued",
      schemaVersion: 1,
      sequence: 1,
      occurredAt: "2026-08-20T10:00:00.000Z",
      envelopeId: "env-1",
    } as unknown as WorkjetMailboxAuditEvent;

    expect(selectWorkjetMailboxNotifications([notNotifiable])).toHaveLength(0);
  });

  it("separates the warnings, and the level comes from the contract not a payload", () => {
    const warnings = selectWorkjetMailboxWarnings(
      selectWorkjetMailboxNotifications([deadLetter(1, "2026-08-20T10:00:00.000Z")]),
    );
    expect(warnings).toHaveLength(1);
  });
});

describe("accumulating the stream", () => {
  it("keeps earlier entries, because the atom yields only the latest value", () => {
    // Without accumulation the surface shows exactly one notification —
    // whichever arrived last — and a dead-letter vanishes the moment any other
    // event follows it. That reads as the problem having resolved.
    let list = accumulateWorkjetMailboxNotification([], deadLetter(1, "2026-08-20T10:00:00.000Z"));
    list = accumulateWorkjetMailboxNotification(list, deadLetter(2, "2026-08-20T10:01:00.000Z"));

    expect(list.map((entry) => entry.sequence)).toEqual([2, 1]);
  });

  it("returns the SAME array for a re-delivered event", () => {
    // React rerenders on reference change; a reconnect that replays the stream
    // must not rerender the thread view for events already shown.
    const first = accumulateWorkjetMailboxNotification(
      [],
      deadLetter(1, "2026-08-20T10:00:00.000Z"),
    );
    const again = accumulateWorkjetMailboxNotification(
      first,
      deadLetter(1, "2026-08-20T10:00:00.000Z"),
    );

    expect(again).toBe(first);
  });

  it("returns the same array for an event outside the subset, and for null", () => {
    const list = accumulateWorkjetMailboxNotification(
      [],
      deadLetter(1, "2026-08-20T10:00:00.000Z"),
    );
    const notNotifiable = {
      _tag: "envelope-enqueued",
      schemaVersion: 1,
      sequence: 99,
      occurredAt: "2026-08-20T10:00:00.000Z",
      envelopeId: "env-99",
    } as unknown as WorkjetMailboxAuditEvent;

    expect(accumulateWorkjetMailboxNotification(list, notNotifiable)).toBe(list);
    expect(accumulateWorkjetMailboxNotification(list, null)).toBe(list);
  });

  it("caps while accumulating, keeping the newest", () => {
    let accumulated = accumulateWorkjetMailboxNotification(
      [],
      deadLetter(0, "2026-08-20T10:00:00.000Z"),
    );
    for (let index = 1; index <= WORKJET_MAILBOX_NOTIFICATION_LIMIT + 5; index += 1) {
      accumulated = accumulateWorkjetMailboxNotification(
        accumulated,
        deadLetter(index, "2026-08-20T10:00:00.000Z"),
      );
    }

    expect(accumulated).toHaveLength(WORKJET_MAILBOX_NOTIFICATION_LIMIT);
    expect(accumulated[0]?.sequence).toBe(WORKJET_MAILBOX_NOTIFICATION_LIMIT + 5);
  });
});
