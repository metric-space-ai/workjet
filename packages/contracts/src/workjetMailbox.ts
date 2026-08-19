// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Versioned wire contracts for the distributed Workjet worker mailbox, the
 * delegation graph, and typed thread handoff.
 *
 * These types encode the constraints written down in
 * `docs/workjet-plan.md` → "Distributed worker mailbox and delegation graph",
 * including the owner decisions of 2026-08-18:
 *
 * - The CTOX Sync WebRTC data plane is the PRIMARY and ONLY planned transport
 *   between the user's machines. There is no separate relay service, so nothing
 *   here may model relay-side accounts, endpoints, or credentials.
 * - Mesh membership is CTOX room pairing (room + room password + signaling
 *   URLs) plus the engine's capability/session layer and device-scoped
 *   revocation. T3 Connect account/DPoP identities are explicitly NOT reused,
 *   so the mesh workspace identity here is a bounded opaque id, never an
 *   account, user, or device credential.
 * - History/worktree portability uses the HANDOFF-SNAPSHOT model: an immutable
 *   prompt/context snapshot, bounded artifact references, a pushed or
 *   sync-bundled Git branch, and a durable link to the source thread. Event
 *   export and event replication were considered and rejected.
 *
 * Two invariants apply to every schema in this module:
 *
 * 1. "The relay may inspect only the minimum routing and expiry metadata."
 *    Payloads therefore travel as opaque, end-to-end-encrypted bounded
 *    base64url references; only {@link WorkjetRoutingEnvelope} is designed to
 *    be readable by a forwarding peer.
 * 2. "Guarantee at-least-once transport with stable envelope IDs, idempotent
 *    inbox insertion […] and expiry." Every envelope therefore carries a
 *    stable {@link WorkjetEnvelopeId} and an explicit expiry timestamp, and
 *    every string and array is bounded so a hostile or buggy peer cannot push
 *    unbounded data into a durable mailbox.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Current schema version of every contract in this module. */
export const WORKJET_MAILBOX_SCHEMA_VERSION = 1;

const MailboxSchemaVersion = Schema.Literal(WORKJET_MAILBOX_SCHEMA_VERSION);

const NoAsciiControlCharacters = Schema.makeFilter((input: string) => {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return "Value must not contain ASCII control characters.";
    }
  }
  return true;
});

/**
 * Prose fields (non-goals, acceptance text, summaries, reasons) are allowed to
 * contain tab and newline but nothing else from the C0/C1 control range.
 */
const NoUnsafeControlCharacters = Schema.makeFilter((input: string) => {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0d) {
      continue;
    }
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return "Value must not contain ASCII control characters.";
    }
  }
  return true;
});

/** Bounded multi-line human text. */
const boundedText = (maximum: number) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(maximum), NoUnsafeControlCharacters);

/**
 * ISO-8601 timestamp. Reuses the repository's `IsoDateTime` convention and
 * additionally bounds it, because mailbox envelopes are accepted from remote
 * machines and persisted durably.
 */
export const WorkjetMailboxTimestamp = IsoDateTime.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/),
);
export type WorkjetMailboxTimestamp = typeof WorkjetMailboxTimestamp.Type;

/**
 * Opaque mesh/workspace authority identity.
 *
 * Per the 2026-08-18 owner decision, joining the Workjet mesh is joining a
 * CTOX-style room; this id is the bounded, opaque handle for that membership
 * scope. It deliberately carries no account, user, device, room password, or
 * signaling URL — the room secret and capability tokens never appear on an
 * envelope. Its shape mirrors the CTOX pairing instance/room identity charset.
 */
export const WorkjetMeshWorkspaceId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
).pipe(Schema.brand("WorkjetMeshWorkspaceId"));
export type WorkjetMeshWorkspaceId = typeof WorkjetMeshWorkspaceId.Type;

/**
 * Globally routable worker address: workspace/mesh authority + `environmentId`
 * + `threadId`.
 *
 * The plan is explicit that harness and provider ids stay out of the address
 * "so a thread can change model without breaking the route". Adding a harness,
 * model, provider, or gateway field here is a contract violation.
 */
export const WorkjetWorkerAddress = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  workspaceId: WorkjetMeshWorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type WorkjetWorkerAddress = typeof WorkjetWorkerAddress.Type;

/**
 * Address of a machine/environment without a thread. Used as a handoff target,
 * because the target machine creates a NEW thread from the handoff.
 */
export const WorkjetEnvironmentAddress = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  workspaceId: WorkjetMeshWorkspaceId,
  environmentId: EnvironmentId,
});
export type WorkjetEnvironmentAddress = typeof WorkjetEnvironmentAddress.Type;

/**
 * Stable, collision-resistant envelope id. It is chosen by the sender, never
 * reassigned in flight, and is the deduplication key for idempotent inbox
 * insertion under at-least-once delivery. A minimum length of 16 keeps
 * accidental collisions out of a durable, cross-machine mailbox.
 */
export const WorkjetEnvelopeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
).pipe(Schema.brand("WorkjetEnvelopeId"));
export type WorkjetEnvelopeId = typeof WorkjetEnvelopeId.Type;

/** Durable identity of a delegation, stable across its whole lifecycle. */
export const WorkjetDelegationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
).pipe(Schema.brand("WorkjetDelegationId"));
export type WorkjetDelegationId = typeof WorkjetDelegationId.Type;

/** Durable identity of a thread handoff. */
export const WorkjetHandoffId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
).pipe(Schema.brand("WorkjetHandoffId"));
export type WorkjetHandoffId = typeof WorkjetHandoffId.Type;

/**
 * Opaque base64url handle for an end-to-end-encrypted payload sealed to the
 * target environment key. A forwarding peer can move it but never read it; the
 * envelope around it carries only routing and expiry metadata.
 */
export const WorkjetSealedPayloadRef = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[A-Za-z0-9_-]{16,512}$/),
).pipe(Schema.brand("WorkjetSealedPayloadRef"));
export type WorkjetSealedPayloadRef = typeof WorkjetSealedPayloadRef.Type;

/** Bounded byte count of a referenced payload or snapshot (8 MiB ceiling). */
export const WorkjetPayloadByteLength = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(8_388_608),
);
export type WorkjetPayloadByteLength = typeof WorkjetPayloadByteLength.Type;

/** Lowercase hex SHA-256 digest pinning an immutable snapshot or payload. */
export const WorkjetContentDigest = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-f0-9]{64}$/),
).pipe(Schema.brand("WorkjetContentDigest"));
export type WorkjetContentDigest = typeof WorkjetContentDigest.Type;

/**
 * Message body.
 *
 * `sealed` is the cross-machine form: the payload is encrypted to the target
 * environment key and only its opaque reference travels. `inline` exists solely
 * for the same-environment local fast path, which "may take a local fast path
 * but must obey the same contracts and state machine as remote delivery" — it
 * is bounded like everything else and must never be produced for a target in a
 * different environment.
 */
export const WorkjetMessageBody = Schema.Union([
  Schema.TaggedStruct("sealed", {
    payloadRef: WorkjetSealedPayloadRef,
    byteLength: WorkjetPayloadByteLength,
  }),
  Schema.TaggedStruct("inline", {
    text: boundedText(4_096),
  }),
]);
export type WorkjetMessageBody = typeof WorkjetMessageBody.Type;

/**
 * A plain informational message. It informs another worker and may require no
 * execution; a delegation is the separate "message + task" contract below.
 */
export const WorkjetWorkerMessage = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  envelopeId: WorkjetEnvelopeId,
  source: WorkjetWorkerAddress,
  target: WorkjetWorkerAddress,
  createdAt: WorkjetMailboxTimestamp,
  /** Past this instant the envelope is dropped and reported as `expired`. */
  expiresAt: WorkjetMailboxTimestamp,
  body: WorkjetMessageBody,
  /** Set when this message is a reply inside an existing delegation thread. */
  inReplyTo: Schema.optionalKey(WorkjetEnvelopeId),
});
export type WorkjetWorkerMessage = typeof WorkjetWorkerMessage.Type;

/**
 * Immutable prompt/context snapshot reference. The plan requires transferring
 * context "by immutable prompt snapshots and bounded references […] instead of
 * copying complete chat histories", so no prompt text appears here.
 */
export const WorkjetPromptSnapshotRef = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  snapshotRef: WorkjetSealedPayloadRef,
  digest: WorkjetContentDigest,
  byteLength: WorkjetPayloadByteLength,
});
export type WorkjetPromptSnapshotRef = typeof WorkjetPromptSnapshotRef.Type;

/**
 * Ceiling on the prompt-snapshot bytes a delegation may CARRY inline for
 * cross-machine transfer (256 KiB).
 *
 * A delegation crossing machines pins its prompt with a {@link
 * WorkjetPromptSnapshotRef}, whose bytes live in the SOURCE machine's snapshot
 * store. So the receiver can actually run the task, the outbound cross-machine
 * delegation may additionally carry those bytes — a single prompt snapshot is a
 * bounded transfer, well under the store's 8 MiB cap. The authoritative wire
 * gate remains the transport's sealed 200 000-byte ceiling, checked against the
 * fully encoded, sealed wrapper; this bound is only a schema sanity ceiling so a
 * hostile document cannot pull unbounded data into memory before that check.
 */
export const WORKJET_DELEGATION_SNAPSHOT_TRANSFER_MAX_BYTES = 262_144;

/**
 * The verbatim prompt-snapshot text a cross-machine delegation carries. Only its
 * length is bounded here: the snapshot is arbitrary UTF-8 prompt material whose
 * integrity is re-established on the receiver by hashing the bytes and matching
 * them against the delegation's declared {@link WorkjetContentDigest}, so no
 * content-shape restriction belongs here (that would falsely reject a valid
 * prompt). The digest, not this schema, is the integrity check.
 */
export const WorkjetDelegationSnapshotBytes = Schema.String.check(
  Schema.isMaxLength(WORKJET_DELEGATION_SNAPSHOT_TRANSFER_MAX_BYTES),
);
export type WorkjetDelegationSnapshotBytes = typeof WorkjetDelegationSnapshotBytes.Type;

/** Repository-relative path. Absolute paths and `..` traversal are rejected. */
export const WorkjetRepositoryPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1_024),
  NoAsciiControlCharacters,
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/),
).pipe(Schema.brand("WorkjetRepositoryPath"));
export type WorkjetRepositoryPath = typeof WorkjetRepositoryPath.Type;

/** Git branch name of a per-worker isolated worktree branch. */
export const WorkjetGitBranchName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/),
).pipe(Schema.brand("WorkjetGitBranchName"));
export type WorkjetGitBranchName = typeof WorkjetGitBranchName.Type;

/** Abbreviated or full lowercase hex commit hash. */
export const WorkjetGitCommitHash = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-f0-9]{7,64}$/),
).pipe(Schema.brand("WorkjetGitCommitHash"));
export type WorkjetGitCommitHash = typeof WorkjetGitCommitHash.Type;

/**
 * How the target machine can obtain the branch. Per the owner decision the
 * branch is either pushed to a shared remote or bundled over the CTOX Sync
 * data plane; there is no third option and no file content ever travels.
 */
export const WorkjetGitBranchDelivery = Schema.Literals(["pushed", "sync-bundled"]);
export type WorkjetGitBranchDelivery = typeof WorkjetGitBranchDelivery.Type;

export const WorkjetGitBranchRef = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  branch: WorkjetGitBranchName,
  headCommit: WorkjetGitCommitHash,
  delivery: WorkjetGitBranchDelivery,
});
export type WorkjetGitBranchRef = typeof WorkjetGitBranchRef.Type;

/**
 * Bounded artifact references only: branch, commit hashes, repository-relative
 * paths. File contents, diffs, provider payloads, and secrets are excluded by
 * construction.
 */
export const WorkjetArtifactReferences = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  branch: Schema.optionalKey(WorkjetGitBranchRef),
  commitHashes: Schema.Array(WorkjetGitCommitHash).check(Schema.isMaxLength(64)),
  paths: Schema.Array(WorkjetRepositoryPath).check(Schema.isMaxLength(256)),
});
export type WorkjetArtifactReferences = typeof WorkjetArtifactReferences.Type;

/**
 * Explicit delegation scope: the bounded file whitelist the target may touch
 * plus bounded non-goals prose. A delegation without explicit scope is not
 * representable.
 */
export const WorkjetDelegationScope = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  files: Schema.Array(WorkjetRepositoryPath).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  nonGoals: boundedText(4_096),
});
export type WorkjetDelegationScope = typeof WorkjetDelegationScope.Type;

/** Bounded acceptance text: what "finished" means for this delegation. */
export const WorkjetCompletionContract = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  acceptance: boundedText(8_192),
});
export type WorkjetCompletionContract = typeof WorkjetCompletionContract.Type;

/**
 * Hard ceiling on a delegation's cumulative token budget. Tokens are a plain
 * non-negative count, so a bound of one hundred million is far above any
 * realistic single-delegation turn total while still refusing an unbounded
 * runaway.
 */
export const WORKJET_DELEGATION_MAX_TOKENS_CEILING = 100_000_000;

/**
 * Hard ceiling on a delegation's cumulative cost budget, expressed in
 * MICRO-CURRENCY: one integer unit is 1e-6 of the accounting currency (e.g.
 * 1_000_000 `maxCostMicros` = 1.00 currency unit). Integer micro-units avoid
 * floating-point drift in accumulation; the currency itself is not fixed by the
 * contract, only the scale. The ceiling of 1e15 micros (one billion currency
 * units) keeps the value inside a safe JS integer while bounding a runaway.
 */
export const WORKJET_DELEGATION_MAX_COST_MICROS_CEILING = 1_000_000_000_000_000;

/**
 * Budget and limits. The plan requires "configurable maximum depth, review
 * rounds, token/cost/time budgets, and approval gates to prevent autonomous
 * infinite loops"; the hard ceilings here make a runaway graph unrepresentable
 * rather than merely discouraged.
 *
 * `maxTokens`, `maxCostMicros`, and `requiresApproval` are ADDITIVE (Wave-5
 * token/cost budgets and the approval gate). All three are optional: an absent
 * `maxTokens`/`maxCostMicros` means that dimension is unlimited, and an absent
 * or `false` `requiresApproval` means the delegation may run without a human
 * gate. Every delegation pinned before these fields existed therefore keeps its
 * exact prior meaning (unlimited tokens/cost, no approval gate).
 */
export const WorkjetDelegationBudget = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  /** Maximum delegation-graph depth below this delegation. */
  maxDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(16)),
  /** Maximum `review` → `changes-requested` cycles before a terminal state. */
  maxReviewRounds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(16),
  ),
  /** Wall-clock expiry of the delegation itself, independent of envelope expiry. */
  expiresAt: WorkjetMailboxTimestamp,
  /**
   * Optional cumulative TOKEN ceiling for the whole delegation. Absent =
   * unlimited. A bounded positive integer: the store refuses any usage
   * accumulation that would cross it, before the durable effect.
   */
  maxTokens: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WORKJET_DELEGATION_MAX_TOKENS_CEILING),
    ),
  ),
  /**
   * Optional cumulative COST ceiling for the whole delegation, in micro-currency
   * (see {@link WORKJET_DELEGATION_MAX_COST_MICROS_CEILING}). Absent = unlimited.
   */
  maxCostMicros: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WORKJET_DELEGATION_MAX_COST_MICROS_CEILING),
    ),
  ),
  /**
   * Optional human-approval gate. Absent or `false` = no gate. When `true`, the
   * delegation is created in `approvalState: "pending"` and the executor MUST
   * NOT transition it to `running` until it is explicitly approved.
   */
  requiresApproval: Schema.optionalKey(Schema.Boolean),
});
export type WorkjetDelegationBudget = typeof WorkjetDelegationBudget.Type;

/**
 * The approval-gate lifecycle of a delegation, orthogonal to its
 * {@link WorkjetDelegationState}. `not-required` is the default for a budget
 * without `requiresApproval`; a gated delegation starts `pending` and a human
 * moves it to `approved` (it may then run) or `rejected` (it is cancelled).
 */
export const WorkjetDelegationApprovalState = Schema.Literals([
  "not-required",
  "pending",
  "approved",
  "rejected",
]);
export type WorkjetDelegationApprovalState = typeof WorkjetDelegationApprovalState.Type;

/**
 * The durable delegation lifecycle, exactly the literals fixed by the plan.
 * `completed | failed | cancelled | expired` are terminal.
 */
export const WorkjetDelegationState = Schema.Literals([
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
]);
export type WorkjetDelegationState = typeof WorkjetDelegationState.Type;

/** Terminal states, exported so servers and UI agree on one definition. */
export const WORKJET_TERMINAL_DELEGATION_STATES = [
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const satisfies ReadonlyArray<WorkjetDelegationState>;

/**
 * Stable reference to a delegation. `owner` is the address whose server is
 * authoritative for the delegation's state — a forwarding peer is never the
 * authority for a thread, provider session, repository, or result.
 */
export const WorkjetDelegationRef = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  delegationId: WorkjetDelegationId,
  owner: WorkjetWorkerAddress,
});
export type WorkjetDelegationRef = typeof WorkjetDelegationRef.Type;

/**
 * A delegation: message + task. It carries a prompt snapshot, explicit scope
 * and completion contract, budget/limits, and owns a durable lifecycle.
 * Sending "message + task" creates a {@link WorkjetWorkerMessage} and a
 * {@link WorkjetDelegation} in one atomic command; the two share nothing but
 * their addresses, so a message can be sent without a task.
 */
export const WorkjetDelegation = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  envelopeId: WorkjetEnvelopeId,
  delegationId: WorkjetDelegationId,
  source: WorkjetWorkerAddress,
  target: WorkjetWorkerAddress,
  createdAt: WorkjetMailboxTimestamp,
  /** Envelope-level expiry used by transport; see budget for task-level expiry. */
  expiresAt: WorkjetMailboxTimestamp,
  prompt: WorkjetPromptSnapshotRef,
  scope: WorkjetDelegationScope,
  completion: WorkjetCompletionContract,
  budget: WorkjetDelegationBudget,
  state: WorkjetDelegationState,
  stateChangedAt: WorkjetMailboxTimestamp,
  /** Current depth in the delegation graph; the root delegation has depth 0. */
  depth: NonNegativeInt.check(Schema.isLessThanOrEqualTo(16)),
  /** Set when this delegation was produced by a `reviews`/`revises`/`follows-up` edge. */
  parent: Schema.optionalKey(WorkjetDelegationRef),
});
export type WorkjetDelegation = typeof WorkjetDelegation.Type;

/**
 * What the receiving inbox did with an envelope. `duplicate-ignored` is the
 * normal, non-error outcome of at-least-once transport: delivery is
 * at-least-once, delegation effects are exactly-once by deduplication.
 */
export const WorkjetDeliveryDisposition = Schema.Literals([
  "accepted-new",
  "duplicate-ignored",
  "expired",
  "rejected",
]);
export type WorkjetDeliveryDisposition = typeof WorkjetDeliveryDisposition.Type;

export const WorkjetDeliveryReceipt = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  envelopeId: WorkjetEnvelopeId,
  acknowledgedBy: WorkjetWorkerAddress,
  acknowledgedAt: WorkjetMailboxTimestamp,
  disposition: WorkjetDeliveryDisposition,
  /** Present only for a rejected envelope; a bounded code, never a server message. */
  rejectionReason: Schema.optionalKey(
    Schema.Literals([
      "unauthorized",
      "unknown-target",
      "target-thread-deleted",
      "malformed-envelope",
      "payload-too-large",
      "version-skew",
    ]),
  ),
});
export type WorkjetDeliveryReceipt = typeof WorkjetDeliveryReceipt.Type;

/** Terminal outcome reported back to the source thread. */
export const WorkjetDelegationOutcome = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type WorkjetDelegationOutcome = typeof WorkjetDelegationOutcome.Type;

/**
 * The result returned to the source thread. It preserves the delegation link so
 * the source worker can ask a follow-up, request review, or send
 * `changes-requested` back without creating an unrelated task chain. Bounded
 * summary plus bounded artifact references only — never file contents.
 */
export const WorkjetDelegationResult = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  envelopeId: WorkjetEnvelopeId,
  delegation: WorkjetDelegationRef,
  reportedBy: WorkjetWorkerAddress,
  reportedAt: WorkjetMailboxTimestamp,
  outcome: WorkjetDelegationOutcome,
  summary: boundedText(8_192),
  artifacts: WorkjetArtifactReferences,
});
export type WorkjetDelegationResult = typeof WorkjetDelegationResult.Type;

export const WorkjetReviewDecision = Schema.Literals(["approve", "changes-requested"]);
export type WorkjetReviewDecision = typeof WorkjetReviewDecision.Type;

/**
 * An independent review verdict on a delegation result. `round` is checked
 * against {@link WorkjetDelegationBudget.maxReviewRounds} so review cycles
 * terminate.
 */
export const WorkjetReviewVerdict = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  envelopeId: WorkjetEnvelopeId,
  delegation: WorkjetDelegationRef,
  reviewer: WorkjetWorkerAddress,
  decidedAt: WorkjetMailboxTimestamp,
  decision: WorkjetReviewDecision,
  round: NonNegativeInt.check(Schema.isLessThanOrEqualTo(16)),
  reasons: Schema.Array(boundedText(1_024)).check(Schema.isMaxLength(32)),
});
export type WorkjetReviewVerdict = typeof WorkjetReviewVerdict.Type;

/**
 * Typed edges of the single delegation graph. `reviews` links a review
 * delegation to the delegation under review, `revises` links a rework
 * delegation to the one it revises, `follows-up` links a continuation.
 */
export const WorkjetDelegationEdgeKind = Schema.Literals(["reviews", "revises", "follows-up"]);
export type WorkjetDelegationEdgeKind = typeof WorkjetDelegationEdgeKind.Type;

export const WorkjetDelegationEdge = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  kind: WorkjetDelegationEdgeKind,
  /** The delegation the edge originates from (the reviewer/reviser/follow-up). */
  from: WorkjetDelegationRef,
  /** The delegation the edge points at (the reviewed/revised/original work). */
  to: WorkjetDelegationRef,
  createdAt: WorkjetMailboxTimestamp,
  /** Graph depth of `from`, bounded by the budget's `maxDepth`. */
  depth: NonNegativeInt.check(Schema.isLessThanOrEqualTo(16)),
});
export type WorkjetDelegationEdge = typeof WorkjetDelegationEdge.Type;

/**
 * Typed thread handoff (owner decision, 2026-08-18): the portability model is
 * an immutable prompt/context snapshot plus bounded artifact references plus a
 * pushed-or-bundled Git branch plus a durable link to the source thread. The
 * target machine creates a NEW thread and continues with any harness/LLM, so
 * this contract carries no harness, model, or provider field — exactly like
 * {@link WorkjetWorkerAddress}. The source server keeps the original raw
 * history readable; no events are exported or replicated.
 */
export const WorkjetThreadHandoff = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  envelopeId: WorkjetEnvelopeId,
  handoffId: WorkjetHandoffId,
  /** Durable link back to the source thread; it remains authoritative for its history. */
  sourceThread: WorkjetWorkerAddress,
  /** The receiving machine. It has no thread id yet — it creates a new thread. */
  target: WorkjetEnvironmentAddress,
  createdAt: WorkjetMailboxTimestamp,
  expiresAt: WorkjetMailboxTimestamp,
  contextSnapshot: WorkjetPromptSnapshotRef,
  /** The worker worktree branch is mandatory for a handoff, unlike a plain result. */
  branch: WorkjetGitBranchRef,
  artifacts: WorkjetArtifactReferences,
  /** Bounded operator-facing note; the snapshot carries the real context. */
  note: Schema.optionalKey(boundedText(4_096)),
});
export type WorkjetThreadHandoff = typeof WorkjetThreadHandoff.Type;

/** Discriminator of the payload an envelope carries. */
export const WorkjetMailboxEnvelopeKind = Schema.Literals([
  "message",
  "delegation",
  "receipt",
  "result",
  "review",
  "handoff",
]);
export type WorkjetMailboxEnvelopeKind = typeof WorkjetMailboxEnvelopeKind.Type;

/**
 * The ONLY part of a mailbox item a forwarding peer is permitted to inspect:
 * "the relay may inspect only the minimum routing and expiry metadata".
 *
 * It carries the stable envelope id for idempotent insertion, the routing
 * addresses, creation/expiry timestamps, the payload kind, and the signature
 * over the immutable routing envelope produced with the source environment key.
 * It deliberately contains no prompt, no result summary, no artifact
 * reference, and no sealed payload.
 */
export const WorkjetRoutingEnvelope = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  envelopeId: WorkjetEnvelopeId,
  kind: WorkjetMailboxEnvelopeKind,
  sourceWorkspaceId: WorkjetMeshWorkspaceId,
  sourceEnvironmentId: EnvironmentId,
  targetWorkspaceId: WorkjetMeshWorkspaceId,
  targetEnvironmentId: EnvironmentId,
  createdAt: WorkjetMailboxTimestamp,
  expiresAt: WorkjetMailboxTimestamp,
  /** Detached signature over this routing envelope, made with the source environment key. */
  signature: TrimmedNonEmptyString.check(
    Schema.isMaxLength(512),
    Schema.isPattern(/^[A-Za-z0-9_-]{16,512}$/),
  ),
});
export type WorkjetRoutingEnvelope = typeof WorkjetRoutingEnvelope.Type;

/**
 * The mailbox payload union. `_tag` matches {@link WorkjetMailboxEnvelopeKind}
 * so a peer that may only read the routing envelope still routes correctly.
 */
export const WorkjetMailboxPayload = Schema.Union([
  Schema.TaggedStruct("message", { message: WorkjetWorkerMessage }),
  Schema.TaggedStruct("delegation", {
    delegation: WorkjetDelegation,
    /**
     * ADDITIVE, cross-machine only. The verbatim bytes of the delegation's
     * immutable prompt snapshot, attached by the transport when a delegation is
     * enqueued to a DIFFERENT environment and the sealed wrapper still fits the
     * wire ceiling. The receiver `put`s them into its LOCAL snapshot store,
     * re-verifying the digest, so the executor can read the prompt locally
     * instead of skipping on `missingSnapshot`. Absent on every same-environment
     * (local fast-path) payload and stripped before the row is persisted, so the
     * durable delegation stays reference-only.
     */
    snapshotBytes: Schema.optionalKey(WorkjetDelegationSnapshotBytes),
    /**
     * ADDITIVE, cross-machine only. Set to `true` when the prompt snapshot was
     * too large to seal within the wire ceiling: the delegation then travels
     * reference-only and the receiver leaves it `delivered` with a bounded
     * reason rather than silently dropping it. Mutually exclusive with
     * {@link snapshotBytes}.
     */
    snapshotOversized: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("receipt", { receipt: WorkjetDeliveryReceipt }),
  Schema.TaggedStruct("result", { result: WorkjetDelegationResult }),
  Schema.TaggedStruct("review", { verdict: WorkjetReviewVerdict }),
  Schema.TaggedStruct("handoff", { handoff: WorkjetThreadHandoff }),
]);
export type WorkjetMailboxPayload = typeof WorkjetMailboxPayload.Type;

/** Bounded failure reasons for every mailbox operation. */
export const WorkjetMailboxFailureReason = Schema.Literals([
  "unauthorized",
  "unknown-target",
  "target-thread-deleted",
  "target-offline",
  "malformed-envelope",
  /**
   * The detached routing-envelope signature did not verify against the claimed
   * source environment key. It is deliberately distinct from
   * `malformed-envelope` (a structurally invalid envelope) and from
   * `unauthorized` (a valid signer without the right to this operation).
   */
  "invalid-signature",
  "duplicate-envelope",
  "payload-too-large",
  "envelope-expired",
  "delegation-expired",
  "depth-exceeded",
  "review-rounds-exceeded",
  /**
   * Additive Wave-5 token/cost budget gates. Refused BEFORE the durable effect
   * that would cross the ceiling, exactly like `depth-exceeded` /
   * `review-rounds-exceeded`.
   */
  "token-budget-exceeded",
  "cost-budget-exceeded",
  "invalid-state-transition",
  "version-skew",
  "transport-unavailable",
  "mailbox-unavailable",
  "cancelled",
]);
export type WorkjetMailboxFailureReason = typeof WorkjetMailboxFailureReason.Type;

/**
 * Sanitized mailbox failure. Like the other Workjet RPC errors, the wire
 * representation is limited to a bounded reason and never carries prompts,
 * peer addresses, transport detail, paths, or arbitrary server messages —
 * the plan forbids storing such material in relay logs, traces, push
 * notifications, or crash reports.
 */
export class WorkjetMailboxError extends Schema.TaggedErrorClass<WorkjetMailboxError>()(
  "WorkjetMailboxError",
  { reason: WorkjetMailboxFailureReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "unauthorized":
        return "The mailbox operation is not authorized for this environment.";
      case "unknown-target":
        return "The mailbox target address is unknown.";
      case "target-thread-deleted":
        return "The mailbox target thread no longer exists.";
      case "target-offline":
        return "The mailbox target is offline.";
      case "malformed-envelope":
        return "The mailbox envelope is malformed.";
      case "invalid-signature":
        return "The mailbox envelope signature is invalid.";
      case "duplicate-envelope":
        return "The mailbox envelope was already delivered.";
      case "payload-too-large":
        return "The mailbox payload exceeds the allowed size.";
      case "envelope-expired":
        return "The mailbox envelope expired before delivery.";
      case "delegation-expired":
        return "The delegation expired.";
      case "depth-exceeded":
        return "The delegation graph depth budget is exhausted.";
      case "review-rounds-exceeded":
        return "The delegation review-round budget is exhausted.";
      case "token-budget-exceeded":
        return "The delegation token budget is exhausted.";
      case "cost-budget-exceeded":
        return "The delegation cost budget is exhausted.";
      case "invalid-state-transition":
        return "The requested delegation state transition is not allowed.";
      case "version-skew":
        return "The peer uses an incompatible mailbox contract version.";
      case "transport-unavailable":
        return "The Workjet mailbox transport is unavailable.";
      case "mailbox-unavailable":
        return "The Workjet mailbox is unavailable.";
      case "cancelled":
        return "The mailbox operation was cancelled.";
    }
  }
}

// ===============================
// Client-facing RPC surface
// ===============================

/**
 * Bounds on an envelope time-to-live a client may request. The server clamps
 * anyway; declaring the range here lets the composer render the same
 * constraints the wire enforces instead of guessing them.
 */
export const WORKJET_MAILBOX_RPC_MIN_TTL_SECONDS = 60;
export const WORKJET_MAILBOX_RPC_MAX_TTL_SECONDS = 604_800;

export const WorkjetMailboxTtlSeconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(WORKJET_MAILBOX_RPC_MIN_TTL_SECONDS),
  Schema.isLessThanOrEqualTo(WORKJET_MAILBOX_RPC_MAX_TTL_SECONDS),
);

/**
 * Ceiling on the delegation prompt TEXT, in UTF-16 code units. Mirrors the MCP
 * tool's bound so the two entry points cannot drift into two different limits.
 */
export const WORKJET_MAILBOX_RPC_PROMPT_MAX_LENGTH = 262_144;

/**
 * The addressing fields a client may choose.
 *
 * The SOURCE workspace and environment are never caller-supplied: the server
 * takes them from its own mesh identity. The source THREAD is, because one
 * client speaks for many threads — it is validated to exist and to be an
 * orchestrator thread before anything durable is written.
 *
 * `targetWorkspaceId` is optional: a same-environment target lives in this
 * server's own mesh workspace, and a client cannot know that opaque id. When
 * omitted the server substitutes its own.
 */
const WorkjetMailboxRpcAddressFields = {
  sourceThreadId: ThreadId,
  targetWorkspaceId: Schema.optional(WorkjetMeshWorkspaceId),
  targetEnvironmentId: EnvironmentId,
  targetThreadId: ThreadId,
} as const;

export const WorkjetMailboxSendMessageRpcInput = Schema.Struct({
  ...WorkjetMailboxRpcAddressFields,
  body: WorkjetMessageBody,
  ttlSeconds: Schema.optional(WorkjetMailboxTtlSeconds),
  inReplyTo: Schema.optional(WorkjetEnvelopeId),
});
export type WorkjetMailboxSendMessageRpcInput = typeof WorkjetMailboxSendMessageRpcInput.Type;

export const WorkjetMailboxDelegationBudgetRpcInput = Schema.Struct({
  maxDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(16)),
  maxReviewRounds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(16),
  ),
  ttlSeconds: WorkjetMailboxTtlSeconds,
});
export type WorkjetMailboxDelegationBudgetRpcInput =
  typeof WorkjetMailboxDelegationBudgetRpcInput.Type;

/**
 * The prompt arrives as TEXT, exactly as it does over MCP: the side that stores
 * the bytes is the side that computes the digest, so a client cannot pin a
 * snapshot reference the server never wrote.
 */
export const WorkjetMailboxDelegateTaskRpcInput = Schema.Struct({
  ...WorkjetMailboxRpcAddressFields,
  prompt: TrimmedNonEmptyString.check(
    Schema.isMaxLength(WORKJET_MAILBOX_RPC_PROMPT_MAX_LENGTH),
    NoUnsafeControlCharacters,
  ),
  scope: Schema.Struct({
    files: Schema.Array(WorkjetRepositoryPath).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(256),
    ),
    nonGoals: boundedText(4_096),
  }),
  acceptance: boundedText(8_192),
  budget: WorkjetMailboxDelegationBudgetRpcInput,
  depth: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(16)),
  ),
  parentDelegationId: Schema.optional(WorkjetDelegationId),
  ttlSeconds: Schema.optional(WorkjetMailboxTtlSeconds),
});
export type WorkjetMailboxDelegateTaskRpcInput = typeof WorkjetMailboxDelegateTaskRpcInput.Type;

/**
 * `acknowledged` means the target inbox answered with a receipt; `queued` is
 * the honest answer for a target this server cannot reach yet.
 */
export const WorkjetMailboxDeliveryStatus = Schema.Literals(["acknowledged", "queued"]);
export type WorkjetMailboxDeliveryStatus = typeof WorkjetMailboxDeliveryStatus.Type;

export const WorkjetMailboxSendMessageRpcResult = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  status: WorkjetMailboxDeliveryStatus,
  envelopeId: WorkjetEnvelopeId,
  disposition: Schema.optional(WorkjetDeliveryDisposition),
  acknowledgedAt: Schema.optional(WorkjetMailboxTimestamp),
});
export type WorkjetMailboxSendMessageRpcResult = typeof WorkjetMailboxSendMessageRpcResult.Type;

export const WorkjetMailboxDelegateTaskRpcResult = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  status: WorkjetMailboxDeliveryStatus,
  envelopeId: WorkjetEnvelopeId,
  delegationId: WorkjetDelegationId,
  ownerEnvironmentId: EnvironmentId,
  ownerThreadId: ThreadId,
  state: WorkjetDelegationState,
  disposition: Schema.optional(WorkjetDeliveryDisposition),
  acknowledgedAt: Schema.optional(WorkjetMailboxTimestamp),
});
export type WorkjetMailboxDelegateTaskRpcResult = typeof WorkjetMailboxDelegateTaskRpcResult.Type;

/**
 * Redacted, bounded thread-activity payload written for every mailbox event
 * (`workjet.message.sent|received`, `workjet.delegation.sent|received`).
 *
 * It carries ids, addresses, and lifecycle state only — never message text,
 * never the sealed payload reference, never prompt or artifact material. The
 * schema exists so the timeline can decode the payload it renders instead of
 * poking at `unknown`.
 */
export const WorkjetMailboxActivityAddress = Schema.Struct({
  workspaceId: WorkjetMeshWorkspaceId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type WorkjetMailboxActivityAddress = typeof WorkjetMailboxActivityAddress.Type;

export const WorkjetMailboxActivityPayload = Schema.Struct({
  schemaVersion: MailboxSchemaVersion,
  envelopeId: WorkjetEnvelopeId,
  direction: Schema.Literals(["outbound", "inbound"]),
  source: WorkjetMailboxActivityAddress,
  target: WorkjetMailboxActivityAddress,
  bodyKind: Schema.optional(Schema.Literals(["inline", "sealed"])),
  disposition: Schema.optional(WorkjetDeliveryDisposition),
  delegationId: Schema.optional(WorkjetDelegationId),
  delegationState: Schema.optional(WorkjetDelegationState),
  createdAt: WorkjetMailboxTimestamp,
  expiresAt: WorkjetMailboxTimestamp,
});
export type WorkjetMailboxActivityPayload = typeof WorkjetMailboxActivityPayload.Type;

/** The four thread-activity kinds the mailbox appends. */
export const WORKJET_MAILBOX_ACTIVITY_KINDS = [
  "workjet.message.sent",
  "workjet.message.received",
  "workjet.delegation.sent",
  "workjet.delegation.received",
] as const;
export type WorkjetMailboxActivityKind = (typeof WORKJET_MAILBOX_ACTIVITY_KINDS)[number];
