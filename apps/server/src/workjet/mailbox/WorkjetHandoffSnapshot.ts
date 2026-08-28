// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Composition of the immutable CONTEXT SNAPSHOT a typed thread handoff carries
 * (docs/workjet-plan.md → "Add the typed thread-handoff contract and flow …
 * the target machine continues in a new thread with any harness/LLM").
 *
 * The owner decision of 2026-08-18 fixed the portability model as
 * HANDOFF-SNAPSHOT and explicitly REJECTED event export and history
 * replication. This module is where that decision becomes a concrete number of
 * bytes, so it is worth stating exactly what a snapshot is and is not:
 *
 * IT IS a bounded, self-contained continuation brief, composed from what the
 * orchestration projection already holds in memory for the thread:
 *
 *   - the source thread's title and its full routable address, so the receiving
 *     operator knows whose work this is and can ask the source machine;
 *   - the branch reference, with the honest reachability statement the
 *     `WorkjetHandoffBranchRef` contract permits and nothing stronger;
 *   - the operator's bounded note;
 *   - a bounded TAIL of the most recent messages, oldest-first.
 *
 * IT IS NOT the thread's history. No events, no turns, no tool calls, no
 * attachments, no checkpoints, no provider payloads, no local filesystem paths.
 * Three independent bounds keep it that way and the composition REPORTS each
 * one it hit, so the sender is told what was left behind instead of being
 * allowed to believe everything travelled:
 *
 *   1. {@link WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES} — how many messages at most.
 *   2. {@link WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGE_CHARS} — how long one may be.
 *   3. {@link WORKJET_HANDOFF_SNAPSHOT_MAX_BYTES} — the total UTF-8 ceiling,
 *      which equals the contract's cross-machine transfer ceiling, so a snapshot
 *      that composed successfully can always be ATTEMPTED on the wire. (Whether
 *      the SEALED wrapper then fits the transport's 200 000-byte gate is a
 *      separate, later check the transport owns.)
 *
 * The byte ceiling is applied from the NEWEST message backwards: when the tail
 * does not fit, the oldest messages are the ones dropped, because the most
 * recent exchange is what a continuation actually needs. The header is composed
 * first and never dropped — a snapshot without its source address would be
 * unusable, so a header that alone exceeded the ceiling is a composition
 * failure rather than a silently headerless body.
 *
 * The function is pure and total: no clock, no filesystem, no store. The caller
 * writes the returned text into the content-addressed snapshot store, which is
 * what makes the digest describe bytes the SERVER produced rather than bytes a
 * client claimed.
 */
import {
  WORKJET_HANDOFF_SNAPSHOT_TRANSFER_MAX_BYTES,
  type EnvironmentId,
  type WorkjetHandoffBranchRef,
  type WorkjetWorkerAddress,
} from "@t3tools/contracts";

/**
 * How many trailing messages a snapshot may carry at most.
 *
 * The count and character bounds are deliberately chosen so their PRODUCT
 * (40 × 8 000 = 320 000 characters) exceeds the byte ceiling: all three bounds
 * are then live, and the byte ceiling is a bound the composition really applies
 * rather than an unreachable backstop nothing ever tests.
 */
export const WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES = 40;

/** How many characters of ONE message's text a snapshot may carry. */
export const WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGE_CHARS = 8_000;

/**
 * Total UTF-8 ceiling of a composed snapshot. Deliberately the contract's
 * cross-machine transfer ceiling, so composition never produces a snapshot that
 * the wire schema would reject outright.
 */
export const WORKJET_HANDOFF_SNAPSHOT_MAX_BYTES = WORKJET_HANDOFF_SNAPSHOT_TRANSFER_MAX_BYTES;

const utf8 = new TextEncoder();
const byteLengthOf = (value: string): number => utf8.encode(value).byteLength;

/** The only message fields a snapshot reads. Attachments are deliberately absent. */
export interface WorkjetHandoffSnapshotMessage {
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface WorkjetHandoffSnapshotInput {
  readonly sourceThread: WorkjetWorkerAddress;
  readonly targetEnvironmentId: EnvironmentId;
  readonly title: string;
  readonly branch: WorkjetHandoffBranchRef | undefined;
  readonly note: string | undefined;
  readonly composedAt: string;
  /** The thread's messages in chronological order; only the tail is carried. */
  readonly messages: ReadonlyArray<WorkjetHandoffSnapshotMessage>;
}

/**
 * What the composition produced AND what it left out. Every count is reported
 * so the sender can be told the truth about a bounded snapshot; none of them is
 * an error.
 */
export interface WorkjetHandoffSnapshotComposition {
  readonly text: string;
  readonly byteLength: number;
  /** Messages present in the source thread, before any bound applied. */
  readonly totalMessages: number;
  /** Messages actually carried. */
  readonly includedMessages: number;
  /** Carried messages whose text was cut at the per-message character bound. */
  readonly truncatedMessages: number;
  /** True when the byte ceiling — not the message count — dropped older messages. */
  readonly droppedByByteCeiling: boolean;
}

const TRUNCATION_MARKER = "\n[message truncated for the handoff snapshot]";

const truncateMessageText = (
  text: string,
): { readonly text: string; readonly truncated: boolean } => {
  const normalized = text.trim();
  if (normalized.length <= WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGE_CHARS) {
    return { text: normalized, truncated: false };
  }
  return {
    text: `${normalized.slice(0, WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGE_CHARS).trimEnd()}${TRUNCATION_MARKER}`,
    truncated: true,
  };
};

/**
 * The branch line. It states exactly what {@link WorkjetHandoffBranchRef}
 * permits: a name, a head commit only when one was actually read, and whether
 * the SOURCE repository has a remote configured — never that anything was
 * pushed, and never a local filesystem path.
 */
export const formatWorkjetHandoffBranchLine = (
  branch: WorkjetHandoffBranchRef | undefined,
): string => {
  if (branch === undefined) {
    return "Branch: none recorded (the source thread has no worktree branch).";
  }
  const head =
    branch.headCommit === undefined
      ? "head commit not resolved on the source machine"
      : `head ${branch.headCommit}`;
  const remote = branch.remoteConfigured
    ? "the source repository has a remote configured, but this handoff did NOT push anything"
    : "the source repository has no remote configured";
  return `Branch: ${branch.branch} (${head}; ${remote}).`;
};

export const composeWorkjetHandoffSnapshot = (
  input: WorkjetHandoffSnapshotInput,
): WorkjetHandoffSnapshotComposition => {
  const totalMessages = input.messages.length;

  // The count bound first: it is cheap and it is what makes the byte walk below
  // bounded work rather than a walk over an arbitrarily long history.
  const candidates = input.messages.slice(-WORKJET_HANDOFF_SNAPSHOT_MAX_MESSAGES);

  const headerLines = [
    "# Workjet thread handoff",
    "",
    "This is a BOUNDED CONTEXT SNAPSHOT, not an exported history. The source",
    "thread keeps its full history and stays authoritative for it on its own",
    "machine; nothing was replicated. Continue the work here in this thread.",
    "",
    `Source thread title: ${input.title}`,
    `Source address: workspace ${input.sourceThread.workspaceId} · environment ${input.sourceThread.environmentId} · thread ${input.sourceThread.threadId}`,
    `Target machine: environment ${input.targetEnvironmentId}`,
    `Composed at: ${input.composedAt}`,
    formatWorkjetHandoffBranchLine(input.branch),
    "",
  ];
  if (input.note !== undefined && input.note.trim().length > 0) {
    headerLines.push("## Operator note", "", input.note.trim(), "");
  }

  // Rendered newest-first, then reversed, so the byte ceiling drops the OLDEST
  // messages rather than the exchange a continuation actually needs.
  const rendered: Array<string> = [];
  let truncatedMessages = 0;
  let droppedByByteCeiling = false;
  let used = byteLengthOf(headerLines.join("\n"));

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    if (message === undefined) continue;
    const body = truncateMessageText(message.text);
    if (body.text.length === 0) continue;
    const block = `### ${message.role} · ${message.createdAt}\n\n${body.text}\n`;
    const cost = byteLengthOf(`${block}\n`);
    if (used + cost > WORKJET_HANDOFF_SNAPSHOT_MAX_BYTES) {
      // Everything older than this also does not fit; stop rather than skip, so
      // the carried tail stays contiguous instead of becoming a gapped sample.
      droppedByByteCeiling = true;
      break;
    }
    used += cost;
    if (body.truncated) truncatedMessages += 1;
    rendered.push(block);
  }
  rendered.reverse();

  const includedMessages = rendered.length;
  const heading =
    includedMessages === 0
      ? "## Recent messages\n\nNone carried: the thread has no message text within the snapshot bounds.\n"
      : `## Recent messages (last ${includedMessages} of ${totalMessages}, oldest first)\n`;

  const text = [...headerLines, heading, ...rendered].join("\n");
  return {
    text,
    byteLength: byteLengthOf(text),
    totalMessages,
    includedMessages,
    truncatedMessages,
    droppedByByteCeiling,
  };
};
