import { useCallback, useState } from "react";
import {
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
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  EllipsisIcon,
  SendHorizonalIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { getProjectFilePickerMatches } from "../files/ProjectFilePicker.logic";
import { useProjectFilePickerQuery } from "../files/projectFilesQueryState";

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
  "recipient-thread-required": "Empfänger wählen",
  "recipient-environment-required": "Rechner wählen",
  "recipient-remote-thread-required": "Für diesen Rechner nur Übergabe",
  "message-required": "Nachricht fehlt",
  "message-too-long": `Höchstens ${WORKJET_MESSAGE_MAX_LENGTH} Zeichen`,
  "prompt-required": "Auftrag fehlt",
  "prompt-too-long": `Auftrag höchstens ${WORKJET_PROMPT_MAX_LENGTH} Zeichen`,
  "scope-required": "Mindestens eine Datei angeben",
  "scope-invalid-path": "Dateien relativ zum Repo angeben",
  "scope-too-many": `Höchstens ${WORKJET_SCOPE_MAX_FILES} Dateien`,
  "acceptance-required": "Abnahme fehlt",
  "acceptance-too-long": `Abnahme höchstens ${WORKJET_ACCEPTANCE_MAX_LENGTH} Zeichen`,
  "handoff-note-too-long": `Notiz höchstens ${WORKJET_HANDOFF_NOTE_MAX_LENGTH} Zeichen`,
  "non-goals-required": "Nicht-Ziele fehlen",
  "non-goals-too-long": `Nicht-Ziele höchstens ${WORKJET_NON_GOALS_MAX_LENGTH} Zeichen`,
  "budget-depth-out-of-range": "Tiefe zwischen 1 und 16",
  "budget-review-rounds-out-of-range": "Prüfrunden zwischen 0 und 16",
  "budget-ttl-out-of-range": "Laufzeit außerhalb des Rahmens",
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
  return binding === "self-signed" ? "selbst signiert" : "beim Erstkontakt gepinnt";
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
 * Deutsche Statuszeile je Mailbox-Grund. Der Vertrag liefert englische Sätze;
 * die Oberfläche zeigt eine kurze deutsche Zeile (höchstens 12 Wörter).
 */
const WORKJET_MAILBOX_FAILURE_TEXT: Readonly<Record<WorkjetMailboxFailureReason, string>> = {
  unauthorized: "Nicht berechtigt",
  "unknown-target": "Empfänger unbekannt",
  "target-thread-deleted": "Unterhaltung gibt es nicht mehr",
  "target-offline": "Empfänger getrennt",
  "malformed-envelope": "Nachricht ungültig",
  "invalid-signature": "Signatur ungültig",
  "duplicate-envelope": "Bereits zugestellt",
  "payload-too-large": "Nachricht zu groß",
  "envelope-expired": "Vor Zustellung abgelaufen",
  "delegation-expired": "Auftrag abgelaufen",
  "depth-exceeded": "Tiefe ausgeschöpft",
  "review-rounds-exceeded": "Prüfrunden ausgeschöpft",
  "token-budget-exceeded": "Token-Budget ausgeschöpft",
  "cost-budget-exceeded": "Kostenbudget ausgeschöpft",
  "handoff-snapshot-unavailable": "Übergabe auf diesem Rechner nicht verfügbar",
  "invalid-state-transition": "Statuswechsel nicht erlaubt",
  "version-skew": "Gegenstelle hat eine andere Version",
  "transport-unavailable": "Verbindung nicht verfügbar",
  "mailbox-unavailable": "Postfach nicht verfügbar",
  cancelled: "Abgebrochen",
};

/**
 * The typed operation error, rendered as a short German status line.
 *
 * A mailbox failure is a bounded reason and nothing else — no prompt, no path,
 * no transport detail — so the panel reads the reason rather than showing
 * whatever a squashed cause happens to stringify to. Anything that is not a
 * mailbox error stays generic.
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
  if (reason === null) return "Senden fehlgeschlagen";
  return WORKJET_MAILBOX_FAILURE_TEXT[reason];
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
   * answered yet or is unavailable — other computers are then simply not listed.
   */
  readonly roster?: WorkjetMeshRoster | null;
  /** Last thread id used per remote environment. Panel-local memory only. */
  readonly rememberedThreadIds?: Readonly<Record<string, string>>;
  /**
   * Anzeigenamen der Rechner je environmentId (z. B. aus den Einstellungen →
   * Rechner). Ohne Namen zeigt der Empfänger „—“, nie eine gekürzte ID.
   */
  readonly computerLabels?: Readonly<Record<string, string>> | undefined;
  /** Kept for callers; the inline row has one layout at every width. */
  readonly compact?: boolean;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly outcome: WorkjetSendOutcome | null;
  readonly onDraftChange: (draft: WorkjetSendDraft) => void;
  readonly onSubmit: () => void;
  /** Schließt die Inline-Zeile. */
  readonly onClose?: (() => void) | undefined;
  /**
   * Projekt, aus dem die Dateien des Auftrags gewählt werden (wie die
   * @-Erwähnung). Ohne Projekt bleibt die Dateiwahl aus.
   */
  readonly fileSource?: { readonly environmentId: EnvironmentId; readonly cwd: string } | null;
}

/**
 * Sichtbarer Name eines anderen Rechners aus dem Mesh: der Anzeigename des
 * Rechners, sonst „Rechner ohne Namen“. Nie die (gekürzte) environmentId.
 */
export function workjetPeerLabel(
  peer: WorkjetMeshRosterPeer,
  computerLabels?: Readonly<Record<string, string>> | undefined,
): string {
  const label = computerLabels?.[peer.environmentId]?.trim();
  return label !== undefined && label.length > 0 ? label : "Rechner ohne Namen";
}

const HERE_RECIPIENT = "here";

/** Der Wert des Empfänger-Dropdowns für einen Entwurf. */
export function workjetSendRecipientValue(draft: WorkjetSendDraft): string {
  if (draft.recipientMode === "environment") {
    const environmentId = draft.targetEnvironmentId.trim();
    return environmentId.length > 0 ? `peer:${environmentId}` : "";
  }
  if (draft.tab === "handoff") return HERE_RECIPIENT;
  const threadId = draft.targetThreadId.trim();
  return threadId.length > 0 ? `thread:${threadId}` : "";
}

export interface WorkjetSendRecipientChoice {
  readonly value: string;
  readonly label: string;
  readonly meta: string | null;
  readonly group: "local" | "peer";
  /** Kurzer Grund, warum der Eintrag nicht wählbar ist. */
  readonly disabledReason: string | null;
}

/**
 * Alle Empfänger als Auswahl, nie als Eingabefeld: Chats dieses Rechners und
 * bekannte andere Rechner aus dem Mesh. Eine Thread-ID auf einem anderen
 * Rechner kann hier niemand auflisten; ohne gemerkte ID ist dorthin daher nur
 * die Übergabe möglich.
 */
export function workjetSendRecipientChoices(
  props: Pick<
    WorkjetSendToWorkerPanelProps,
    "draft" | "threads" | "roster" | "rememberedThreadIds" | "computerLabels"
  >,
): ReadonlyArray<WorkjetSendRecipientChoice> {
  const handoff = props.draft.tab === "handoff";
  const local: WorkjetSendRecipientChoice[] = handoff
    ? [
        {
          value: HERE_RECIPIENT,
          label: "Hier, neuer Chat",
          meta: null,
          group: "local",
          disabledReason: null,
        },
      ]
    : props.threads.map((thread) => ({
        value: `thread:${thread.threadId}`,
        label: thread.title,
        meta: null,
        group: "local" as const,
        disabledReason: null,
      }));
  const peers = orderWorkjetRosterPeers(props.roster).map((peer) => {
    const reachable = handoff || props.rememberedThreadIds?.[peer.environmentId] !== undefined;
    return {
      value: `peer:${peer.environmentId}`,
      label: workjetPeerLabel(peer, props.computerLabels),
      meta: reachable ? workjetPeerTrustLabel(peer.binding) : "nur Übergabe",
      group: "peer" as const,
      disabledReason: reachable ? null : "nur Übergabe",
    };
  });
  return [...local, ...peers];
}

/** Den Entwurf auf einen gewählten Empfänger setzen. */
export function applyWorkjetSendRecipient(input: {
  readonly draft: WorkjetSendDraft;
  readonly value: string;
  readonly rememberedThreadIds?: Readonly<Record<string, string>> | undefined;
}): WorkjetSendDraft {
  if (input.value === HERE_RECIPIENT) {
    return { ...input.draft, recipientMode: "thread", targetEnvironmentId: "" };
  }
  if (input.value.startsWith("thread:")) {
    return {
      ...input.draft,
      recipientMode: "thread",
      targetEnvironmentId: "",
      targetThreadId: input.value.slice("thread:".length),
    };
  }
  if (input.value.startsWith("peer:")) {
    return selectWorkjetRosterPeer({
      draft: input.draft,
      environmentId: input.value.slice("peer:".length),
      rememberedThreadIds: input.rememberedThreadIds,
    });
  }
  return input.draft;
}

/** Art des Sendens als Menü-Auswahl; ein Wechsel nimmt die Nachricht mit. */
export function setWorkjetSendTab(draft: WorkjetSendDraft, tab: WorkjetSendTab): WorkjetSendDraft {
  if (draft.tab === tab) return draft;
  if (tab === "task") return { ...draft, tab, prompt: draft.message };
  if (tab === "handoff") {
    return {
      ...draft,
      tab,
      handoffNote: draft.handoffNote.length > 0 ? draft.handoffNote : draft.message,
    };
  }
  return { ...draft, tab };
}

const WORKJET_SEND_TAB_LABELS: Record<WorkjetSendTab, string> = {
  message: "Nachricht",
  task: "Auftrag",
  handoff: "Übergabe",
};

export const WORKJET_SEND_TTL_PRESETS: ReadonlyArray<{
  readonly seconds: number;
  readonly label: string;
}> = [
  { seconds: 3_600, label: "1 Std." },
  { seconds: 4 * 3_600, label: "4 Std." },
  { seconds: 24 * 3_600, label: "1 Tag" },
  { seconds: 7 * 24 * 3_600, label: "7 Tage" },
].filter(
  (preset) =>
    preset.seconds >= WORKJET_MIN_TTL_SECONDS && preset.seconds <= WORKJET_MAX_TTL_SECONDS,
);

/** Scope-Dateien: im Entwurf zeilenweise, im Feld kommagetrennt. */
function scopeFileList(scopeFiles: string): string[] {
  return scopeFiles
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const SCOPE_FILE_PICKER_LIMIT = 6;

/**
 * Dateien des Auftrags werden ausgewählt, nicht getippt (UI-Vertrag §3): die
 * Suche fragt den Projektindex wie die @-Erwähnung, ein Klick fügt die Datei
 * als Chip hinzu.
 */
function WorkjetScopeFilePicker(props: {
  readonly source: { readonly environmentId: EnvironmentId; readonly cwd: string };
  readonly scopeFiles: string;
  readonly disabled: boolean;
  readonly onChange: (scopeFiles: string) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = scopeFileList(props.scopeFiles);
  const search = useProjectFilePickerQuery(
    props.source.environmentId,
    props.source.cwd,
    query,
    SCOPE_FILE_PICKER_LIMIT * 4,
  );
  const matches =
    query.trim().length === 0
      ? []
      : getProjectFilePickerMatches(search.entries, search.matchedQuery ?? query)
          .filter((match) => !selected.includes(match.path))
          .slice(0, SCOPE_FILE_PICKER_LIMIT);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-workjet-send-scope-files="true">
      {selected.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1">
          {selected.map((path) => (
            <span
              key={path}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-background/60 ps-1.5 text-[11px]"
            >
              <span className="min-w-0 truncate">{path}</span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`${path} entfernen`}
                title={`${path} entfernen`}
                disabled={props.disabled}
                onClick={() => props.onChange(selected.filter((entry) => entry !== path).join("\n"))}
              >
                <XIcon aria-hidden="true" className="size-3" />
              </Button>
            </span>
          ))}
        </div>
      ) : null}
      <Input
        size="sm"
        aria-label="Datei suchen"
        placeholder="Datei suchen"
        disabled={props.disabled}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {matches.length > 0 ? (
        <div role="listbox" aria-label="Dateien" className="flex flex-col rounded-md border">
          {matches.map((match) => (
            <button
              key={match.path}
              type="button"
              role="option"
              aria-selected={false}
              disabled={props.disabled}
              className="min-w-0 truncate px-2 py-1 text-left text-[12px] hover:bg-accent"
              onClick={() => {
                props.onChange([...selected, match.path].join("\n"));
                setQuery("");
              }}
            >
              {match.path}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function outcomeText(outcome: WorkjetSendOutcome): string {
  switch (outcome._tag) {
    case "error":
      return outcome.message;
    case "queued":
      return "In Warteschlange";
    case "acknowledged":
      return "Zugestellt";
  }
}

/**
 * „An Worker senden“ als Inline-Zeile über dem Composer: Empfänger-Dropdown,
 * Nachricht, „Senden“. Seltenes (Art, Laufzeit, Prüfrunden, Tiefe) steckt im
 * ⋯-Menü mit Standardwerten. Kein Popover, keine getippten IDs.
 */
export function WorkjetSendToWorkerPanelContent(props: WorkjetSendToWorkerPanelProps) {
  const { draft, busy, outcome, onDraftChange, onSubmit } = props;
  const disabled = props.disabled === true || busy;
  const errors = validateWorkjetSendDraft(draft);
  const patch = (next: Partial<WorkjetSendDraft>) => onDraftChange({ ...draft, ...next });
  const handoff = draft.tab === "handoff";
  const task = draft.tab === "task";
  const choices = workjetSendRecipientChoices(props);
  const recipientValue = workjetSendRecipientValue(draft);
  const selectedChoice = choices.find((choice) => choice.value === recipientValue) ?? null;
  const localChoices = choices.filter((choice) => choice.group === "local");
  const peerChoices = choices.filter((choice) => choice.group === "peer");
  const touched =
    draft.message.trim().length > 0 ||
    draft.handoffNote.trim().length > 0 ||
    recipientValue.length > 0;
  const firstError = errors[0];
  const status =
    outcome !== null
      ? { text: outcomeText(outcome), tone: outcome._tag === "error" ? "error" : "neutral" }
      : touched && firstError !== undefined
        ? { text: WORKJET_SEND_FIELD_ERROR_MESSAGES[firstError], tone: "neutral" }
        : null;
  const submitLabel = busy
    ? handoff
      ? "Übergibt…"
      : "Sendet…"
    : handoff
      ? "Übergeben"
      : task
        ? "Auftrag senden"
        : "Senden";

  return (
    <div
      className="@container/send-panel flex w-full min-w-0 flex-col gap-2 rounded-lg border bg-card/40 p-2"
      data-workjet-send-panel={draft.tab}
    >
      {/* Schmal (420 px): Empfänger und Aktionen in einer Zeile, Text darunter über volle Breite. */}
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <Menu>
          <MenuTrigger
            disabled={disabled}
            render={
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-w-0 max-w-56 shrink-0"
                aria-label="Empfänger"
              />
            }
          >
            <UserRoundIcon aria-hidden="true" />
            <span className="min-w-0 truncate">{selectedChoice?.label ?? "Empfänger"}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-70" />
          </MenuTrigger>
          <MenuPopup align="start" side="top" className="max-h-80 min-w-56 max-w-80">
            <MenuRadioGroup
              value={recipientValue}
              onValueChange={(value) => {
                if (typeof value !== "string" || value.length === 0) return;
                onDraftChange(
                  applyWorkjetSendRecipient({
                    draft,
                    value,
                    rememberedThreadIds: props.rememberedThreadIds,
                  }),
                );
              }}
            >
              {localChoices.length > 0 ? (
                <MenuGroup>
                  <MenuGroupLabel>Dieser Rechner</MenuGroupLabel>
                  {localChoices.map((choice) => (
                    <MenuRadioItem key={choice.value} value={choice.value} closeOnClick>
                      <span className="block min-w-0 truncate">{choice.label}</span>
                    </MenuRadioItem>
                  ))}
                </MenuGroup>
              ) : (
                <p role="status" className="px-2 py-1.5 text-muted-foreground text-xs">
                  Keine Chats
                </p>
              )}
              {peerChoices.length > 0 ? (
                <MenuGroup>
                  <MenuGroupLabel>Andere Rechner</MenuGroupLabel>
                  {peerChoices.map((choice) => (
                    <MenuRadioItem
                      key={choice.value}
                      value={choice.value}
                      disabled={choice.disabledReason !== null}
                      closeOnClick
                    >
                      <span className="flex min-w-0 items-baseline">
                        <span className="min-w-0 truncate">{choice.label}</span>
                        {choice.meta ? (
                          <span className="ms-auto shrink-0 ps-3 text-muted-foreground text-xs">
                            {choice.meta}
                          </span>
                        ) : null}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuGroup>
              ) : null}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        <Textarea
          rows={1}
          size="sm"
          className="order-last min-w-0 basis-full @[36rem]/send-panel:order-none @[36rem]/send-panel:min-w-40 @[36rem]/send-panel:flex-1 @[36rem]/send-panel:basis-0"
          aria-label={handoff ? "Notiz" : "Nachricht"}
          placeholder={handoff ? "Notiz (optional)" : "Nachricht"}
          maxLength={handoff ? WORKJET_HANDOFF_NOTE_MAX_LENGTH : WORKJET_MESSAGE_MAX_LENGTH}
          disabled={disabled}
          value={handoff ? draft.handoffNote : draft.message}
          onChange={(event) =>
            handoff
              ? patch({ handoffNote: event.target.value })
              : patch({
                  message: event.target.value,
                  ...(task ? { prompt: event.target.value } : {}),
                })
          }
        />
        <div className="ms-auto flex shrink-0 items-center gap-1">
          <Menu>
            <MenuTrigger
              disabled={disabled}
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Weitere Optionen"
                  title="Weitere Optionen"
                />
              }
            >
              <EllipsisIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end" side="top" className="min-w-48">
              <MenuGroup>
                <MenuGroupLabel>Art</MenuGroupLabel>
                <MenuRadioGroup
                  value={draft.tab}
                  onValueChange={(value) => {
                    if (value === "message" || value === "task" || value === "handoff") {
                      onDraftChange(setWorkjetSendTab(draft, value));
                    }
                  }}
                >
                  {(["message", "task", "handoff"] as const).map((tab) => (
                    <MenuRadioItem key={tab} value={tab}>
                      {WORKJET_SEND_TAB_LABELS[tab]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
              {task ? (
                <>
                  <MenuSeparator />
                  <MenuSub>
                    <MenuSubTrigger>
                      Laufzeit
                      <span className="ms-auto ps-3 text-muted-foreground text-xs">
                        {WORKJET_SEND_TTL_PRESETS.find(
                          (preset) => preset.seconds === draft.ttlSeconds,
                        )?.label ?? `${draft.ttlSeconds} s`}
                      </span>
                    </MenuSubTrigger>
                    <MenuSubPopup>
                      <MenuRadioGroup
                        value={String(draft.ttlSeconds)}
                        onValueChange={(value) => patch({ ttlSeconds: Number(value) })}
                      >
                        {WORKJET_SEND_TTL_PRESETS.map((preset) => (
                          <MenuRadioItem key={preset.seconds} value={String(preset.seconds)}>
                            {preset.label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuSubPopup>
                  </MenuSub>
                  <MenuSub>
                    <MenuSubTrigger>
                      Prüfrunden
                      <span className="ms-auto ps-3 text-muted-foreground text-xs">
                        {draft.maxReviewRounds}
                      </span>
                    </MenuSubTrigger>
                    <MenuSubPopup>
                      <MenuRadioGroup
                        value={String(draft.maxReviewRounds)}
                        onValueChange={(value) => patch({ maxReviewRounds: Number(value) })}
                      >
                        {[0, 1, 2, 3].map((rounds) => (
                          <MenuRadioItem key={rounds} value={String(rounds)}>
                            {rounds}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuSubPopup>
                  </MenuSub>
                  <MenuSub>
                    <MenuSubTrigger>
                      Tiefe
                      <span className="ms-auto ps-3 text-muted-foreground text-xs">
                        {draft.maxDepth}
                      </span>
                    </MenuSubTrigger>
                    <MenuSubPopup>
                      <MenuRadioGroup
                        value={String(draft.maxDepth)}
                        onValueChange={(value) => patch({ maxDepth: Number(value) })}
                      >
                        {[1, 2, 3, 4].map((depth) => (
                          <MenuRadioItem key={depth} value={String(depth)}>
                            {depth}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuSubPopup>
                  </MenuSub>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
          <Button
            type="button"
            size="sm"
            disabled={disabled || errors.length > 0}
            onClick={onSubmit}
          >
            <SendHorizonalIcon aria-hidden="true" />
            {submitLabel}
          </Button>
          {props.onClose ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Schließen"
              title="Schließen"
              onClick={props.onClose}
            >
              <XIcon aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      {task ? (
        <div
          className="grid min-w-0 gap-2 @[36rem]/send-panel:grid-cols-3"
          data-workjet-send-task-fields="true"
        >
          {props.fileSource ? (
            <WorkjetScopeFilePicker
              source={props.fileSource}
              scopeFiles={draft.scopeFiles}
              disabled={disabled}
              onChange={(scopeFiles) => patch({ scopeFiles })}
            />
          ) : null}
          <Input
            size="sm"
            aria-label="Nicht-Ziele"
            placeholder="Nicht-Ziele"
            maxLength={WORKJET_NON_GOALS_MAX_LENGTH}
            disabled={disabled}
            value={draft.nonGoals}
            onChange={(event) => patch({ nonGoals: event.currentTarget.value })}
          />
          <Input
            size="sm"
            aria-label="Abnahme"
            placeholder="Abnahme"
            maxLength={WORKJET_ACCEPTANCE_MAX_LENGTH}
            disabled={disabled}
            value={draft.acceptance}
            onChange={(event) => patch({ acceptance: event.currentTarget.value })}
          />
        </div>
      ) : null}
      {status ? (
        <p
          role={status.tone === "error" ? "alert" : "status"}
          data-workjet-send-outcome={outcome?._tag}
          className={cn(
            "px-1 text-xs",
            status.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {status.text}
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
  return (
    <WorkjetSendToWorkerPanelContent
      {...props}
      rememberedThreadIds={props.rememberedThreadIds ?? rememberedThreadIds}
      onDraftChange={handleDraftChange}
    />
  );
}

/** Der Eintrag im Optionen-Menü des Composers, der die Inline-Zeile öffnet. */
export function WorkjetSendToWorkerMenuItem(props: {
  readonly disabled?: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <MenuItem disabled={props.disabled} onClick={props.onOpen}>
      <SendHorizonalIcon aria-hidden="true" />
      An Worker senden
    </MenuItem>
  );
}
