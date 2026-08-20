import { useCallback, useState } from "react";
import {
  WorkjetMailboxError,
  WorkjetMailboxFailureReason,
  WORKJET_MAILBOX_RPC_MAX_TTL_SECONDS,
  WORKJET_MAILBOX_RPC_MIN_TTL_SECONDS,
  WORKJET_MAILBOX_RPC_PROMPT_MAX_LENGTH,
  WorkjetRepositoryPath,
  type EnvironmentId,
  type ThreadId,
  type WorkjetMailboxDelegateTaskRpcInput,
  type WorkjetMailboxSendHandoffRpcInput,
  type WorkjetMailboxSendMessageRpcInput,
  type WorkjetMeshPeerBinding,
  type WorkjetMeshRoster,
  type WorkjetMeshRosterPeer,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { SendHorizonalIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * "Nachricht" versus "Nachricht + Auftrag" for an ORCHESTRATOR thread
 * (docs/workjet-plan.md → Wave 5 thread UI).
 *
 * The panel is the composer's send half of the durable Workjet mailbox. Every
 * bound below is the WIRE bound restated as an input constraint, so the field
 * refuses what the contract would refuse rather than letting the user discover
 * it from a rejected RPC. Reply, review, cancel and reassign are later slices;
 * nothing here pretends to offer them.
 *
 * A third mode, "Hand off", sends this thread's BOUNDED CONTEXT SNAPSHOT to
 * another machine, which continues it in a NEW thread. It differs from the
 * other two in one structural way the form has to reflect: a handoff addresses
 * a MACHINE, never a thread, because the receiving side has no thread yet. The
 * snapshot itself is never composed here — the server builds it from its own
 * projection, so this panel offers a note and nothing that could pretend to
 * choose what travels.
 */

export const WORKJET_MESSAGE_MAX_LENGTH = 4_096;
export const WORKJET_NON_GOALS_MAX_LENGTH = 4_096;
export const WORKJET_ACCEPTANCE_MAX_LENGTH = 8_192;
export const WORKJET_PROMPT_MAX_LENGTH = WORKJET_MAILBOX_RPC_PROMPT_MAX_LENGTH;
export const WORKJET_SCOPE_MAX_FILES = 256;
export const WORKJET_MIN_TTL_SECONDS = WORKJET_MAILBOX_RPC_MIN_TTL_SECONDS;
export const WORKJET_MAX_TTL_SECONDS = WORKJET_MAILBOX_RPC_MAX_TTL_SECONDS;

export const WORKJET_HANDOFF_NOTE_MAX_LENGTH = 4_096;

export type WorkjetSendTab = "message" | "task" | "handoff";
/**
 * A recipient is either a thread on THIS server, picked from the threads the
 * client already knows, or a bare environment id for a machine the mesh has
 * not delivered to yet. The second case is deliberately free text: this client
 * has no directory of another machine's threads.
 */
export type WorkjetRecipientMode = "thread" | "environment";

export interface WorkjetSendDraft {
  readonly tab: WorkjetSendTab;
  readonly recipientMode: WorkjetRecipientMode;
  readonly targetThreadId: string;
  readonly targetEnvironmentId: string;
  readonly message: string;
  readonly prompt: string;
  readonly scopeFiles: string;
  readonly nonGoals: string;
  readonly acceptance: string;
  /** Operator note carried with a handoff. The snapshot carries the context. */
  readonly handoffNote: string;
  readonly maxDepth: number;
  readonly maxReviewRounds: number;
  readonly ttlSeconds: number;
}

export const EMPTY_WORKJET_SEND_DRAFT: WorkjetSendDraft = {
  tab: "message",
  recipientMode: "thread",
  targetThreadId: "",
  targetEnvironmentId: "",
  message: "",
  prompt: "",
  scopeFiles: "",
  nonGoals: "",
  acceptance: "",
  handoffNote: "",
  maxDepth: 2,
  maxReviewRounds: 1,
  ttlSeconds: 3_600,
};

const isRepositoryPath = Schema.is(WorkjetRepositoryPath);

export interface WorkjetScopeParseResult {
  readonly files: ReadonlyArray<string>;
  /** Lines the repository-path contract refuses: absolute, traversing, or backslashed. */
  readonly invalid: ReadonlyArray<string>;
}

/**
 * One path per line. Blank lines are ignored rather than reported: a trailing
 * newline is how a textarea normally ends, not a mistake worth an error.
 */
export function parseWorkjetScopeFiles(input: string): WorkjetScopeParseResult {
  const files: string[] = [];
  const invalid: string[] = [];
  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (isRepositoryPath(line)) {
      if (!files.includes(line)) files.push(line);
    } else {
      invalid.push(line);
    }
  }
  return { files, invalid };
}

export type WorkjetSendFieldError =
  | "recipient-thread-required"
  | "recipient-environment-required"
  | "recipient-remote-thread-required"
  | "message-required"
  | "message-too-long"
  | "prompt-required"
  | "prompt-too-long"
  | "scope-required"
  | "scope-invalid-path"
  | "scope-too-many"
  | "acceptance-required"
  | "acceptance-too-long"
  | "handoff-note-too-long"
  | "non-goals-required"
  | "non-goals-too-long"
  | "budget-depth-out-of-range"
  | "budget-review-rounds-out-of-range"
  | "budget-ttl-out-of-range";

export const WORKJET_SEND_FIELD_ERROR_MESSAGES: Record<WorkjetSendFieldError, string> = {
  "recipient-thread-required": "Pick a thread on this machine.",
  "recipient-environment-required": "Enter the target environment id.",
  "recipient-remote-thread-required": "Enter the thread id on the other machine.",
  "message-required": "Write a message.",
  "message-too-long": `A message is at most ${WORKJET_MESSAGE_MAX_LENGTH} characters.`,
  "prompt-required": "Write the task prompt.",
  "prompt-too-long": `A prompt is at most ${WORKJET_PROMPT_MAX_LENGTH} characters.`,
  "scope-required": "List at least one repository-relative file.",
  "scope-invalid-path": "Scope paths are repository-relative: no leading / and no ..",
  "scope-too-many": `A scope holds at most ${WORKJET_SCOPE_MAX_FILES} files.`,
  "acceptance-required": "Write what finished means.",
  "acceptance-too-long": `Acceptance is at most ${WORKJET_ACCEPTANCE_MAX_LENGTH} characters.`,
  "handoff-note-too-long": `A handoff note is at most ${WORKJET_HANDOFF_NOTE_MAX_LENGTH} characters.`,
  "non-goals-required": "Write the non-goals.",
  "non-goals-too-long": `Non-goals are at most ${WORKJET_NON_GOALS_MAX_LENGTH} characters.`,
  "budget-depth-out-of-range": "Depth is between 1 and 16.",
  "budget-review-rounds-out-of-range": "Review rounds are between 0 and 16.",
  "budget-ttl-out-of-range": `A time-to-live is between ${WORKJET_MIN_TTL_SECONDS} and ${WORKJET_MAX_TTL_SECONDS} seconds.`,
};

const boundedProse = (value: string, maximum: number) => {
  const trimmed = value.trim();
  return { trimmed, empty: trimmed.length === 0, tooLong: trimmed.length > maximum };
};

/**
 * Every error the panel can raise, in field order. Returning the whole list —
 * rather than the first failure — is what lets the panel mark each field and
 * still keep the submit button honest.
 */
export function validateWorkjetSendDraft(
  draft: WorkjetSendDraft,
): ReadonlyArray<WorkjetSendFieldError> {
  const errors: WorkjetSendFieldError[] = [];
  // A handoff addresses a MACHINE: the receiving side creates the thread, so
  // there is no thread id to require and none to guess. "This machine" is a
  // legitimate handoff target — it takes the same local fast path.
  if (draft.tab === "handoff") {
    if (draft.recipientMode === "environment" && draft.targetEnvironmentId.trim().length === 0) {
      errors.push("recipient-environment-required");
    }
    const note = boundedProse(draft.handoffNote, WORKJET_HANDOFF_NOTE_MAX_LENGTH);
    // The note is optional: the snapshot is what carries the context, and
    // demanding prose the server does not need would be a fake requirement.
    if (!note.empty && note.tooLong) errors.push("handoff-note-too-long");
    return errors;
  }

  if (draft.recipientMode === "thread") {
    if (draft.targetThreadId.trim().length === 0) errors.push("recipient-thread-required");
  } else {
    if (draft.targetEnvironmentId.trim().length === 0) {
      errors.push("recipient-environment-required");
    }
    // A remote thread id cannot be picked from a list, so it must be typed —
    // and it must be typed EXPLICITLY. The old fallback (address the
    // environment id as the thread id) was a guess dressed as a default.
    if (draft.targetThreadId.trim().length === 0) {
      errors.push("recipient-remote-thread-required");
    }
  }

  const message = boundedProse(draft.message, WORKJET_MESSAGE_MAX_LENGTH);
  if (message.empty) errors.push("message-required");
  else if (message.tooLong) errors.push("message-too-long");

  if (draft.tab === "task") {
    const prompt = boundedProse(draft.prompt, WORKJET_PROMPT_MAX_LENGTH);
    if (prompt.empty) errors.push("prompt-required");
    else if (prompt.tooLong) errors.push("prompt-too-long");

    const scope = parseWorkjetScopeFiles(draft.scopeFiles);
    if (scope.invalid.length > 0) errors.push("scope-invalid-path");
    if (scope.files.length === 0) errors.push("scope-required");
    else if (scope.files.length > WORKJET_SCOPE_MAX_FILES) errors.push("scope-too-many");

    const nonGoals = boundedProse(draft.nonGoals, WORKJET_NON_GOALS_MAX_LENGTH);
    if (nonGoals.empty) errors.push("non-goals-required");
    else if (nonGoals.tooLong) errors.push("non-goals-too-long");

    const acceptance = boundedProse(draft.acceptance, WORKJET_ACCEPTANCE_MAX_LENGTH);
    if (acceptance.empty) errors.push("acceptance-required");
    else if (acceptance.tooLong) errors.push("acceptance-too-long");

    if (!Number.isInteger(draft.maxDepth) || draft.maxDepth < 1 || draft.maxDepth > 16) {
      errors.push("budget-depth-out-of-range");
    }
    if (
      !Number.isInteger(draft.maxReviewRounds) ||
      draft.maxReviewRounds < 0 ||
      draft.maxReviewRounds > 16
    ) {
      errors.push("budget-review-rounds-out-of-range");
    }
    if (
      !Number.isInteger(draft.ttlSeconds) ||
      draft.ttlSeconds < WORKJET_MIN_TTL_SECONDS ||
      draft.ttlSeconds > WORKJET_MAX_TTL_SECONDS
    ) {
      errors.push("budget-ttl-out-of-range");
    }
  }
  return errors;
}

export interface WorkjetSendTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * Resolve the recipient a draft names. A thread recipient lives on the active
 * environment; a remote recipient names another machine's environment and a
 * thread id typed by hand, because no cross-machine thread listing exists. The
 * thread id is used exactly as typed — the earlier fallback of addressing the
 * environment id as the thread id was a guess, and validation now requires the
 * real id instead. The envelope is stored and reported as queued either way.
 */
export function resolveWorkjetSendTarget(
  draft: WorkjetSendDraft,
  activeEnvironmentId: EnvironmentId,
): WorkjetSendTarget {
  return draft.recipientMode === "thread"
    ? {
        environmentId: activeEnvironmentId,
        threadId: draft.targetThreadId.trim() as ThreadId,
      }
    : {
        environmentId: draft.targetEnvironmentId.trim() as EnvironmentId,
        threadId: draft.targetThreadId.trim() as ThreadId,
      };
}

/**
 * The roster peers, as the picker orders them: most recently pinned FIRST.
 *
 * The server returns oldest-first (its pin table order); a picker wants the
 * machine you most recently started talking to at the top. This is the only
 * ordering claim the panel makes — `firstSeenAt` is first CONTACT, never a
 * liveness or "last active" signal, and the panel never renders it as one.
 */
export function orderWorkjetRosterPeers(
  roster: WorkjetMeshRoster | null | undefined,
): ReadonlyArray<WorkjetMeshRosterPeer> {
  if (!roster) return [];
  return [...roster.peers].sort((left, right) => right.firstSeenAt.localeCompare(left.firstSeenAt));
}

/**
 * What the mesh actually knows about WHOSE machine a peer entry is.
 *
 * This exists because `sealedDeliveryReady` reads like a security assurance and
 * is not one: it says a payload can be encrypted to a pinned key, not that the
 * key belongs to the machine that owns the environment id. Only the binding
 * level answers that, and both of its answers are qualified — neither says
 * "verified", because the mesh cannot yet make that claim about any peer.
 */
export function workjetPeerTrustLabel(binding: WorkjetMeshPeerBinding): string {
  return binding === "self-signed"
    ? "This peer signed for its own keys, so no other machine in the room could have substituted them. It is still the machine that claimed this environment id first."
    : "Keys pinned on first contact only, without a signed key binding. Trust here rests on CTOX room membership alone.";
}

/** `2026-08-18T10:00:00.000Z` → `2026-08-18`, the honest resolution for a pin date. */
export function formatWorkjetFirstContact(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/**
 * Address a roster peer. The remote THREAD id cannot be enumerated — no
 * cross-machine thread listing exists — so it is prefilled from the last id
 * used for that peer and otherwise left empty for the user to type.
 */
export function selectWorkjetRosterPeer(input: {
  readonly draft: WorkjetSendDraft;
  readonly environmentId: string;
  readonly rememberedThreadIds: Readonly<Record<string, string>> | undefined;
}): WorkjetSendDraft {
  return {
    ...input.draft,
    recipientMode: "environment",
    targetEnvironmentId: input.environmentId,
    targetThreadId: input.rememberedThreadIds?.[input.environmentId] ?? "",
  };
}

/**
 * Remember the thread id a draft names for its remote environment. Blank ids
 * are not recorded, so clearing the field does not erase a usable memory.
 */
export function rememberWorkjetRemoteThreadId(
  remembered: Readonly<Record<string, string>>,
  draft: WorkjetSendDraft,
): Readonly<Record<string, string>> {
  const environmentId = draft.targetEnvironmentId.trim();
  const threadId = draft.targetThreadId.trim();
  if (
    draft.recipientMode !== "environment" ||
    environmentId.length === 0 ||
    threadId.length === 0
  ) {
    return remembered;
  }
  if (remembered[environmentId] === threadId) return remembered;
  return { ...remembered, [environmentId]: threadId };
}

export function buildWorkjetSendMessageInput(input: {
  readonly draft: WorkjetSendDraft;
  readonly sourceThreadId: ThreadId;
  readonly activeEnvironmentId: EnvironmentId;
}): WorkjetMailboxSendMessageRpcInput {
  const target = resolveWorkjetSendTarget(input.draft, input.activeEnvironmentId);
  return {
    sourceThreadId: input.sourceThreadId,
    targetEnvironmentId: target.environmentId,
    targetThreadId: target.threadId,
    // The contract reserves `inline` for the same-environment fast path; the
    // server refuses an inline body bound for another machine, which is the
    // honest answer until a sealed cross-machine payload exists to carry it.
    body: { _tag: "inline", text: input.draft.message.trim() },
  };
}

export function buildWorkjetDelegateTaskInput(input: {
  readonly draft: WorkjetSendDraft;
  readonly sourceThreadId: ThreadId;
  readonly activeEnvironmentId: EnvironmentId;
}): WorkjetMailboxDelegateTaskRpcInput {
  const target = resolveWorkjetSendTarget(input.draft, input.activeEnvironmentId);
  const scope = parseWorkjetScopeFiles(input.draft.scopeFiles);
  return {
    sourceThreadId: input.sourceThreadId,
    targetEnvironmentId: target.environmentId,
    targetThreadId: target.threadId,
    prompt: input.draft.prompt.trim(),
    scope: {
      files: scope.files.map((file) => WorkjetRepositoryPath.make(file)),
      nonGoals: input.draft.nonGoals.trim(),
    },
    acceptance: input.draft.acceptance.trim(),
    budget: {
      maxDepth: input.draft.maxDepth,
      maxReviewRounds: input.draft.maxReviewRounds,
      ttlSeconds: input.draft.ttlSeconds,
    },
    ttlSeconds: input.draft.ttlSeconds,
  };
}

/**
 * The handoff send input. It carries a target MACHINE and an optional note —
 * and deliberately nothing else: no snapshot, no digest, no branch, no message
 * tail. Every one of those is composed server-side from the source thread's own
 * projection, which is what makes the digest describe bytes the server wrote.
 */
export function buildWorkjetSendHandoffInput(input: {
  readonly draft: WorkjetSendDraft;
  readonly sourceThreadId: ThreadId;
  readonly activeEnvironmentId: EnvironmentId;
}): WorkjetMailboxSendHandoffRpcInput {
  const targetEnvironmentId =
    input.draft.recipientMode === "environment"
      ? (input.draft.targetEnvironmentId.trim() as EnvironmentId)
      : input.activeEnvironmentId;
  const note = input.draft.handoffNote.trim();
  return {
    sourceThreadId: input.sourceThreadId,
    targetEnvironmentId,
    ...(note.length > 0 ? { note } : {}),
  };
}

const MAILBOX_FAILURE_REASONS: ReadonlySet<string> = new Set(WorkjetMailboxFailureReason.literals);

/**
 * The typed operation error, rendered as the contract's own bounded sentence.
 *
 * A mailbox failure is a bounded reason and nothing else — no prompt, no path,
 * no transport detail — so the panel reconstructs the error to read its
 * message rather than showing whatever a squashed cause happens to stringify
 * to. Anything that is not a mailbox error stays generic.
 */
export function workjetMailboxFailureMessage(error: unknown): string {
  const reason =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "WorkjetMailboxError" &&
    "reason" in error &&
    typeof error.reason === "string" &&
    MAILBOX_FAILURE_REASONS.has(error.reason)
      ? (error.reason as WorkjetMailboxFailureReason)
      : null;
  if (reason === null) return "The Workjet mailbox send failed.";
  return new WorkjetMailboxError({ reason }).message;
}

/** What the last submit produced, rendered inline under the form. */
export type WorkjetSendOutcome =
  | { readonly _tag: "acknowledged"; readonly envelopeId: string; readonly disposition: string }
  | { readonly _tag: "queued"; readonly envelopeId: string }
  | { readonly _tag: "error"; readonly message: string };

export interface WorkjetSendToWorkerPanelProps {
  readonly draft: WorkjetSendDraft;
  readonly threads: ReadonlyArray<{ readonly threadId: string; readonly title: string }>;
  /**
   * The mesh roster read (`workjet.mesh.roster`). `null` means the read has not
   * answered yet or is unavailable — the panel then falls back to the typed
   * environment id rather than pretending the mesh is empty.
   */
  readonly roster?: WorkjetMeshRoster | null;
  /** Last thread id used per remote environment. Panel-local memory only. */
  readonly rememberedThreadIds?: Readonly<Record<string, string>>;
  /**
   * Narrow-composer rendering. The control keeps its popover and every field
   * inside it; only the trigger collapses to an icon, exactly as the other
   * composer controls do once the footer runs out of width.
   */
  readonly compact?: boolean;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly outcome: WorkjetSendOutcome | null;
  readonly onDraftChange: (draft: WorkjetSendDraft) => void;
  readonly onSubmit: () => void;
}

const fieldClass =
  "w-full rounded-md border border-border/60 bg-background px-2 py-1 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70";

function ErrorNote({ error }: { readonly error: WorkjetSendFieldError | undefined }) {
  if (!error) return null;
  return (
    <p className="pt-0.5 text-[11px] text-destructive">
      {WORKJET_SEND_FIELD_ERROR_MESSAGES[error]}
    </p>
  );
}

export function WorkjetSendToWorkerPanelContent(props: WorkjetSendToWorkerPanelProps) {
  const { draft, threads, busy, outcome, onDraftChange, onSubmit } = props;
  const disabled = props.disabled === true || busy;
  const errors = validateWorkjetSendDraft(draft);
  const errorOf = (error: WorkjetSendFieldError) => (errors.includes(error) ? error : undefined);
  const patch = (next: Partial<WorkjetSendDraft>) => onDraftChange({ ...draft, ...next });
  const remoteRecipient = draft.recipientMode === "environment";
  // A handoff addresses a machine, so the thread pickers are not merely empty
  // here — they would be a question with no answer, and are removed.
  const handoffTab = draft.tab === "handoff";
  const peers = orderWorkjetRosterPeers(props.roster);
  // `undefined` means "not a roster peer", which is what reveals the free-text
  // environment field: a hand-typed id stays possible, because the roster only
  // knows machines this one has ALREADY exchanged mail with.
  const selectedPeer = peers.find(
    (peer) => peer.environmentId === draft.targetEnvironmentId.trim(),
  );

  return (
    <div className="flex w-full flex-col gap-2" data-workjet-send-panel={draft.tab}>
      <div className="flex items-center gap-1" role="tablist" aria-label="Workjet send mode">
        {(["message", "task", "handoff"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={draft.tab === tab}
            disabled={disabled}
            onClick={() => patch({ tab })}
            className={cn(
              "rounded-md px-2 py-1 text-[12px]",
              draft.tab === tab
                ? "bg-accent/60 font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/30",
            )}
          >
            {tab === "message" ? "Message" : tab === "task" ? "Message + Task" : "Hand off"}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          {(["thread", "environment"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={draft.recipientMode === mode}
              disabled={disabled}
              onClick={() => patch({ recipientMode: mode })}
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px]",
                draft.recipientMode === mode
                  ? "bg-accent/60 text-foreground"
                  : "text-muted-foreground hover:bg-accent/30",
              )}
            >
              {mode === "thread" ? "This machine" : "Another machine"}
            </button>
          ))}
        </div>
        {draft.recipientMode === "thread" ? (
          // A handoff to THIS machine needs no thread: the machine creates one.
          handoffTab ? null : (
          <select
            aria-label="Recipient thread"
            disabled={disabled}
            className={fieldClass}
            value={draft.targetThreadId}
            onChange={(event) => patch({ targetThreadId: event.target.value })}
          >
            <option value="">Select a thread…</option>
            {threads.map((thread) => (
              <option key={thread.threadId} value={thread.threadId}>
                {thread.title}
              </option>
            ))}
          </select>
          )
        ) : (
          <>
            {peers.length > 0 ? (
              <select
                aria-label="Remote environment"
                disabled={disabled}
                className={fieldClass}
                value={selectedPeer ? selectedPeer.environmentId : ""}
                onChange={(event) =>
                  onDraftChange(
                    event.target.value === ""
                      ? { ...draft, targetEnvironmentId: "", targetThreadId: "" }
                      : selectWorkjetRosterPeer({
                          draft,
                          environmentId: event.target.value,
                          rememberedThreadIds: props.rememberedThreadIds,
                        }),
                  )
                }
              >
                <option value="">Another environment id…</option>
                <optgroup label="Remote environments">
                  {peers.map((peer) => (
                    <option key={peer.environmentId} value={peer.environmentId}>
                      {`${peer.environmentId} · ${peer.workspaceId} · first contact ${formatWorkjetFirstContact(peer.firstSeenAt)}`}
                    </option>
                  ))}
                </optgroup>
              </select>
            ) : null}
            {selectedPeer === undefined ? (
              <input
                aria-label="Recipient environment id"
                placeholder="environment id"
                disabled={disabled}
                className={fieldClass}
                value={draft.targetEnvironmentId}
                onChange={(event) => patch({ targetEnvironmentId: event.target.value })}
              />
            ) : null}
            {handoffTab ? (
              <p className="text-[11px] text-muted-foreground">
                A handoff addresses the machine. The receiving side creates a new thread, so there
                is no thread id to enter.
              </p>
            ) : (
              <>
                <input
                  aria-label="Recipient thread id on the other machine"
                  placeholder="thread id"
                  disabled={disabled}
                  className={fieldClass}
                  value={draft.targetThreadId}
                  onChange={(event) => patch({ targetThreadId: event.target.value })}
                />
                <p className="text-[11px] text-muted-foreground">
                  This machine cannot list another machine&rsquo;s threads, so the thread id has to
                  be typed.
                </p>
              </>
            )}
          </>
        )}
        {handoffTab && draft.recipientMode === "thread" ? (
          <p className="text-[11px] text-muted-foreground">
            This machine will create a new thread from the snapshot.
          </p>
        ) : null}
        <ErrorNote error={errorOf("recipient-thread-required")} />
        <ErrorNote error={errorOf("recipient-environment-required")} />
        <ErrorNote error={errorOf("recipient-remote-thread-required")} />
        {remoteRecipient && peers.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {props.roster
              ? "This machine has not exchanged mail with any peer yet."
              : "The mesh roster is not available yet."}
          </p>
        ) : null}
        {remoteRecipient && props.roster?.truncated === true ? (
          <p className="text-[11px] text-muted-foreground">
            More peers are pinned than this list shows.
          </p>
        ) : null}
        {selectedPeer ? (
          <>
            <p className="text-[11px] text-muted-foreground">
              {selectedPeer.sealedDeliveryReady
                ? "This peer's encryption key is pinned, so the payload is sealed."
                : "No encryption key pinned yet, so the first envelope travels unsealed inside the CTOX room."}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {workjetPeerTrustLabel(selectedPeer.binding)}
            </p>
          </>
        ) : null}
        {remoteRecipient ? (
          <p className="text-[11px] text-muted-foreground">Queued until the mesh delivers.</p>
        ) : null}
      </div>

      {handoffTab ? (
        <div className="flex flex-col gap-0.5">
          <textarea
            aria-label="Handoff note"
            rows={3}
            placeholder="Optional note for whoever continues this"
            maxLength={WORKJET_HANDOFF_NOTE_MAX_LENGTH}
            disabled={disabled}
            className={fieldClass}
            value={draft.handoffNote}
            onChange={(event) => patch({ handoffNote: event.target.value })}
          />
          <ErrorNote error={errorOf("handoff-note-too-long")} />
          <p className="text-[11px] text-muted-foreground">
            A bounded context snapshot is composed on this machine: the thread title, its branch,
            and the most recent messages. The full history stays here and is not copied.
          </p>
          <p className="text-[11px] text-muted-foreground">
            No branch is pushed. The snapshot names the branch so it can be fetched deliberately.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <textarea
            aria-label="Message"
            rows={3}
            maxLength={WORKJET_MESSAGE_MAX_LENGTH}
            disabled={disabled}
            className={fieldClass}
            value={draft.message}
            onChange={(event) => patch({ message: event.target.value })}
          />
          <ErrorNote error={errorOf("message-required")} />
          <ErrorNote error={errorOf("message-too-long")} />
        </div>
      )}

      {draft.tab === "task" ? (
        <>
          <div className="flex flex-col gap-0.5">
            <textarea
              aria-label="Task prompt"
              rows={4}
              maxLength={WORKJET_PROMPT_MAX_LENGTH}
              disabled={disabled}
              className={fieldClass}
              value={draft.prompt}
              onChange={(event) => patch({ prompt: event.target.value })}
            />
            <ErrorNote error={errorOf("prompt-required")} />
            <ErrorNote error={errorOf("prompt-too-long")} />
          </div>
          <div className="flex flex-col gap-0.5">
            <textarea
              aria-label="Scope files, one per line"
              rows={3}
              placeholder={"packages/contracts/src/rpc.ts\napps/server/src/ws.ts"}
              disabled={disabled}
              className={cn(fieldClass, "font-mono text-[11px]")}
              value={draft.scopeFiles}
              onChange={(event) => patch({ scopeFiles: event.target.value })}
            />
            <ErrorNote error={errorOf("scope-required")} />
            <ErrorNote error={errorOf("scope-invalid-path")} />
            <ErrorNote error={errorOf("scope-too-many")} />
          </div>
          <div className="flex flex-col gap-0.5">
            <textarea
              aria-label="Non-goals"
              rows={2}
              maxLength={WORKJET_NON_GOALS_MAX_LENGTH}
              disabled={disabled}
              className={fieldClass}
              value={draft.nonGoals}
              onChange={(event) => patch({ nonGoals: event.target.value })}
            />
            <ErrorNote error={errorOf("non-goals-required")} />
            <ErrorNote error={errorOf("non-goals-too-long")} />
          </div>
          <div className="flex flex-col gap-0.5">
            <textarea
              aria-label="Acceptance"
              rows={2}
              maxLength={WORKJET_ACCEPTANCE_MAX_LENGTH}
              disabled={disabled}
              className={fieldClass}
              value={draft.acceptance}
              onChange={(event) => patch({ acceptance: event.target.value })}
            />
            <ErrorNote error={errorOf("acceptance-required")} />
            <ErrorNote error={errorOf("acceptance-too-long")} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
              Depth
              <input
                aria-label="Maximum delegation depth"
                type="number"
                min={1}
                max={16}
                step={1}
                disabled={disabled}
                className={fieldClass}
                value={draft.maxDepth}
                onChange={(event) => patch({ maxDepth: Number(event.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
              Reviews
              <input
                aria-label="Maximum review rounds"
                type="number"
                min={0}
                max={16}
                step={1}
                disabled={disabled}
                className={fieldClass}
                value={draft.maxReviewRounds}
                onChange={(event) => patch({ maxReviewRounds: Number(event.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
              TTL (s)
              <input
                aria-label="Time to live in seconds"
                type="number"
                min={WORKJET_MIN_TTL_SECONDS}
                max={WORKJET_MAX_TTL_SECONDS}
                step={1}
                disabled={disabled}
                className={fieldClass}
                value={draft.ttlSeconds}
                onChange={(event) => patch({ ttlSeconds: Number(event.target.value) })}
              />
            </label>
          </div>
          <ErrorNote error={errorOf("budget-depth-out-of-range")} />
          <ErrorNote error={errorOf("budget-review-rounds-out-of-range")} />
          <ErrorNote error={errorOf("budget-ttl-out-of-range")} />
        </>
      ) : null}

      <button
        type="button"
        disabled={disabled || errors.length > 0}
        onClick={onSubmit}
        className="self-end rounded-md border border-border/60 bg-card px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-accent/50 disabled:opacity-50"
      >
        {busy
          ? handoffTab
            ? "Handing off…"
            : "Sending…"
          : handoffTab
            ? "Hand off"
            : draft.tab === "task"
              ? "Send task"
              : "Send message"}
      </button>

      {outcome ? (
        <p
          data-workjet-send-outcome={outcome._tag}
          className={cn(
            "text-[11px]",
            outcome._tag === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {outcome._tag === "error"
            ? outcome.message
            : outcome._tag === "queued"
              ? `Queued as ${outcome.envelopeId}.`
              : `Delivered as ${outcome.envelopeId} (${outcome.disposition}).`}
        </p>
      ) : null}
    </div>
  );
}

export function WorkjetSendToWorkerPanel(props: WorkjetSendToWorkerPanelProps) {
  // Panel-local memory of the last thread id used per remote environment. It is
  // deliberately NOT persisted: a thread id on another machine is a guess this
  // client cannot verify, so remembering it beyond the session would dress a
  // stale guess up as a known address.
  const [rememberedThreadIds, setRememberedThreadIds] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const { onDraftChange } = props;
  const handleDraftChange = useCallback(
    (next: WorkjetSendDraft) => {
      setRememberedThreadIds((remembered) => rememberWorkjetRemoteThreadId(remembered, next));
      onDraftChange(next);
    },
    [onDraftChange],
  );
  return WorkjetSendToWorkerPanelControl({
    ...props,
    rememberedThreadIds: props.rememberedThreadIds ?? rememberedThreadIds,
    onDraftChange: handleDraftChange,
  });
}

/**
 * The composer control itself: a trigger plus the popover that holds the whole
 * panel. It is hook-free and deliberately separate from the stateful wrapper
 * above, so the two variants can be inspected as plain values.
 */
export function WorkjetSendToWorkerPanelControl(props: WorkjetSendToWorkerPanelProps) {
  const content = props;
  const compact = props.compact === true;

  return (
    <Popover>
      <PopoverTrigger
        disabled={props.disabled === true}
        data-workjet-send-control-compact={compact ? "true" : "false"}
        render={
          <ComposerControl
            type="button"
            className={compact ? "shrink-0 px-2" : "shrink-0 whitespace-nowrap"}
            aria-label="Send to worker"
          />
        }
      >
        <ComposerControlIcon icon={SendHorizonalIcon} />
        {/*
         * Compact keeps the accessible name and drops only the visible one, so
         * the control never becomes an unlabelled icon for a screen reader.
         */}
        <span className={compact ? "sr-only" : "sr-only sm:not-sr-only"}>Send to worker</span>
      </PopoverTrigger>
      <PopoverPopup align="start" className={compact ? "w-80" : "w-96"}>
        <WorkjetSendToWorkerPanelContent {...content} />
      </PopoverPopup>
    </Popover>
  );
}
