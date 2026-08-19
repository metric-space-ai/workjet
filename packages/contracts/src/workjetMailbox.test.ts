// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  WORKJET_MAILBOX_SCHEMA_VERSION,
  WORKJET_TERMINAL_DELEGATION_STATES,
  WorkjetArtifactReferences,
  WorkjetDelegation,
  WorkjetDelegationEdge,
  WorkjetDelegationResult,
  WorkjetDelegationState,
  WorkjetDeliveryReceipt,
  WorkjetEnvironmentAddress,
  WorkjetMailboxError,
  WorkjetMailboxPayload,
  WorkjetMailboxTimestamp,
  WorkjetReviewVerdict,
  WorkjetRoutingEnvelope,
  WorkjetThreadHandoff,
  WorkjetWorkerAddress,
  WorkjetWorkerMessage,
} from "./workjetMailbox.ts";

const control = String.fromCharCode(0);

const decodeAddress = Schema.decodeUnknownSync(WorkjetWorkerAddress);
const decodeEnvironmentAddress = Schema.decodeUnknownSync(WorkjetEnvironmentAddress);
const decodeMessage = Schema.decodeUnknownSync(WorkjetWorkerMessage);
const decodeDelegation = Schema.decodeUnknownSync(WorkjetDelegation);
const decodeReceipt = Schema.decodeUnknownSync(WorkjetDeliveryReceipt);
const decodeResult = Schema.decodeUnknownSync(WorkjetDelegationResult);
const decodeVerdict = Schema.decodeUnknownSync(WorkjetReviewVerdict);
const decodeEdge = Schema.decodeUnknownSync(WorkjetDelegationEdge);
const decodeHandoff = Schema.decodeUnknownSync(WorkjetThreadHandoff);
const decodeRoutingEnvelope = Schema.decodeUnknownSync(WorkjetRoutingEnvelope);
const decodeArtifacts = Schema.decodeUnknownSync(WorkjetArtifactReferences);
const decodePayload = Schema.decodeUnknownSync(WorkjetMailboxPayload);
const decodeState = Schema.decodeUnknownSync(WorkjetDelegationState);
const decodeTimestamp = Schema.decodeUnknownSync(WorkjetMailboxTimestamp);

const V = WORKJET_MAILBOX_SCHEMA_VERSION;

const sourceAddress = {
  schemaVersion: V,
  workspaceId: "ctox-business-os:mesh-alpha",
  environmentId: "environment-a",
  threadId: "thread-orchestrator",
} as const;

const targetAddress = {
  schemaVersion: V,
  workspaceId: "ctox-business-os:mesh-alpha",
  environmentId: "environment-b",
  threadId: "thread-worker",
} as const;

const envelopeId = "env-0123456789abcdef";
const otherEnvelopeId = "env-fedcba9876543210";
const delegationId = "dlg-0123456789abcdef";
const payloadRef = "c2VhbGVkLXBheWxvYWQtcmVm";
const digest = "a".repeat(64);

const message = {
  schemaVersion: V,
  envelopeId,
  source: sourceAddress,
  target: targetAddress,
  createdAt: "2026-08-18T10:00:00.000Z",
  expiresAt: "2026-08-18T11:00:00.000Z",
  body: { _tag: "sealed", payloadRef, byteLength: 2_048 },
} as const;

const delegationRef = {
  schemaVersion: V,
  delegationId,
  owner: sourceAddress,
} as const;

const delegation = {
  schemaVersion: V,
  envelopeId,
  delegationId,
  source: sourceAddress,
  target: targetAddress,
  createdAt: "2026-08-18T10:00:00.000Z",
  expiresAt: "2026-08-18T11:00:00.000Z",
  prompt: {
    schemaVersion: V,
    snapshotRef: payloadRef,
    digest,
    byteLength: 16_384,
  },
  scope: {
    schemaVersion: V,
    files: ["packages/contracts/src/workjetMailbox.ts"],
    nonGoals: "No server wiring.\nNo transport implementation.",
  },
  completion: {
    schemaVersion: V,
    acceptance: "vp test run passes and typecheck reports zero diagnostics.",
  },
  budget: {
    schemaVersion: V,
    maxDepth: 3,
    maxReviewRounds: 2,
    expiresAt: "2026-08-19T10:00:00.000Z",
  },
  state: "queued",
  stateChangedAt: "2026-08-18T10:00:00.000Z",
  depth: 0,
} as const;

const artifacts = {
  schemaVersion: V,
  branch: {
    schemaVersion: V,
    branch: "agent/m-mailbox-contracts",
    headCommit: "339c6940f",
    delivery: "sync-bundled",
  },
  commitHashes: ["339c6940f", "abcdef1234567890"],
  paths: ["packages/contracts/src/workjetMailbox.ts"],
} as const;

const result = {
  schemaVersion: V,
  envelopeId: otherEnvelopeId,
  delegation: delegationRef,
  reportedBy: targetAddress,
  reportedAt: "2026-08-18T12:00:00.000Z",
  outcome: "completed",
  summary: "Added versioned mailbox contracts.",
  artifacts,
} as const;

const verdict = {
  schemaVersion: V,
  envelopeId: otherEnvelopeId,
  delegation: delegationRef,
  reviewer: sourceAddress,
  decidedAt: "2026-08-18T12:30:00.000Z",
  decision: "changes-requested",
  round: 1,
  reasons: ["Scope list omits the index export."],
} as const;

const edge = {
  schemaVersion: V,
  kind: "reviews",
  from: delegationRef,
  to: { ...delegationRef, delegationId: "dlg-fedcba9876543210" },
  createdAt: "2026-08-18T12:30:00.000Z",
  depth: 1,
} as const;

const handoff = {
  schemaVersion: V,
  envelopeId,
  handoffId: "hnd-0123456789abcdef",
  sourceThread: sourceAddress,
  target: {
    schemaVersion: V,
    workspaceId: "ctox-business-os:mesh-alpha",
    environmentId: "environment-b",
  },
  createdAt: "2026-08-18T13:00:00.000Z",
  expiresAt: "2026-08-19T13:00:00.000Z",
  contextSnapshot: {
    schemaVersion: V,
    snapshotRef: payloadRef,
    digest,
    byteLength: 4_096,
  },
  branch: {
    schemaVersion: V,
    branch: "agent/m-mailbox-contracts",
    headCommit: "339c6940f",
    delivery: "pushed",
  },
  artifacts,
} as const;

const routingEnvelope = {
  schemaVersion: V,
  envelopeId,
  kind: "delegation",
  sourceWorkspaceId: "ctox-business-os:mesh-alpha",
  sourceEnvironmentId: "environment-a",
  targetWorkspaceId: "ctox-business-os:mesh-alpha",
  targetEnvironmentId: "environment-b",
  createdAt: "2026-08-18T10:00:00.000Z",
  expiresAt: "2026-08-18T11:00:00.000Z",
  signature: "c2lnbmF0dXJlLXZhbHVlLTAx",
} as const;

const roundTrip = (schema: Schema.Codec<unknown, unknown>, encoded: unknown): void => {
  const decoded = Schema.decodeUnknownSync(schema)(encoded);
  expect(Schema.encodeUnknownSync(schema)(decoded)).toEqual(encoded);
};

describe("WorkjetWorkerAddress", () => {
  it("round-trips a globally routable address", () => {
    const decoded = decodeAddress(sourceAddress);
    expect(decoded.environmentId).toBe("environment-a");
    expect(decoded.threadId).toBe("thread-orchestrator");
    roundTrip(WorkjetWorkerAddress, sourceAddress);
  });

  it("carries no harness or provider identity", () => {
    const keys = Object.keys(decodeAddress(sourceAddress)).sort();
    expect(keys).toEqual(["environmentId", "schemaVersion", "threadId", "workspaceId"]);
  });

  it("rejects an unknown schema version", () => {
    expect(() => decodeAddress({ ...sourceAddress, schemaVersion: 2 })).toThrow();
  });

  it("rejects malformed or oversized workspace identities", () => {
    expect(() => decodeAddress({ ...sourceAddress, workspaceId: "" })).toThrow();
    expect(() => decodeAddress({ ...sourceAddress, workspaceId: "a".repeat(257) })).toThrow();
    expect(() => decodeAddress({ ...sourceAddress, workspaceId: `bad${control}id` })).toThrow();
    expect(() => decodeAddress({ ...sourceAddress, workspaceId: "-leading-dash" })).toThrow();
  });

  it("requires an environment and a thread", () => {
    const { threadId: _thread, ...withoutThread } = sourceAddress;
    expect(() => decodeAddress(withoutThread)).toThrow();
    expect(() => decodeAddress({ ...sourceAddress, environmentId: "" })).toThrow();
  });

  it("keeps the handoff target thread-less", () => {
    const decoded = decodeEnvironmentAddress(handoff.target);
    expect(Object.keys(decoded).sort()).toEqual(["environmentId", "schemaVersion", "workspaceId"]);
    roundTrip(WorkjetEnvironmentAddress, handoff.target);
  });
});

describe("WorkjetMailboxTimestamp", () => {
  it("accepts ISO-8601 instants with and without fractional seconds", () => {
    expect(decodeTimestamp("2026-08-18T10:00:00Z")).toBe("2026-08-18T10:00:00Z");
    expect(decodeTimestamp("2026-08-18T10:00:00.123456Z")).toBe("2026-08-18T10:00:00.123456Z");
    expect(decodeTimestamp("2026-08-18T10:00:00+02:00")).toBe("2026-08-18T10:00:00+02:00");
  });

  it("rejects non-ISO and oversized values", () => {
    expect(() => decodeTimestamp("yesterday")).toThrow();
    expect(() => decodeTimestamp("2026-08-18")).toThrow();
    expect(() => decodeTimestamp(`2026-08-18T10:00:00Z${"0".repeat(64)}`)).toThrow();
  });
});

describe("WorkjetWorkerMessage", () => {
  it("round-trips a sealed message", () => {
    roundTrip(WorkjetWorkerMessage, message);
  });

  it("round-trips an inline same-environment message and a reply link", () => {
    const inline = {
      ...message,
      body: { _tag: "inline", text: "Status ping." },
      inReplyTo: otherEnvelopeId,
    } as const;
    expect(decodeMessage(inline).body).toEqual({ _tag: "inline", text: "Status ping." });
    roundTrip(WorkjetWorkerMessage, inline);
  });

  it("requires a stable, collision-resistant envelope id", () => {
    expect(() => decodeMessage({ ...message, envelopeId: "short" })).toThrow();
    expect(() => decodeMessage({ ...message, envelopeId: "a".repeat(129) })).toThrow();
    expect(() => decodeMessage({ ...message, envelopeId: `env-${control}0123456789` })).toThrow();
  });

  it("requires an expiry timestamp", () => {
    const { expiresAt: _expiresAt, ...withoutExpiry } = message;
    expect(() => decodeMessage(withoutExpiry)).toThrow();
  });

  it("rejects unbounded or non-base64url payload references", () => {
    expect(() =>
      decodeMessage({
        ...message,
        body: { _tag: "sealed", payloadRef: "a".repeat(513), byteLength: 1 },
      }),
    ).toThrow();
    expect(() =>
      decodeMessage({
        ...message,
        body: { _tag: "sealed", payloadRef: "not base64url!!!!!!!", byteLength: 1 },
      }),
    ).toThrow();
    expect(() =>
      decodeMessage({ ...message, body: { _tag: "sealed", payloadRef, byteLength: 8_388_609 } }),
    ).toThrow();
  });

  it("rejects oversized inline text", () => {
    expect(() =>
      decodeMessage({ ...message, body: { _tag: "inline", text: "a".repeat(4_097) } }),
    ).toThrow();
    expect(() =>
      decodeMessage({ ...message, body: { _tag: "inline", text: `bad${control}text` } }),
    ).toThrow();
  });
});

describe("WorkjetDelegationState", () => {
  it("accepts exactly the planned literals", () => {
    const states = [
      "queued",
      "delivered",
      "accepted",
      "running",
      "needs-input",
      "review-requested",
      "changes-requested",
      "completed",
      "failed",
      "cancelled",
      "expired",
    ] as const;
    for (const state of states) {
      expect(decodeState(state)).toBe(state);
    }
    expect(() => decodeState("pending")).toThrow();
    expect(() => decodeState("done")).toThrow();
    expect(() => decodeState("needs_input")).toThrow();
  });

  it("names the terminal states", () => {
    expect([...WORKJET_TERMINAL_DELEGATION_STATES]).toEqual([
      "completed",
      "failed",
      "cancelled",
      "expired",
    ]);
  });
});

describe("WorkjetDelegation", () => {
  it("round-trips a queued delegation", () => {
    const decoded = decodeDelegation(delegation);
    expect(decoded.state).toBe("queued");
    expect(decoded.scope.files).toHaveLength(1);
    roundTrip(WorkjetDelegation, delegation);
  });

  it("round-trips a delegation with a parent edge reference", () => {
    const child = { ...delegation, depth: 1, parent: delegationRef } as const;
    expect(decodeDelegation(child).parent?.delegationId).toBe(delegationId);
    roundTrip(WorkjetDelegation, child);
  });

  it("requires an explicit non-empty file scope", () => {
    expect(() =>
      decodeDelegation({ ...delegation, scope: { ...delegation.scope, files: [] } }),
    ).toThrow();
    const { scope: _scope, ...withoutScope } = delegation;
    expect(() => decodeDelegation(withoutScope)).toThrow();
  });

  it("rejects absolute paths and parent traversal in scope", () => {
    for (const path of ["/etc/passwd", "../outside.ts", "packages/../../escape.ts"]) {
      expect(() =>
        decodeDelegation({ ...delegation, scope: { ...delegation.scope, files: [path] } }),
      ).toThrow();
    }
  });

  it("bounds the scope list and the prose fields", () => {
    expect(() =>
      decodeDelegation({
        ...delegation,
        scope: { ...delegation.scope, files: Array.from({ length: 257 }, (_v, i) => `a/${i}.ts`) },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegation({
        ...delegation,
        scope: { ...delegation.scope, nonGoals: "a".repeat(4_097) },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegation({
        ...delegation,
        completion: { ...delegation.completion, acceptance: "a".repeat(8_193) },
      }),
    ).toThrow();
  });

  it("bounds the loop-prevention budget", () => {
    expect(() =>
      decodeDelegation({ ...delegation, budget: { ...delegation.budget, maxDepth: 0 } }),
    ).toThrow();
    expect(() =>
      decodeDelegation({ ...delegation, budget: { ...delegation.budget, maxDepth: 17 } }),
    ).toThrow();
    expect(() =>
      decodeDelegation({ ...delegation, budget: { ...delegation.budget, maxReviewRounds: -1 } }),
    ).toThrow();
    expect(() => decodeDelegation({ ...delegation, depth: 17 })).toThrow();
    expect(() => decodeDelegation({ ...delegation, depth: -1 })).toThrow();
  });

  it("requires an immutable, digest-pinned prompt snapshot reference", () => {
    expect(() =>
      decodeDelegation({ ...delegation, prompt: { ...delegation.prompt, digest: "abc" } }),
    ).toThrow();
    expect(() =>
      decodeDelegation({ ...delegation, prompt: { ...delegation.prompt, digest: "A".repeat(64) } }),
    ).toThrow();
  });
});

describe("WorkjetDeliveryReceipt", () => {
  it("round-trips every disposition", () => {
    for (const disposition of ["accepted-new", "duplicate-ignored", "expired"] as const) {
      const receipt = {
        schemaVersion: V,
        envelopeId,
        acknowledgedBy: targetAddress,
        acknowledgedAt: "2026-08-18T10:00:01.000Z",
        disposition,
      } as const;
      expect(decodeReceipt(receipt).disposition).toBe(disposition);
      roundTrip(WorkjetDeliveryReceipt, receipt);
    }
  });

  it("round-trips a rejection with a bounded reason code", () => {
    const rejected = {
      schemaVersion: V,
      envelopeId,
      acknowledgedBy: targetAddress,
      acknowledgedAt: "2026-08-18T10:00:01.000Z",
      disposition: "rejected",
      rejectionReason: "unauthorized",
    } as const;
    roundTrip(WorkjetDeliveryReceipt, rejected);
    expect(() => decodeReceipt({ ...rejected, rejectionReason: "boom: stack trace" })).toThrow();
  });
});

describe("WorkjetDelegationResult", () => {
  it("round-trips a completed result with bounded artifact references", () => {
    const decoded = decodeResult(result);
    expect(decoded.delegation.delegationId).toBe(delegationId);
    expect(decoded.artifacts.commitHashes).toHaveLength(2);
    roundTrip(WorkjetDelegationResult, result);
  });

  it("rejects file contents smuggled through the summary or artifact lists", () => {
    expect(() => decodeResult({ ...result, summary: "a".repeat(8_193) })).toThrow();
    expect(() =>
      decodeArtifacts({ ...artifacts, commitHashes: Array.from({ length: 65 }, () => "abcdef1") }),
    ).toThrow();
    expect(() =>
      decodeArtifacts({
        ...artifacts,
        paths: Array.from({ length: 257 }, (_v, i) => `src/${i}.ts`),
      }),
    ).toThrow();
    expect(() => decodeArtifacts({ ...artifacts, commitHashes: ["NOTAHASH"] })).toThrow();
    expect(() => decodeArtifacts({ ...artifacts, paths: ["/absolute/path.ts"] })).toThrow();
  });

  it("rejects a non-terminal outcome", () => {
    expect(() => decodeResult({ ...result, outcome: "running" })).toThrow();
  });

  it("bounds the git branch reference and its delivery mode", () => {
    expect(() =>
      decodeArtifacts({
        ...artifacts,
        branch: { ...artifacts.branch, delivery: "ssh" },
      }),
    ).toThrow();
    expect(() =>
      decodeArtifacts({ ...artifacts, branch: { ...artifacts.branch, branch: "a".repeat(256) } }),
    ).toThrow();
  });
});

describe("WorkjetReviewVerdict", () => {
  it("round-trips both decisions", () => {
    roundTrip(WorkjetReviewVerdict, verdict);
    roundTrip(WorkjetReviewVerdict, { ...verdict, decision: "approve", reasons: [] });
  });

  it("rejects unknown decisions and unbounded reasons", () => {
    expect(() => decodeVerdict({ ...verdict, decision: "reject" })).toThrow();
    expect(() =>
      decodeVerdict({ ...verdict, reasons: Array.from({ length: 33 }, () => "why") }),
    ).toThrow();
    expect(() => decodeVerdict({ ...verdict, reasons: ["a".repeat(1_025)] })).toThrow();
    expect(() => decodeVerdict({ ...verdict, round: 17 })).toThrow();
  });
});

describe("WorkjetDelegationEdge", () => {
  it("round-trips every typed edge kind", () => {
    for (const kind of ["reviews", "revises", "follows-up"] as const) {
      expect(decodeEdge({ ...edge, kind }).kind).toBe(kind);
      roundTrip(WorkjetDelegationEdge, { ...edge, kind });
    }
  });

  it("rejects untyped edges and over-deep graphs", () => {
    expect(() => decodeEdge({ ...edge, kind: "blocks" })).toThrow();
    expect(() => decodeEdge({ ...edge, depth: 17 })).toThrow();
  });
});

describe("WorkjetThreadHandoff", () => {
  it("round-trips a snapshot handoff", () => {
    const decoded = decodeHandoff(handoff);
    expect(decoded.sourceThread.threadId).toBe("thread-orchestrator");
    expect(decoded.branch.delivery).toBe("pushed");
    roundTrip(WorkjetThreadHandoff, handoff);
    roundTrip(WorkjetThreadHandoff, { ...handoff, note: "Continue with any harness." });
  });

  it("carries no harness or provider selection for the target", () => {
    const keys = Object.keys(decodeHandoff(handoff));
    expect(keys).not.toContain("harness");
    expect(keys).not.toContain("provider");
    expect(keys).not.toContain("modelId");
  });

  it("requires a durable source-thread link, a snapshot, and a branch", () => {
    for (const key of ["sourceThread", "contextSnapshot", "branch"] as const) {
      const { [key]: _removed, ...partial } = handoff;
      expect(() => decodeHandoff(partial)).toThrow();
    }
  });

  it("drops any thread id offered for the handoff target", () => {
    const decoded = decodeEnvironmentAddress({ ...handoff.target, threadId: "thread-target" });
    expect(decoded).not.toHaveProperty("threadId");
  });
});

describe("WorkjetRoutingEnvelope", () => {
  it("round-trips relay-visible metadata only", () => {
    const decoded = decodeRoutingEnvelope(routingEnvelope);
    expect(Object.keys(decoded).sort()).toEqual([
      "createdAt",
      "envelopeId",
      "expiresAt",
      "kind",
      "schemaVersion",
      "signature",
      "sourceEnvironmentId",
      "sourceWorkspaceId",
      "targetEnvironmentId",
      "targetWorkspaceId",
    ]);
    roundTrip(WorkjetRoutingEnvelope, routingEnvelope);
  });

  it("exposes no payload, prompt, or artifact field", () => {
    const keys = Object.keys(decodeRoutingEnvelope(routingEnvelope));
    for (const forbidden of ["body", "payload", "payloadRef", "prompt", "artifacts", "summary"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("requires a bounded signature and expiry", () => {
    expect(() => decodeRoutingEnvelope({ ...routingEnvelope, signature: "short" })).toThrow();
    expect(() =>
      decodeRoutingEnvelope({ ...routingEnvelope, signature: "a".repeat(513) }),
    ).toThrow();
    const { expiresAt: _expiresAt, ...withoutExpiry } = routingEnvelope;
    expect(() => decodeRoutingEnvelope(withoutExpiry)).toThrow();
  });

  it("rejects unknown payload kinds", () => {
    expect(() => decodeRoutingEnvelope({ ...routingEnvelope, kind: "telemetry" })).toThrow();
  });
});

describe("WorkjetMailboxPayload", () => {
  it("round-trips every tagged payload variant", () => {
    const payloads = [
      { _tag: "message", message },
      { _tag: "delegation", delegation },
      {
        _tag: "receipt",
        receipt: {
          schemaVersion: V,
          envelopeId,
          acknowledgedBy: targetAddress,
          acknowledgedAt: "2026-08-18T10:00:01.000Z",
          disposition: "accepted-new",
        },
      },
      { _tag: "result", result },
      { _tag: "review", verdict },
      { _tag: "handoff", handoff },
    ] as const;
    for (const payload of payloads) {
      expect(decodePayload(payload)._tag).toBe(payload._tag);
      roundTrip(WorkjetMailboxPayload, payload);
    }
  });

  it("rejects an unknown payload tag", () => {
    expect(() => decodePayload({ _tag: "prompt", message })).toThrow();
  });
});

describe("WorkjetMailboxError", () => {
  it("carries only a bounded reason and a fixed message", () => {
    const error = new WorkjetMailboxError({ reason: "target-offline" });
    expect(error._tag).toBe("WorkjetMailboxError");
    expect(error.reason).toBe("target-offline");
    expect(error.message).toBe("The mailbox target is offline.");
    expect(Object.keys(Schema.encodeSync(WorkjetMailboxError)(error)).sort()).toEqual([
      "_tag",
      "reason",
    ]);
  });

  it("gives every reason a distinct sanitized message", () => {
    const reasons = [
      "unauthorized",
      "unknown-target",
      "target-thread-deleted",
      "target-offline",
      "malformed-envelope",
      "duplicate-envelope",
      "payload-too-large",
      "envelope-expired",
      "delegation-expired",
      "depth-exceeded",
      "review-rounds-exceeded",
      "invalid-state-transition",
      "version-skew",
      "transport-unavailable",
      "mailbox-unavailable",
      "cancelled",
    ] as const;
    const messages = reasons.map((reason) => new WorkjetMailboxError({ reason }).message);
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message_ of messages) {
      expect(message_.length).toBeLessThanOrEqual(120);
    }
  });

  it("rejects an unknown reason", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkjetMailboxError)({
        _tag: "WorkjetMailboxError",
        reason: "kaboom",
      }),
    ).toThrow();
  });
});
