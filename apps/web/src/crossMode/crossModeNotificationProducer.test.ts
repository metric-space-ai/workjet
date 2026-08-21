// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it, beforeEach } from "vite-plus/test";

import {
  publishCrossModeLinkCreated,
  publishCrossModeResultSubmitted,
  resetCrossModeSequenceForTests,
} from "./crossModeNotificationProducer";
import { crossModeNotificationStore } from "./crossModeNotificationStore";
import type { CrossModeTarget } from "./crossModeTarget";

const target: CrossModeTarget = {
  mode: "code",
  environmentId: "env-1",
  threadId: "thread-1",
};

describe("cross-mode notification producer", () => {
  beforeEach(() => {
    crossModeNotificationStore.reset();
    resetCrossModeSequenceForTests();
  });

  it("actually reaches the store, which nothing did before", () => {
    // The model and the panel were built and tested, and then no code path
    // ever called publish — so the surface would have rendered permanently
    // empty. This is the test that would have caught that.
    publishCrossModeLinkCreated({
      linkId: "link-1",
      target,
      occurredAt: "2026-08-20T10:00:00.000Z",
    });

    const { notifications } = crossModeNotificationStore.getSnapshot();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("link-created");
    expect(notifications[0]?.target).toEqual(target);
  });

  it("orders by a session sequence, not by the clock", () => {
    // Two events in the same millisecond must still order, and a clock that
    // steps backwards must not reshuffle what the user already saw.
    const sameInstant = "2026-08-20T10:00:00.000Z";
    publishCrossModeLinkCreated({ linkId: "link-1", target, occurredAt: sameInstant });
    publishCrossModeResultSubmitted({
      linkId: "link-2",
      target,
      occurredAt: "2026-08-20T09:00:00.000Z",
      outcome: "submitted",
    });

    const sequences = crossModeNotificationStore
      .getSnapshot()
      .notifications.map((entry) => entry.sequence);
    expect(new Set(sequences).size).toBe(2);
    expect(Math.max(...sequences)).toBe(1);
  });

  it("carries no summary, artifact or free text", () => {
    // The payload stays in the owning authority and is read there once the
    // navigation lands — which is why a notification carries a TARGET and not
    // a description. A producer that passed prose would be lying about what
    // travels, and the decoder would drop it anyway.
    publishCrossModeResultSubmitted({
      linkId: "link-1",
      target,
      occurredAt: "2026-08-20T10:00:00.000Z",
      outcome: "submitted",
    });

    const [entry] = crossModeNotificationStore.getSnapshot().notifications;
    expect(entry).toBeDefined();
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("summary");
    expect(serialized).not.toContain("artifact");
    expect(Object.keys(entry ?? {})).not.toContain("evidence");
  });

  it("raises no approval-pending moment, deliberately", () => {
    // An approval starts waiting inside the OWNING mode, which for a Business
    // OS approval is not this process. There is no local event for it, and a
    // guessed trigger would show a notification at the wrong time or one that
    // never clears. This pins the gap so a later change has to face it.
    publishCrossModeLinkCreated({
      linkId: "link-1",
      target,
      occurredAt: "2026-08-20T10:00:00.000Z",
    });
    publishCrossModeResultSubmitted({
      linkId: "link-1",
      target,
      occurredAt: "2026-08-20T10:01:00.000Z",
      outcome: "submitted",
    });

    const kinds = crossModeNotificationStore.getSnapshot().notifications.map((entry) => entry.kind);
    expect(kinds).not.toContain("approval-pending");
  });
});
