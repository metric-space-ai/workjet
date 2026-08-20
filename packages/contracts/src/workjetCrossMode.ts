// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * ADDITIVE. Versioned wire contracts for the CROSS-MODE WORKFLOW BRIDGE
 * (`docs/workjet-plan.md` → "Cross-mode workflow bridge", first three items).
 *
 * Nothing in this module changes an existing schema. It is a new file for a new
 * concern, exported alongside the mailbox contracts.
 *
 * WHAT A CROSS-MODE LINK IS. Exactly two typed references plus redacted
 * presentation metadata:
 *
 * - the CTOX side — the CTOX authority/instance plus a Business OS object
 *   reference (module id + object kind + object id), and
 * - the Code side — the T3 authority/environment plus thread, and optionally the
 *   turn ("run") and bounded artifact references that work produced.
 *
 * The plan's constraint is the whole design:
 *
 *   "Cross-mode links contain stable typed references and redacted presentation
 *    metadata only. They never copy provider credentials, pairing secrets, raw
 *    database records, or unrestricted launch capabilities between authorities."
 *
 * Three invariants follow, and every schema below is shaped to make violating
 * them UNREPRESENTABLE rather than merely discouraged:
 *
 * 1. NO RECORD PAYLOAD. A link carries a bounded `title` and an optional bounded
 *    `subtitle`, and nothing else that a human reads. There is no free-form
 *    object, no `data`, no `fields`, no `record`, no JSON string — a Business OS
 *    record stays in the Business OS authority, and the link is a pointer to it.
 *    `packages/contracts/src/workjetCrossMode.test.ts` asserts this structurally:
 *    a decode of any presentation value carrying extra keys drops them, and the
 *    two text fields are length-bounded well below anything that could smuggle a
 *    serialized row.
 * 2. NO CREDENTIAL, NO CAPABILITY. There is deliberately no token, no room
 *    secret, no signaling URL, no base URL, no session id, and no launch
 *    argument anywhere in this module. A link never authorizes anything by
 *    itself; it names two objects, and each authority re-authorizes every read
 *    and mutation of its own.
 * 3. EXPLICIT AUTHORITY, SERVER-VERIFIED. Both sides name their authority
 *    explicitly — `instanceId` for CTOX, `environmentId` for Code. Neither is
 *    ever taken from the caller as truth: the SERVER re-derives the Code
 *    authority from its own configuration and re-verifies the CTOX authority
 *    against the CTOX instance it can independently observe, and refuses the
 *    operation with {@link WorkjetCrossModeError} `unverified-authority`
 *    otherwise. The RPC INPUTS below therefore deliberately omit
 *    `environmentId`: a renderer cannot even express the ambient-authority
 *    mistake.
 *
 * The CTOX side is reached ONLY through the validated CTOX MCP command surface.
 * There is no Business OS HTTP data bridge and no shared database, so no schema
 * here models one.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { CtoxAppModuleId, CtoxManagedInstanceId } from "./ctox.ts";
import { WorkjetArtifactReferences, WorkjetDelegationApprovalState } from "./workjetMailbox.ts";

/** Current schema version of every contract in this module. */
export const WORKJET_CROSS_MODE_SCHEMA_VERSION = 1;

const CrossModeSchemaVersion = Schema.Literal(WORKJET_CROSS_MODE_SCHEMA_VERSION);

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
 * Prose fields (evidence summaries, review reasons) may contain tab and newline
 * but nothing else from the control range. Mirrors the mailbox module's rule.
 */
const NoUnsafeControlCharacters = Schema.makeFilter((input: string) => {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0d) continue;
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return "Value must not contain ASCII control characters.";
    }
  }
  return true;
});

const boundedText = (maximum: number) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(maximum), NoUnsafeControlCharacters);

/**
 * ISO-8601 timestamp, bounded exactly like the mailbox's: a link is persisted
 * durably and its timestamps are duplicated into ordering columns.
 */
export const WorkjetCrossModeTimestamp = IsoDateTime.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/),
);
export type WorkjetCrossModeTimestamp = typeof WorkjetCrossModeTimestamp.Type;

/**
 * Durable identity of one cross-mode link. Server-chosen, never caller-supplied:
 * a client that could pin a link id could overwrite an existing link's
 * references by claiming its id.
 */
export const WorkjetCrossModeLinkId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
).pipe(Schema.brand("WorkjetCrossModeLinkId"));
export type WorkjetCrossModeLinkId = typeof WorkjetCrossModeLinkId.Type;

// ===============================
// The CTOX side of a link
// ===============================

/**
 * The KIND of Business OS object a link points at, as its owning module names
 * it (`deal`, `ticket`, `invoice`, …).
 *
 * It is a bounded opaque token rather than a closed literal union on purpose:
 * Business OS modules are the CTOX authority's own extension surface, and
 * enumerating their object kinds here would make every new module a T3 contract
 * change. The charset is CTOX's own id charset (`[A-Za-z0-9_-]`, see
 * `CTOX_ID_PATTERN` in the server's `WorkjetMailboxTransport`), so a kind that
 * this contract accepts is always a kind CTOX can store.
 */
export const WorkjetBusinessOsObjectKind = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
).pipe(Schema.brand("WorkjetBusinessOsObjectKind"));
export type WorkjetBusinessOsObjectKind = typeof WorkjetBusinessOsObjectKind.Type;

/**
 * The IDENTITY of one Business OS object inside its module. Opaque to T3 by
 * construction: this side of the bridge never interprets it, it only carries it
 * back to the authority that issued it. Bounded to CTOX's id charset for the
 * same reason as the kind.
 */
export const WorkjetBusinessOsObjectId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
).pipe(Schema.brand("WorkjetBusinessOsObjectId"));
export type WorkjetBusinessOsObjectId = typeof WorkjetBusinessOsObjectId.Type;

/**
 * The CTOX half of a cross-mode link: the AUTHORITY (which CTOX instance) plus
 * the OBJECT (which module, which kind, which id).
 *
 * `instanceId` reuses {@link CtoxManagedInstanceId} and `moduleId` reuses
 * {@link CtoxAppModuleId} rather than minting parallel ids — a link must name
 * the very same instance the CTOX surfaces already name, or "open the link"
 * could not select anything.
 *
 * There is no display name, no domain, no health, and no status here. Those are
 * live properties of an instance that the CTOX authority answers for; freezing
 * them into a durable link would create a second, stale source of truth.
 */
export const WorkjetCrossModeCtoxRef = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  instanceId: CtoxManagedInstanceId,
  moduleId: CtoxAppModuleId,
  objectKind: WorkjetBusinessOsObjectKind,
  objectId: WorkjetBusinessOsObjectId,
});
export type WorkjetCrossModeCtoxRef = typeof WorkjetCrossModeCtoxRef.Type;

// ===============================
// The Code side of a link
// ===============================

/**
 * The Code half: the T3 AUTHORITY (`environmentId` — one running T3 server and
 * the machine, filesystem, credentials, and state it owns) plus the thread, and
 * optionally the turn that produced a result and the bounded artifact
 * references that work left behind.
 *
 * `runTurnId` is the repository's existing {@link TurnId}: "one user-to-agent
 * cycle" IS the run a cross-mode result refers to, and inventing a parallel
 * `runId` would name the same thing twice. It is optional because a link is
 * created BEFORE any turn has run.
 *
 * `artifacts` reuses {@link WorkjetArtifactReferences} unchanged — branch,
 * commit hashes, repository-relative paths. That type already excludes file
 * contents, diffs, provider payloads, and secrets by construction, which is
 * exactly the guarantee a cross-authority link needs, so it is reused rather
 * than re-derived.
 */
export const WorkjetCrossModeCodeRef = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  /** The turn ("run") a submitted result came out of. Absent until one exists. */
  runTurnId: Schema.optionalKey(TurnId),
  /** Bounded references only; absent until the work produced any. */
  artifacts: Schema.optionalKey(WorkjetArtifactReferences),
});
export type WorkjetCrossModeCodeRef = typeof WorkjetCrossModeCodeRef.Type;

// ===============================
// Redacted presentation metadata
// ===============================

/**
 * Everything a surface is allowed to RENDER about the counterpart without
 * asking its authority: a bounded title and an optional bounded subtitle.
 *
 * This is the schema that enforces invariant 1. It is a closed struct of two
 * short text fields, so there is no field a record payload could ride in: no
 * `data`, no `fields`, no `body`, no `json`, no array, no nested object. The
 * 200/280 bounds are chosen to be obviously too small for a serialized row and
 * large enough for "Deal — ACME Q3 renewal" / "Owner: M. Welsch · Stage:
 * negotiation".
 *
 * Presentation metadata is a CACHE for a label, never a source of truth. A
 * surface that needs the live record asks the owning authority for it.
 */
export const WorkjetCrossModePresentation = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200), NoAsciiControlCharacters),
  subtitle: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(280), NoAsciiControlCharacters),
  ),
});
export type WorkjetCrossModePresentation = typeof WorkjetCrossModePresentation.Type;

// ===============================
// The link
// ===============================

/**
 * One durable cross-mode link.
 *
 * `expiresAt` is OPTIONAL and means what it says: most links do not expire,
 * because a Business OS object and the Code thread that implements it stay
 * related indefinitely. A link created for a time-boxed engagement may carry
 * one, and the plan's "stale-link behavior" item reads it. An absent value is
 * "no expiry", never "expired".
 */
export const WorkjetCrossModeLink = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  linkId: WorkjetCrossModeLinkId,
  ctox: WorkjetCrossModeCtoxRef,
  code: WorkjetCrossModeCodeRef,
  presentation: WorkjetCrossModePresentation,
  createdAt: WorkjetCrossModeTimestamp,
  expiresAt: Schema.optionalKey(WorkjetCrossModeTimestamp),
});
export type WorkjetCrossModeLink = typeof WorkjetCrossModeLink.Type;

// ===============================
// Errors
// ===============================

/**
 * Bounded refusal reasons. Every value is a constant: these cross an authority
 * boundary and must never carry a path, an instance URL, a token fragment, or a
 * daemon error string.
 *
 * - `unverified-authority` — the CTOX authority/instance the caller named is not
 *   one this server can independently verify. It is the SINGLE answer for
 *   "invented", "unknown", "not docked here", and "no longer reachable": a
 *   caller that may not link to an instance also may not learn from the error
 *   whether that instance exists.
 * - `unauthorized` — the Code-side thread is not one this caller may link or act
 *   from (missing, deleted, or not permitted). Deliberately undistinguished, the
 *   same discipline `WorkjetMailboxRpc` applies to a source thread.
 * - `unknown-link` — no link with that id, or the link does not name this thread.
 * - `thread-already-linked` — the Code thread already carries a link to a
 *   DIFFERENT Business OS object. One thread implements one object; the reverse
 *   would make "Return to Business OS" ambiguous, so it is refused rather than
 *   resolved by a guess.
 * - `link-expired` — the link carries an `expiresAt` already in the past.
 * - `approval-required` — the operation is gated and no approval has been
 *   granted yet; see {@link WorkjetCrossModeCommandApproval}.
 * - `ctox-command-unavailable` — the validated CTOX MCP command surface is not
 *   reachable from this server right now. NOT a validation failure: the request
 *   was well formed and authorized, and the boundary is simply down.
 * - `ctox-command-rejected` — the CTOX authority itself refused the command.
 *   Whatever it said stays on its side of the boundary.
 * - `cross-mode-unavailable` — the local durable store could not answer.
 */
export const WorkjetCrossModeErrorReason = Schema.Literals([
  "unverified-authority",
  "unauthorized",
  "unknown-link",
  "thread-already-linked",
  "link-expired",
  "approval-required",
  "ctox-command-unavailable",
  "ctox-command-rejected",
  "cross-mode-unavailable",
]);
export type WorkjetCrossModeErrorReason = typeof WorkjetCrossModeErrorReason.Type;

export class WorkjetCrossModeError extends Schema.TaggedErrorClass<WorkjetCrossModeError>()(
  "WorkjetCrossModeError",
  { reason: WorkjetCrossModeErrorReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "unverified-authority":
        return "The CTOX authority for this link could not be verified by this server.";
      case "unauthorized":
        return "This thread may not be linked or acted from.";
      case "unknown-link":
        return "No such cross-mode link.";
      case "thread-already-linked":
        return "This thread already carries a link to a different Business OS object.";
      case "link-expired":
        return "This cross-mode link has expired.";
      case "approval-required":
        return "This cross-mode operation requires approval before it can run.";
      case "ctox-command-unavailable":
        return "The CTOX command surface is not reachable from this server.";
      case "ctox-command-rejected":
        return "The CTOX authority refused this command.";
      case "cross-mode-unavailable":
        return "The cross-mode link store is unavailable.";
    }
  }
}

// ===============================
// Delegate to Code / Open in Code
// ===============================
// The Business-OS-side action. ONE operation covers both labels, because they
// are the same server behaviour seen from two states: "Open in Code" is what the
// button says when a link already exists, "Delegate to Code" is what it says
// when none does, and which one happened is reported back in `selection` rather
// than chosen by the caller. A caller that could choose would be able to demand
// a second thread for an object that already has one.

/**
 * Ceiling on the SCOPED CONTEXT a delegation hands over.
 *
 * It is bounded prose, composed by the Business OS surface out of what the
 * OPERATOR chose to hand over, and it is the one field in this module that
 * carries free text across the boundary. 16 KiB is the same order as the
 * mailbox's delegation prose fields and is far below what a record dump would
 * need — the bound is part of invariant 1, not a performance limit.
 */
export const WORKJET_CROSS_MODE_CONTEXT_MAX_BYTES = 16_384;

/**
 * The explicit, scoped context handoff. There is no "copy the record" option and
 * no reference to one: whatever the operator wants Code to know must be written
 * here in prose, which makes the disclosure decision visible and auditable
 * instead of implicit in a serializer.
 */
export const WorkjetCrossModeScopedContext = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  /** What Code is being asked to do, in the operator's words. */
  brief: boundedText(WORKJET_CROSS_MODE_CONTEXT_MAX_BYTES),
});
export type WorkjetCrossModeScopedContext = typeof WorkjetCrossModeScopedContext.Type;

/**
 * `Delegate to Code` / `Open in Code`.
 *
 * NOTE WHAT IS ABSENT: there is no `environmentId`. The Code authority is this
 * server, always, and it is filled in server-side — a renderer cannot name a
 * different one, which is invariant 3 expressed in the input type rather than in
 * a runtime check that could be forgotten.
 *
 * `hostThreadId` names a LIVE thread on this machine whose project, model
 * selection, runtime mode, and interaction mode a newly created thread inherits.
 * It is the same settings-template role `WorkjetMailboxAcceptHandoffRpcInput`
 * gives it, and it exists for the same reason: the Business OS side knows
 * nothing about this machine's projects, and inventing one would be a guess.
 */
export const WorkjetCrossModeOpenInCodeRpcInput = Schema.Struct({
  ctox: WorkjetCrossModeCtoxRef,
  presentation: WorkjetCrossModePresentation,
  /** Settings template and project anchor for a thread that has to be created. */
  hostThreadId: ThreadId,
  /** Required: a delegation without explicit scoped context is not representable. */
  context: WorkjetCrossModeScopedContext,
});
export type WorkjetCrossModeOpenInCodeRpcInput = typeof WorkjetCrossModeOpenInCodeRpcInput.Type;

/**
 * Which of the two behaviours happened. `selected` means an existing link was
 * returned untouched — a second `Delegate to Code` on the same object opens the
 * thread that already implements it and never forks a duplicate.
 */
export const WorkjetCrossModeSelection = Schema.Literals(["created", "selected"]);
export type WorkjetCrossModeSelection = typeof WorkjetCrossModeSelection.Type;

export const WorkjetCrossModeOpenInCodeRpcResult = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  selection: WorkjetCrossModeSelection,
  link: WorkjetCrossModeLink,
});
export type WorkjetCrossModeOpenInCodeRpcResult = typeof WorkjetCrossModeOpenInCodeRpcResult.Type;

// ===============================
// Reads
// ===============================

/** Upper bound on one link listing. A picker/navigator list, not an archive dump. */
export const WORKJET_CROSS_MODE_LINK_LIST_MAX = 100;

/**
 * The backlink read in the Code → Business OS direction: "does THIS thread carry
 * a cross-mode link, and to what". It is what a Code thread's affordances are
 * gated on.
 */
export const WorkjetCrossModeGetThreadLinkRpcInput = Schema.Struct({ threadId: ThreadId });
export type WorkjetCrossModeGetThreadLinkRpcInput =
  typeof WorkjetCrossModeGetThreadLinkRpcInput.Type;

export const WorkjetCrossModeGetThreadLinkRpcResult = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  /** Absent when the thread carries no link; an ordinary, non-error answer. */
  link: Schema.optionalKey(WorkjetCrossModeLink),
});
export type WorkjetCrossModeGetThreadLinkRpcResult =
  typeof WorkjetCrossModeGetThreadLinkRpcResult.Type;

export const WorkjetCrossModeListLinksRpcInput = Schema.Struct({
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WORKJET_CROSS_MODE_LINK_LIST_MAX),
    ),
  ),
});
export type WorkjetCrossModeListLinksRpcInput = typeof WorkjetCrossModeListLinksRpcInput.Type;

export const WorkjetCrossModeListLinksRpcResult = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  links: Schema.Array(WorkjetCrossModeLink).check(
    Schema.isMaxLength(WORKJET_CROSS_MODE_LINK_LIST_MAX),
  ),
});
export type WorkjetCrossModeListLinksRpcResult = typeof WorkjetCrossModeListLinksRpcResult.Type;

// ===============================
// Return to Business OS
// ===============================
// The reverse direction: a linked Code thread submits a result with evidence,
// requests a review, or asks for a follow-up. Each maps onto ONE validated CTOX
// MCP command; none of them opens a data channel, and none of them carries a
// record.

/**
 * What a linked Code thread is asking the Business OS authority to do.
 *
 * These three are exactly the plan's list, and they mirror the delegation
 * graph's own edge kinds (`reviews` / `follows-up`) rather than inventing a
 * second vocabulary for the same relationships.
 */
export const WorkjetCrossModeOperation = Schema.Literals([
  "submit-result",
  "request-review",
  "follow-up",
]);
export type WorkjetCrossModeOperation = typeof WorkjetCrossModeOperation.Type;

/** Terminal verdict a submitted result reports, mirroring `WorkjetDelegationOutcome`. */
export const WorkjetCrossModeResultOutcome = Schema.Literals(["completed", "failed", "cancelled"]);
export type WorkjetCrossModeResultOutcome = typeof WorkjetCrossModeResultOutcome.Type;

/**
 * The EVIDENCE a result submission carries: a bounded summary plus bounded
 * artifact REFERENCES.
 *
 * "Evidence" here is deliberately not "the diff" and not "the files". It is the
 * summary an operator reads plus branch/commit/path references they can resolve
 * in the authority that owns them. Reusing {@link WorkjetArtifactReferences}
 * makes that structural: file contents are not a value this type can hold.
 */
export const WorkjetCrossModeEvidence = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  summary: boundedText(8_192),
  artifacts: WorkjetArtifactReferences,
  /** The turn this evidence came out of, when the caller knows it. */
  runTurnId: Schema.optionalKey(TurnId),
});
export type WorkjetCrossModeEvidence = typeof WorkjetCrossModeEvidence.Type;

/**
 * One reverse-direction request.
 *
 * The `linkId` is the ONLY authority reference on the wire: the CTOX instance,
 * the module, and the object are read from the stored link, never from the
 * request. That is invariant 3 for this direction — a caller cannot redirect a
 * submission at a different Business OS object by naming one, because there is
 * no field in which to name it.
 */
export const WorkjetCrossModeSubmitRpcInput = Schema.Struct({
  linkId: WorkjetCrossModeLinkId,
  /** The Code thread the submission is made FROM; it must be the link's own thread. */
  threadId: ThreadId,
  operation: WorkjetCrossModeOperation,
  evidence: WorkjetCrossModeEvidence,
  /** Set on `submit-result`; ignored by the other two operations. */
  outcome: Schema.optional(WorkjetCrossModeResultOutcome),
});
export type WorkjetCrossModeSubmitRpcInput = typeof WorkjetCrossModeSubmitRpcInput.Type;

/**
 * The approval gate, reusing {@link WorkjetDelegationApprovalState} rather than
 * a parallel literal set: "the existing approval model" is a plan requirement,
 * and a second four-value enum with the same meanings would be exactly the drift
 * that requirement exists to prevent.
 *
 * `not-required` — the operation ran. `pending` — it is recorded and gated, and
 * a human must clear it before it reaches CTOX. `approved` — cleared and ran.
 * `rejected` — cleared as refused; it will not run.
 */
export const WorkjetCrossModeCommandApproval = WorkjetDelegationApprovalState;
export type WorkjetCrossModeCommandApproval = typeof WorkjetCrossModeCommandApproval.Type;

/**
 * What the CTOX authority did with a dispatched command.
 *
 * `dispatched` means the validated MCP command was accepted by the CTOX
 * authority. `awaiting-approval` means nothing was dispatched: the command is
 * durable on this side and gated. There is no `delivered` and no `applied` —
 * this server cannot observe what the Business OS did with the command, and a
 * word implying it could would be a claim the bridge cannot support.
 */
export const WorkjetCrossModeSubmitStatus = Schema.Literals(["dispatched", "awaiting-approval"]);
export type WorkjetCrossModeSubmitStatus = typeof WorkjetCrossModeSubmitStatus.Type;

export const WorkjetCrossModeSubmitRpcResult = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  linkId: WorkjetCrossModeLinkId,
  operation: WorkjetCrossModeOperation,
  status: WorkjetCrossModeSubmitStatus,
  approval: WorkjetCrossModeCommandApproval,
  submittedAt: WorkjetCrossModeTimestamp,
});
export type WorkjetCrossModeSubmitRpcResult = typeof WorkjetCrossModeSubmitRpcResult.Type;

// ===============================
// Thread activity
// ===============================

/**
 * The redacted activity payload a cross-mode event writes onto a thread.
 *
 * Ids, the operation, and the bounded presentation TITLE only — the title is
 * already the redacted label the link itself carries, so repeating it here
 * leaks nothing new and lets the timeline render "Linked to: ACME Q3 renewal"
 * without a second read. The evidence summary, the scoped-context brief, and the
 * artifact references are NOT here: an activity row is a trace, not a transcript.
 */
export const WorkjetCrossModeActivityPayload = Schema.Struct({
  schemaVersion: CrossModeSchemaVersion,
  linkId: WorkjetCrossModeLinkId,
  direction: Schema.Literals(["to-code", "to-business-os"]),
  ctox: WorkjetCrossModeCtoxRef,
  code: WorkjetCrossModeCodeRef,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200), NoAsciiControlCharacters),
  /** Absent on the link-created event; present on every reverse-direction one. */
  operation: Schema.optional(WorkjetCrossModeOperation),
  approval: Schema.optional(WorkjetCrossModeCommandApproval),
  createdAt: WorkjetCrossModeTimestamp,
});
export type WorkjetCrossModeActivityPayload = typeof WorkjetCrossModeActivityPayload.Type;

/**
 * The thread-activity kinds the cross-mode bridge appends.
 *
 * `workjet.crossmode.linked` lands on the Code thread when a link is created and
 * IS the durable backlink: a reader of that thread's own event stream learns
 * which Business OS object it implements without querying the link table.
 * `workjet.crossmode.returned` lands on the same thread for every reverse
 * operation.
 */
export const WORKJET_CROSS_MODE_ACTIVITY_KINDS = [
  "workjet.crossmode.linked",
  "workjet.crossmode.returned",
] as const;
export type WorkjetCrossModeActivityKind = (typeof WORKJET_CROSS_MODE_ACTIVITY_KINDS)[number];
