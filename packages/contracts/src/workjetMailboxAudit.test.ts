import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  isWorkjetMailboxNotificationEvent,
  toWorkjetMailboxNotification,
  WORKJET_MAILBOX_AUDIT_SCHEMA_VERSION,
  WORKJET_MAILBOX_NOTIFICATION_TAGS,
  WorkjetMailboxAuditEvent,
  WorkjetMailboxNotification,
} from "./workjetMailboxAudit.ts";

const decode = Schema.decodeUnknownSync(WorkjetMailboxAuditEvent);
const encode = Schema.encodeSync(WorkjetMailboxAuditEvent);
const decodeNotification = Schema.decodeUnknownSync(WorkjetMailboxNotification);

const V = WORKJET_MAILBOX_AUDIT_SCHEMA_VERSION;

const address = {
  workspaceId: "ctox-business-os:mesh-alpha",
  environmentId: "environment-a",
  threadId: "thread-orchestrator",
} as const;
const target = {
  workspaceId: "ctox-business-os:mesh-alpha",
  environmentId: "environment-b",
  threadId: "thread-worker",
} as const;

const envelopeId = "env-0123456789abcdef";
const delegationId = "dlg-0123456789abcdef";
const occurredAt = "2026-08-19T12:00:00.000Z";

/** The would-be secret a hostile or buggy caller might try to smuggle. */
const SECRET = "PROMPT_OR_SECRET_MUST_NEVER_LEAK";

const base = { schemaVersion: V, sequence: 0, occurredAt } as const;

const samples = {
  "envelope-enqueued": {
    ...base,
    _tag: "envelope-enqueued",
    envelopeId,
    source: address,
    target,
    delegationId,
  },
  "envelope-delivered": {
    ...base,
    _tag: "envelope-delivered",
    envelopeId,
    source: address,
    target,
    disposition: "accepted-new",
  },
  "envelope-dead-lettered": {
    ...base,
    _tag: "envelope-dead-lettered",
    envelopeId,
    attemptCount: 8,
  },
  "envelope-rejected": {
    ...base,
    _tag: "envelope-rejected",
    envelopeId,
    reasonCode: "envelope-expired",
  },
  "delegation-state-changed": {
    ...base,
    _tag: "delegation-state-changed",
    delegationId,
    envelopeId,
    source: address,
    target,
    from: "delivered",
    to: "accepted",
  },
  "delegation-approval-required": {
    ...base,
    _tag: "delegation-approval-required",
    delegationId,
    envelopeId,
    source: address,
    target,
  },
  "delegation-completed": {
    ...base,
    _tag: "delegation-completed",
    delegationId,
    envelopeId,
    source: address,
    target,
    outcome: "completed",
  },
  "budget-exceeded": { ...base, _tag: "budget-exceeded", delegationId, kind: "tokens" },
  "mesh-replication-error": {
    ...base,
    _tag: "mesh-replication-error",
    envelopeId,
    reasonCode: "publish-failed",
  },
} as const;

describe("WorkjetMailboxAuditEvent", () => {
  it("round-trips every event variant", () => {
    for (const sample of Object.values(samples)) {
      const decoded = decode(sample);
      expect(encode(decoded)).toStrictEqual(sample);
    }
  });

  it("covers all nine observable lifecycle moments with a sample", () => {
    expect(Object.keys(samples).length).toBe(9);
  });

  it("redaction canary: a would-be secret has no field to travel in and is dropped", () => {
    // A hostile caller tacks a prompt/secret onto an otherwise valid event.
    const hostile = {
      ...samples["delegation-state-changed"],
      promptText: SECRET,
      providerPayload: { apiKey: SECRET },
      secret: SECRET,
    };
    const decoded = decode(hostile);
    // The excess keys are stripped: the decoded value carries none of them.
    expect(JSON.stringify(decoded)).not.toContain(SECRET);
    expect((decoded as Record<string, unknown>).promptText).toBeUndefined();
    expect((decoded as Record<string, unknown>).secret).toBeUndefined();
  });

  it("redaction canary: a free-text reason code is rejected, not stored", () => {
    const hostile = { ...samples["envelope-rejected"], reasonCode: SECRET };
    expect(() => decode(hostile)).toThrow();
  });
});

describe("WorkjetMailboxNotification", () => {
  it("maps each notification-worthy event to a bounded, id/code-only notification", () => {
    for (const tag of WORKJET_MAILBOX_NOTIFICATION_TAGS) {
      const event = decode(samples[tag]);
      expect(isWorkjetMailboxNotificationEvent(event)).toBe(true);
      const notification = toWorkjetMailboxNotification(event);
      expect(notification).not.toBeNull();
      if (notification === null) continue;
      // It decodes against its own schema (bounded strings, valid kind).
      expect(() => decodeNotification(notification)).not.toThrow();
      expect(notification.kind).toBe(tag);
      // The human text carries ids/codes, never any payload free text.
      expect(notification.title.length).toBeGreaterThan(0);
      expect(notification.detail.length).toBeGreaterThan(0);
      expect(notification.detail).not.toContain(SECRET);
    }
  });

  it("references the concrete id/code in the built detail", () => {
    const approval = toWorkjetMailboxNotification(decode(samples["delegation-approval-required"]));
    expect(approval?.detail).toContain(delegationId);
    const dead = toWorkjetMailboxNotification(decode(samples["envelope-dead-lettered"]));
    expect(dead?.detail).toContain(envelopeId);
    expect(dead?.detail).toContain("8");
    const budget = toWorkjetMailboxNotification(decode(samples["budget-exceeded"]));
    expect(budget?.detail).toContain("tokens");
  });

  it("returns null for events outside the user-facing subset", () => {
    const nonNotification = [
      "envelope-enqueued",
      "envelope-delivered",
      "delegation-state-changed",
    ] as const;
    for (const tag of nonNotification) {
      const event = decode(samples[tag]);
      expect(isWorkjetMailboxNotificationEvent(event)).toBe(false);
      expect(toWorkjetMailboxNotification(event)).toBeNull();
    }
  });
});
