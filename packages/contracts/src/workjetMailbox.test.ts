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
  WORKJET_MAILBOX_ACTIVITY_KINDS,
  WORKJET_MAILBOX_RPC_MAX_TTL_SECONDS,
  WORKJET_MAILBOX_RPC_MIN_TTL_SECONDS,
  WORKJET_MAILBOX_RPC_PROMPT_MAX_LENGTH,
  WorkjetMailboxActivityPayload,
  WorkjetMailboxDelegateTaskRpcInput,
  WorkjetMailboxDelegateTaskRpcResult,
  WorkjetMailboxError,
  WorkjetMailboxPayload,
  WorkjetMailboxReplyRpcInput,
  WorkjetMailboxReplyRpcResult,
  WorkjetMailboxReassignDelegationRpcInput,
  WorkjetMailboxReassignDelegationRpcResult,
  WorkjetMailboxRequestReviewRpcInput,
  WorkjetMailboxRequestReviewRpcResult,
  WorkjetMailboxSendMessageRpcInput,
  WorkjetMailboxSendMessageRpcResult,
  WorkjetMailboxTimestamp,
  WorkjetMailboxUpdateDelegationRpcInput,
  WorkjetMailboxUpdateDelegationRpcResult,
  WORKJET_MESH_OVERVIEW_MAX_PEERS,
  WORKJET_MESH_ROSTER_MAX_PEERS,
  WorkjetMeshOverview,
  WorkjetMeshRoster,
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

  it("round-trips a budget with the additive token/cost/approval fields absent", () => {
    // Absent optional fields are the existing-delegation shape: they must
    // survive a decode/encode round trip unchanged (no injected defaults).
    const keys = Object.keys(decodeDelegation(delegation).budget).sort();
    expect(keys).toEqual(["expiresAt", "maxDepth", "maxReviewRounds", "schemaVersion"]);
    roundTrip(WorkjetDelegation, delegation);
  });

  it("round-trips a budget carrying token/cost ceilings and an approval gate", () => {
    const gated = {
      ...delegation,
      budget: {
        ...delegation.budget,
        maxTokens: 250_000,
        maxCostMicros: 5_000_000,
        requiresApproval: true,
      },
    } as const;
    const decoded = decodeDelegation(gated);
    expect(decoded.budget.maxTokens).toBe(250_000);
    expect(decoded.budget.maxCostMicros).toBe(5_000_000);
    expect(decoded.budget.requiresApproval).toBe(true);
    roundTrip(WorkjetDelegation, gated);
  });

  it("bounds the additive token and cost ceilings", () => {
    expect(() =>
      decodeDelegation({ ...delegation, budget: { ...delegation.budget, maxTokens: 0 } }),
    ).toThrow();
    expect(() =>
      decodeDelegation({
        ...delegation,
        budget: { ...delegation.budget, maxTokens: 100_000_001 },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegation({ ...delegation, budget: { ...delegation.budget, maxCostMicros: 0 } }),
    ).toThrow();
    expect(() =>
      decodeDelegation({
        ...delegation,
        budget: { ...delegation.budget, maxCostMicros: 1_000_000_000_000_001 },
      }),
    ).toThrow();
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

  it("carries optional cross-machine snapshot bytes on a delegation payload", () => {
    const withBytes = {
      _tag: "delegation",
      delegation,
      snapshotBytes: "Implement the transfer.\nBounded, sealed, verified.",
    } as const;
    const decoded = decodePayload(withBytes);
    expect(decoded._tag).toBe("delegation");
    if (decoded._tag === "delegation") {
      expect(decoded.snapshotBytes).toBe(withBytes.snapshotBytes);
      expect(decoded.snapshotOversized).toBeUndefined();
    }
    roundTrip(WorkjetMailboxPayload, withBytes);

    // A reference-only delegation (same-env fast path) omits both fields.
    const refOnly = decodePayload({ _tag: "delegation", delegation });
    if (refOnly._tag === "delegation") {
      expect(refOnly.snapshotBytes).toBeUndefined();
      expect(refOnly.snapshotOversized).toBeUndefined();
    }

    // The oversized marker travels reference-only.
    const oversized = { _tag: "delegation", delegation, snapshotOversized: true } as const;
    const decodedOversized = decodePayload(oversized);
    if (decodedOversized._tag === "delegation") {
      expect(decodedOversized.snapshotOversized).toBe(true);
      expect(decodedOversized.snapshotBytes).toBeUndefined();
    }
    roundTrip(WorkjetMailboxPayload, oversized);
  });

  it("rejects snapshot bytes over the transfer ceiling and a non-true marker", () => {
    expect(() =>
      decodePayload({
        _tag: "delegation",
        delegation,
        snapshotBytes: "x".repeat(262_145),
      }),
    ).toThrow();
    expect(() =>
      decodePayload({ _tag: "delegation", delegation, snapshotOversized: false }),
    ).toThrow();
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
      "invalid-signature",
      "duplicate-envelope",
      "payload-too-large",
      "envelope-expired",
      "delegation-expired",
      "depth-exceeded",
      "review-rounds-exceeded",
      "token-budget-exceeded",
      "cost-budget-exceeded",
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

describe("Workjet mailbox RPC contracts", () => {
  const decodeSendInput = Schema.decodeUnknownSync(WorkjetMailboxSendMessageRpcInput);
  const encodeSendInput = Schema.encodeSync(WorkjetMailboxSendMessageRpcInput);
  const decodeDelegateInput = Schema.decodeUnknownSync(WorkjetMailboxDelegateTaskRpcInput);
  const encodeDelegateInput = Schema.encodeSync(WorkjetMailboxDelegateTaskRpcInput);
  const decodeSendResult = Schema.decodeUnknownSync(WorkjetMailboxSendMessageRpcResult);
  const decodeDelegateResult = Schema.decodeUnknownSync(WorkjetMailboxDelegateTaskRpcResult);
  const decodeActivityPayload = Schema.decodeUnknownSync(WorkjetMailboxActivityPayload);

  const sendInput = {
    sourceThreadId: "thread-orchestrator",
    targetEnvironmentId: "environment-a",
    targetThreadId: "thread-worker",
    body: { _tag: "inline", text: "Please look at the failing test." },
  } as const;

  const delegateInput = {
    sourceThreadId: "thread-orchestrator",
    targetEnvironmentId: "environment-a",
    targetThreadId: "thread-worker",
    prompt: "Fix the flaky test in the mailbox store.",
    scope: {
      files: ["apps/server/src/workjet/mailbox/WorkjetMailboxStore.ts"],
      nonGoals: "No API changes.",
    },
    acceptance: "The focused test run is green.",
    budget: { maxDepth: 2, maxReviewRounds: 1, ttlSeconds: 3_600 },
  } as const;

  it("round-trips a minimal same-environment message send", () => {
    const decoded = decodeSendInput(sendInput);
    expect(decoded.targetWorkspaceId).toBeUndefined();
    expect(encodeSendInput(decoded)).toEqual(sendInput);
  });

  it("round-trips a message send that names an explicit mesh workspace and ttl", () => {
    const withWorkspace = {
      ...sendInput,
      targetWorkspaceId: "ctox-business-os:mesh-alpha",
      ttlSeconds: 600,
      inReplyTo: envelopeId,
    } as const;
    expect(encodeSendInput(decodeSendInput(withWorkspace))).toEqual(withWorkspace);
  });

  it("bounds the inline message body and rejects a blank one", () => {
    expect(() =>
      decodeSendInput({ ...sendInput, body: { _tag: "inline", text: "x".repeat(4_097) } }),
    ).toThrow();
    expect(() =>
      decodeSendInput({ ...sendInput, body: { _tag: "inline", text: "   " } }),
    ).toThrow();
  });

  it("rejects a ttl outside the declared bounds", () => {
    expect(() =>
      decodeSendInput({ ...sendInput, ttlSeconds: WORKJET_MAILBOX_RPC_MIN_TTL_SECONDS - 1 }),
    ).toThrow();
    expect(() =>
      decodeSendInput({ ...sendInput, ttlSeconds: WORKJET_MAILBOX_RPC_MAX_TTL_SECONDS + 1 }),
    ).toThrow();
  });

  it("round-trips a delegation input", () => {
    expect(encodeDelegateInput(decodeDelegateInput(delegateInput))).toEqual(delegateInput);
  });

  it("requires at least one scope file and rejects absolute or traversing paths", () => {
    expect(() =>
      decodeDelegateInput({ ...delegateInput, scope: { files: [], nonGoals: "None." } }),
    ).toThrow();
    expect(() =>
      decodeDelegateInput({
        ...delegateInput,
        scope: { files: ["/etc/passwd"], nonGoals: "None." },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegateInput({
        ...delegateInput,
        scope: { files: ["../outside.ts"], nonGoals: "None." },
      }),
    ).toThrow();
  });

  it("bounds the delegation prompt and budget", () => {
    expect(() =>
      decodeDelegateInput({
        ...delegateInput,
        prompt: "x".repeat(WORKJET_MAILBOX_RPC_PROMPT_MAX_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeDelegateInput({ ...delegateInput, budget: { ...delegateInput.budget, maxDepth: 0 } }),
    ).toThrow();
    expect(() =>
      decodeDelegateInput({
        ...delegateInput,
        budget: { ...delegateInput.budget, maxReviewRounds: 17 },
      }),
    ).toThrow();
  });

  it("round-trips both delivery outcomes of a message send", () => {
    const queued = { schemaVersion: V, status: "queued", envelopeId } as const;
    expect(decodeSendResult(queued)).toEqual(queued);
    const acknowledged = {
      schemaVersion: V,
      status: "acknowledged",
      envelopeId,
      disposition: "duplicate-ignored",
      acknowledgedAt: "2026-08-18T10:00:00.000Z",
    } as const;
    expect(decodeSendResult(acknowledged)).toEqual(acknowledged);
  });

  it("round-trips a delegation result carrying the delegation reference and state", () => {
    const result = {
      schemaVersion: V,
      status: "acknowledged",
      envelopeId,
      delegationId,
      ownerEnvironmentId: "environment-a",
      ownerThreadId: "thread-worker",
      state: "delivered",
      disposition: "accepted-new",
      acknowledgedAt: "2026-08-18T10:00:00.000Z",
    } as const;
    expect(decodeDelegateResult(result)).toEqual(result);
  });

  it("decodes the redacted activity payload the timeline renders", () => {
    const payload = {
      schemaVersion: V,
      envelopeId,
      direction: "outbound",
      source: {
        workspaceId: "ctox-business-os:mesh-alpha",
        environmentId: "environment-a",
        threadId: "thread-orchestrator",
      },
      target: {
        workspaceId: "ctox-business-os:mesh-alpha",
        environmentId: "environment-a",
        threadId: "thread-worker",
      },
      delegationId,
      delegationState: "running",
      disposition: "accepted-new",
      createdAt: "2026-08-18T10:00:00.000Z",
      expiresAt: "2026-08-18T11:00:00.000Z",
    } as const;
    expect(decodeActivityPayload(payload)).toEqual(payload);
    expect(WORKJET_MAILBOX_ACTIVITY_KINDS).toEqual([
      "workjet.message.sent",
      "workjet.message.received",
      "workjet.delegation.sent",
      "workjet.delegation.received",
    ]);
  });

  const decodeReplyInput = Schema.decodeUnknownSync(WorkjetMailboxReplyRpcInput);
  const encodeReplyInput = Schema.encodeSync(WorkjetMailboxReplyRpcInput);
  const decodeReplyResult = Schema.decodeUnknownSync(WorkjetMailboxReplyRpcResult);
  const decodeReviewInput = Schema.decodeUnknownSync(WorkjetMailboxRequestReviewRpcInput);
  const encodeReviewInput = Schema.encodeSync(WorkjetMailboxRequestReviewRpcInput);
  const decodeReviewResult = Schema.decodeUnknownSync(WorkjetMailboxRequestReviewRpcResult);
  const decodeUpdateInput = Schema.decodeUnknownSync(WorkjetMailboxUpdateDelegationRpcInput);
  const encodeUpdateInput = Schema.encodeSync(WorkjetMailboxUpdateDelegationRpcInput);
  const decodeUpdateResult = Schema.decodeUnknownSync(WorkjetMailboxUpdateDelegationRpcResult);
  const decodeReassignInput = Schema.decodeUnknownSync(WorkjetMailboxReassignDelegationRpcInput);
  const encodeReassignInput = Schema.encodeSync(WorkjetMailboxReassignDelegationRpcInput);
  const decodeReassignResult = Schema.decodeUnknownSync(WorkjetMailboxReassignDelegationRpcResult);

  const replyInput = {
    sourceThreadId: "thread-orchestrator",
    targetEnvironmentId: "environment-a",
    targetThreadId: "thread-worker",
    delegationId,
    body: { _tag: "inline", text: "One more thing." },
  } as const;

  const reviewInput = {
    sourceThreadId: "thread-orchestrator",
    targetEnvironmentId: "environment-a",
    targetThreadId: "thread-reviewer",
    delegationId,
    round: 1,
    body: { _tag: "inline", text: "Please review." },
  } as const;

  it("round-trips a reply input and rejects a blank body", () => {
    expect(encodeReplyInput(decodeReplyInput(replyInput))).toEqual(replyInput);
    expect(() =>
      decodeReplyInput({ ...replyInput, body: { _tag: "inline", text: "  " } }),
    ).toThrow();
  });

  it("round-trips a review-request input and bounds the round", () => {
    expect(encodeReviewInput(decodeReviewInput(reviewInput))).toEqual(reviewInput);
    expect(() => decodeReviewInput({ ...reviewInput, round: 0 })).toThrow();
    expect(() => decodeReviewInput({ ...reviewInput, round: 17 })).toThrow();
  });

  it("round-trips every delegation-update operation and bounds review reasons", () => {
    for (const update of [
      { _tag: "cancel" },
      { _tag: "revise" },
      { _tag: "follow-up" },
      { _tag: "review", decision: "approve", round: 1 },
      { _tag: "review", decision: "changes-requested", round: 2, reasons: ["needs a test"] },
    ] as const) {
      const input = { sourceThreadId: "thread-orchestrator", delegationId, update } as const;
      expect(encodeUpdateInput(decodeUpdateInput(input))).toEqual(input);
    }
    // A review reason list is bounded (32 entries) and each reason is nonblank.
    expect(() =>
      decodeUpdateInput({
        sourceThreadId: "thread-orchestrator",
        delegationId,
        update: {
          _tag: "review",
          decision: "changes-requested",
          round: 1,
          reasons: new Array(33).fill("x"),
        },
      }),
    ).toThrow();
  });

  it("round-trips the reply, review, and update results", () => {
    const reply = { schemaVersion: V, status: "queued", envelopeId } as const;
    expect(decodeReplyResult(reply)).toEqual(reply);
    const review = {
      schemaVersion: V,
      status: "acknowledged",
      envelopeId,
      delegationId,
      state: "review-requested",
      edgeKind: "reviews",
      disposition: "accepted-new",
      acknowledgedAt: "2026-08-18T10:00:00.000Z",
    } as const;
    expect(decodeReviewResult(review)).toEqual(review);
    const update = {
      schemaVersion: V,
      delegationId,
      state: "completed",
      edgeKind: "reviews",
    } as const;
    expect(decodeUpdateResult(update)).toEqual(update);
    const cancel = { schemaVersion: V, delegationId, state: "cancelled" } as const;
    expect(decodeUpdateResult(cancel)).toEqual(cancel);
  });

  it("round-trips a reassignment input, with and without an explicit workspace", () => {
    const reassign = {
      sourceThreadId: "thread-orchestrator",
      targetEnvironmentId: "environment-a",
      targetThreadId: "thread-second-worker",
      delegationId,
    } as const;
    expect(encodeReassignInput(decodeReassignInput(reassign))).toEqual(reassign);
    const qualified = { ...reassign, targetWorkspaceId: "ctox-business-os:mesh-alpha" } as const;
    expect(encodeReassignInput(decodeReassignInput(qualified))).toEqual(qualified);
    // The target address is required: a reassignment without one is not a move.
    expect(() =>
      decodeReassignInput({ sourceThreadId: "thread-orchestrator", delegationId }),
    ).toThrow();
  });

  it("round-trips the reassignment result with its unchanged state", () => {
    const result = {
      schemaVersion: V,
      delegationId,
      state: "needs-input",
      targetEnvironmentId: "environment-a",
      targetThreadId: "thread-second-worker",
    } as const;
    expect(decodeReassignResult(result)).toEqual(result);
  });
});

describe("WorkjetMeshRoster", () => {
  const decodeRoster = Schema.decodeUnknownSync(WorkjetMeshRoster);
  const peer = (environmentId: string, binding = "self-signed") => ({
    schemaVersion: WORKJET_MAILBOX_SCHEMA_VERSION,
    workspaceId: "workjet-mesh-peer",
    environmentId,
    firstSeenAt: "2026-08-18T10:00:00.000Z",
    sealedDeliveryReady: true,
    binding,
  });
  const roster = (peers: ReadonlyArray<ReturnType<typeof peer>>) => ({
    schemaVersion: WORKJET_MAILBOX_SCHEMA_VERSION,
    local: {
      schemaVersion: WORKJET_MAILBOX_SCHEMA_VERSION,
      workspaceId: "workjet-mesh-local",
      environmentId: "environment-local",
    },
    peers,
    truncated: false,
  });

  it("round-trips a roster with a local entry and a pinned peer", () => {
    const value = roster([peer("environment-peer")]);
    expect(decodeRoster(value)).toEqual(value);
  });

  it("accepts the honest empty roster of a machine with no peers", () => {
    const value = roster([]);
    expect(decodeRoster(value)).toEqual(value);
  });

  it("rejects a peer list past the picker bound", () => {
    const tooMany = Array.from({ length: WORKJET_MESH_ROSTER_MAX_PEERS + 1 }, (_unused, index) =>
      peer(`environment-${index}`),
    );
    expect(() => decodeRoster(roster(tooMany))).toThrow();
  });

  it("carries both honest trust levels and refuses an invented one", () => {
    for (const binding of ["tofu", "self-signed"]) {
      const value = roster([peer("environment-peer", binding)]);
      expect(decodeRoster(value)).toEqual(value);
    }
    // A level the mesh cannot actually establish must not be expressible: the
    // whole point of the field is that the UI can trust what it says.
    expect(() => decodeRoster(roster([peer("environment-peer", "room-bound")]))).toThrow();
    expect(() => decodeRoster(roster([peer("environment-peer", "verified")]))).toThrow();
  });

  it("requires a peer to state its trust level rather than defaulting to one", () => {
    const { binding: _omitted, ...withoutBinding } = peer("environment-peer");
    expect(() => decodeRoster(roster([withoutBinding as never]))).toThrow();
  });

  it("rejects an unparseable first-contact timestamp", () => {
    expect(() =>
      decodeRoster(roster([{ ...peer("environment-peer"), firstSeenAt: "yesterday" }])),
    ).toThrow();
  });
});

describe("WorkjetMeshOverview", () => {
  const decodeOverview = Schema.decodeUnknownSync(WorkjetMeshOverview);
  const overviewPeer = (environmentId: string, extra: Record<string, unknown> = {}) => ({
    schemaVersion: WORKJET_MAILBOX_SCHEMA_VERSION,
    workspaceId: "workjet-mesh-peer",
    environmentId,
    firstSeenAt: "2026-08-18T10:00:00.000Z",
    sealedDeliveryReady: true,
    binding: "self-signed",
    delegationsSent: [],
    delegationsReceived: [],
    ...extra,
  });
  const overview = (peers: ReadonlyArray<ReturnType<typeof overviewPeer>>) => ({
    schemaVersion: WORKJET_MAILBOX_SCHEMA_VERSION,
    local: {
      schemaVersion: WORKJET_MAILBOX_SCHEMA_VERSION,
      workspaceId: "workjet-mesh-local",
      environmentId: "environment-local",
    },
    peers,
    truncated: false,
    observedAt: "2026-08-19T09:00:00.000Z",
  });

  it("round-trips a peer with contact timestamps and delegation buckets", () => {
    const value = overview([
      overviewPeer("environment-peer", {
        lastInboundAt: "2026-08-19T08:30:00.000Z",
        lastOutboundAt: "2026-08-19T08:00:00.000Z",
        delegationsSent: [{ state: "running", count: 2 }],
        delegationsReceived: [{ state: "completed", count: 5 }],
      }),
    ]);
    expect(decodeOverview(value)).toEqual(value);
  });

  it("accepts a pinned peer with NO contact on record", () => {
    // The expiry sweep removes envelope rows; a pin without rows is honest, and
    // the two timestamp keys must simply be absent rather than zeroed.
    const value = overview([overviewPeer("environment-peer")]);
    const decoded = decodeOverview(value);
    expect(decoded).toEqual(value);
    expect("lastInboundAt" in decoded.peers[0]!).toBe(false);
    expect("lastOutboundAt" in decoded.peers[0]!).toBe(false);
  });

  it("accepts the honest empty overview of a machine with no peers", () => {
    expect(decodeOverview(overview([]))).toEqual(overview([]));
  });

  it("strips a fabricated liveness field instead of carrying it", () => {
    // The contract-level half of the no-liveness guarantee: even if a server or
    // a fixture invents an `online` flag, decoding drops it, so no renderer can
    // reach a liveness claim through this schema.
    const value = overview([overviewPeer("environment-peer", { online: true })]);
    const decoded = decodeOverview(value);
    expect("online" in decoded.peers[0]!).toBe(false);
    expect(JSON.stringify(decoded)).not.toContain("online");
  });

  it("refuses a negative delegation count", () => {
    const value = overview([
      overviewPeer("environment-peer", { delegationsSent: [{ state: "running", count: -1 }] }),
    ]);
    expect(() => decodeOverview(value)).toThrow();
  });

  it("refuses a delegation state the lifecycle does not have", () => {
    const value = overview([
      overviewPeer("environment-peer", { delegationsSent: [{ state: "sleeping", count: 1 }] }),
    ]);
    expect(() => decodeOverview(value)).toThrow();
  });

  it("rejects a peer list past the overview bound", () => {
    const tooMany = Array.from({ length: WORKJET_MESH_OVERVIEW_MAX_PEERS + 1 }, (_unused, index) =>
      overviewPeer(`environment-${index}`),
    );
    expect(() => decodeOverview(overview(tooMany))).toThrow();
  });

  it("requires the server observation instant, so ages are never client-relative", () => {
    const { observedAt: _omitted, ...withoutObservedAt } = overview([]);
    expect(() => decodeOverview(withoutObservedAt as never)).toThrow();
  });
});
