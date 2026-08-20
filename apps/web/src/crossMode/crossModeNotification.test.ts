import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  countCrossModePendingApprovals,
  CROSS_MODE_NOTIFICATION_KINDS,
  CROSS_MODE_NOTIFICATION_SCHEMA_VERSION,
  CrossModeNotification,
  CrossModeNotificationEvent,
  decodeCrossModeNotificationEvent,
  resolveCrossModePendingApprovalView,
  toCrossModeNotification,
} from "./crossModeNotification";
import { createCrossModeNotificationStore } from "./crossModeNotificationStore";
import type { CrossModeTarget } from "./crossModeTarget";

const decodeEvent = Schema.decodeUnknownSync(CrossModeNotificationEvent);
const decodeNotification = Schema.decodeUnknownSync(CrossModeNotification);

const V = CROSS_MODE_NOTIFICATION_SCHEMA_VERSION;
const occurredAt = "2026-08-20T09:00:00.000Z";

const codeTarget: CrossModeTarget = {
  mode: "code",
  environmentId: "environment-a",
  threadId: "thread-42",
};
const businessOsTarget: CrossModeTarget = {
  mode: "business-os",
  ctoxInstanceId: "instance-alpha",
  businessOsObject: { kind: "deal", id: "deal-7", moduleId: "crm" },
};

/** The would-be payload a hostile or careless producer might try to smuggle. */
const PAYLOAD = "CUSTOMER_RECORD_MUST_NEVER_LEAK";

const samples = {
  "link-created": {
    _tag: "link-created",
    schemaVersion: V,
    sequence: 1,
    occurredAt,
    target: codeTarget,
    linkId: "link-0001",
  },
  "approval-pending": {
    _tag: "approval-pending",
    schemaVersion: V,
    sequence: 2,
    occurredAt,
    target: businessOsTarget,
    approvalId: "approval-0002",
    linkId: "link-0001",
  },
  "result-submitted": {
    _tag: "result-submitted",
    schemaVersion: V,
    sequence: 3,
    occurredAt,
    target: businessOsTarget,
    linkId: "link-0001",
    outcome: "accepted",
  },
} as const;

describe("CrossModeNotification", () => {
  it("covers every notification kind with a sample", () => {
    expect(Object.keys(samples).sort()).toEqual([...CROSS_MODE_NOTIFICATION_KINDS].sort());
  });

  it("builds a bounded, id/code-only notification for each kind", () => {
    for (const kind of CROSS_MODE_NOTIFICATION_KINDS) {
      const notification = toCrossModeNotification(decodeEvent(samples[kind]));
      expect(notification.kind).toBe(kind);
      expect(() => decodeNotification(notification)).not.toThrow();
      expect(notification.title.length).toBeGreaterThan(0);
      expect(notification.detail.length).toBeGreaterThan(0);
      // Every notification carries the target — that is how a click can route
      // to the owning mode without the notification knowing anything else.
      expect(notification.target.mode).toBe(samples[kind].target.mode);
    }
  });

  it("names the concrete id and code in the built detail", () => {
    const approval = toCrossModeNotification(decodeEvent(samples["approval-pending"]));
    expect(approval.level).toBe("warning");
    expect(approval.detail).toContain("approval-0002");
    expect(approval.detail).toContain("instance-alpha");
    expect(approval.title).toContain("Business OS");

    const result = toCrossModeNotification(decodeEvent(samples["result-submitted"]));
    expect(result.level).toBe("info");
    expect(result.title).toContain("accepted the result");

    const created = toCrossModeNotification(decodeEvent(samples["link-created"]));
    expect(created.title).toContain("Code");
    expect(created.detail).toContain("thread-42");
  });

  it("redaction canary: a would-be payload has no field to travel in", () => {
    const hostile = {
      ...samples["approval-pending"],
      recordBody: { customer: PAYLOAD },
      summary: PAYLOAD,
      promptText: PAYLOAD,
      target: { ...businessOsTarget, note: PAYLOAD },
    };

    const event = decodeCrossModeNotificationEvent(hostile);
    expect(event).not.toBeNull();
    if (event === null) return;
    expect(JSON.stringify(event)).not.toContain(PAYLOAD);
    expect((event as Record<string, unknown>)["summary"]).toBeUndefined();

    const notification = toCrossModeNotification(event);
    expect(JSON.stringify(notification)).not.toContain(PAYLOAD);
    expect((notification as Record<string, unknown>)["recordBody"]).toBeUndefined();
    // The notification is exactly the allowed key set — nothing crept in.
    expect(Object.keys(notification).toSorted()).toEqual([
      "approvalId",
      "detail",
      "kind",
      "level",
      "linkId",
      "notificationId",
      "occurredAt",
      "schemaVersion",
      "sequence",
      "target",
      "title",
    ]);
  });

  it("redaction canary: free text cannot pose as an id or an outcome code", () => {
    expect(
      decodeCrossModeNotificationEvent({ ...samples["link-created"], linkId: PAYLOAD + " " }),
    ).toBeNull();
    expect(
      decodeCrossModeNotificationEvent({ ...samples["result-submitted"], outcome: PAYLOAD }),
    ).toBeNull();
    expect(
      decodeCrossModeNotificationEvent({ ...samples["link-created"], _tag: "note" }),
    ).toBeNull();
  });
});

describe("pending-approval indicator", () => {
  const approvals = (targets: readonly CrossModeTarget[]) =>
    countCrossModePendingApprovals(
      targets.map((target, index) =>
        toCrossModeNotification(
          decodeEvent({
            ...samples["approval-pending"],
            sequence: index,
            target,
            approvalId: `approval-000${index}`,
          }),
        ),
      ),
    );

  it("counts only pending approvals, per owning mode", () => {
    expect(approvals([businessOsTarget, businessOsTarget, codeTarget])).toEqual({
      total: 3,
      byMode: { code: 1, "business-os": 2 },
    });

    const mixed = [
      toCrossModeNotification(decodeEvent(samples["link-created"])),
      toCrossModeNotification(decodeEvent(samples["result-submitted"])),
    ];
    expect(countCrossModePendingApprovals(mixed)).toEqual({
      total: 0,
      byMode: { code: 0, "business-os": 0 },
    });
  });

  it("tells 'not asked yet' apart from 'nothing waiting'", () => {
    const none = { total: 0, byMode: { code: 0, "business-os": 0 } } as const;

    expect(
      resolveCrossModePendingApprovalView({ settled: false, approvals: none, target: null }),
    ).toEqual({ kind: "loading", label: "Checking for pending approvals…" });

    expect(
      resolveCrossModePendingApprovalView({ settled: true, approvals: none, target: null }),
    ).toEqual({ kind: "none", label: "No approvals are waiting." });
  });

  it("names the count and the owning mode when approvals are waiting", () => {
    const view = resolveCrossModePendingApprovalView({
      settled: true,
      approvals: { total: 2, byMode: { code: 0, "business-os": 2 } },
      target: businessOsTarget,
    });
    expect(view.kind).toBe("pending");
    expect(view.label).toBe("2 approvals are waiting in Business OS");

    const single = resolveCrossModePendingApprovalView({
      settled: true,
      approvals: { total: 1, byMode: { code: 1, "business-os": 0 } },
      target: codeTarget,
    });
    expect(single.label).toBe("1 approval is waiting in Code");
  });
});

describe("crossModeNotificationStore", () => {
  it("starts unsettled and empty, and settles on the first report", () => {
    const store = createCrossModeNotificationStore();
    expect(store.getSnapshot()).toEqual({ settled: false, notifications: [] });

    store.settle();
    expect(store.getSnapshot()).toEqual({ settled: true, notifications: [] });
  });

  it("publishes newest first, dedupes, and notifies subscribers", () => {
    const store = createCrossModeNotificationStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    expect(store.publish(samples["link-created"])).not.toBeNull();
    expect(store.publish(samples["approval-pending"])).not.toBeNull();
    expect(store.publish(samples["approval-pending"])).not.toBeNull();

    const snapshot = store.getSnapshot();
    expect(snapshot.settled).toBe(true);
    expect(snapshot.notifications.map((entry) => entry.notificationId)).toEqual([
      "approval-pending.2",
      "link-created.1",
    ]);
    expect(notified).toBe(3);

    store.dismiss("approval-pending.2");
    expect(store.getSnapshot().notifications.map((entry) => entry.notificationId)).toEqual([
      "link-created.1",
    ]);
    unsubscribe();
  });

  it("refuses a value that is not a bounded cross-mode event", () => {
    const store = createCrossModeNotificationStore();
    expect(store.publish({ _tag: "link-created", summary: PAYLOAD })).toBeNull();
    expect(store.getSnapshot()).toEqual({ settled: false, notifications: [] });
  });
});
