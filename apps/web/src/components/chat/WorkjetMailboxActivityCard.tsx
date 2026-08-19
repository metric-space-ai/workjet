import {
  WORKJET_TERMINAL_DELEGATION_STATES,
  WorkjetMailboxActivityPayload,
  type EnvironmentId,
  type ThreadId,
  type WorkjetDelegationId,
  type WorkjetDelegationState,
  type WorkjetDeliveryDisposition,
  type WorkjetMeshWorkspaceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CheckIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";

/**
 * The timeline face of the durable Workjet mailbox (docs/workjet-plan.md →
 * "Add thread UI for 'Nachricht' versus 'Nachricht + Auftrag' … delivery/state
 * badges, linked source/target navigation").
 *
 * The mailbox writes four thread activities — `workjet.message.sent|received`
 * and `workjet.delegation.sent|received` — whose payload is deliberately
 * redacted: ids, addresses, and lifecycle state only. This card renders exactly
 * that and nothing else, so the timeline cannot become a second place where
 * prompt or message text leaks.
 */

export const WORKJET_MAILBOX_ACTIVITY_KIND_SET: ReadonlySet<string> = new Set([
  "workjet.message.sent",
  "workjet.message.received",
  "workjet.delegation.sent",
  "workjet.delegation.received",
]);

export interface WorkjetMailboxCardModel {
  /** `task` whenever the envelope carried a delegation, `message` otherwise. */
  readonly kind: "message" | "task";
  readonly direction: "outbound" | "inbound";
  /** The OTHER end of the envelope: the target when outbound, the source when inbound. */
  readonly peerEnvironmentId: EnvironmentId;
  readonly peerThreadId: ThreadId;
  /**
   * True when the peer thread lives on this same environment, which is the only
   * case where the timeline can link to it. A cross-machine peer is named but
   * not linked: this client has no route to another machine's thread.
   */
  readonly peerIsLocal: boolean;
  readonly disposition: WorkjetDeliveryDisposition | null;
  readonly delegationState: WorkjetDelegationState | null;
  /**
   * The delegation this card refers to, when the envelope carried one. Only a
   * task card with a delegation id can offer lifecycle actions; a plain message
   * card has none.
   */
  readonly delegationId: WorkjetDelegationId | null;
  /**
   * The mesh workspace of the peer end. Actions that address the peer (reply,
   * request review) carry it so the target address is fully qualified.
   */
  readonly peerWorkspaceId: WorkjetMeshWorkspaceId;
}

const decodePayload = Schema.decodeUnknownOption(WorkjetMailboxActivityPayload);

/**
 * Decode one mailbox activity into what the card needs, or `null` when this is
 * not a mailbox activity (or carries a payload this build cannot read — a
 * version-skewed peer must degrade to no card, never to a crash).
 */
export function parseWorkjetMailboxActivity(
  kind: string,
  payload: unknown,
): WorkjetMailboxCardModel | null {
  if (!WORKJET_MAILBOX_ACTIVITY_KIND_SET.has(kind)) {
    return null;
  }
  const decoded = decodePayload(payload);
  if (Option.isNone(decoded)) {
    return null;
  }
  const value = decoded.value;
  const peer = value.direction === "outbound" ? value.target : value.source;
  const local = value.source.environmentId === value.target.environmentId;
  return {
    kind: kind.startsWith("workjet.delegation.") ? "task" : "message",
    direction: value.direction,
    peerEnvironmentId: peer.environmentId,
    peerThreadId: peer.threadId,
    peerIsLocal: local,
    disposition: value.disposition ?? null,
    delegationState: value.delegationState ?? null,
    delegationId: value.delegationId ?? null,
    peerWorkspaceId: peer.workspaceId,
  };
}

/**
 * `queued` is not a disposition — it is the ABSENCE of one. An envelope bound
 * for another machine never reaches an inbox that could answer, so the card
 * says "queued" rather than inventing an acknowledgement.
 */
export function dispositionBadgeLabel(disposition: WorkjetDeliveryDisposition | null): string {
  switch (disposition) {
    case "accepted-new":
      return "delivered";
    case "duplicate-ignored":
      return "duplicate ignored";
    case "expired":
      return "expired";
    case "rejected":
      return "rejected";
    case null:
      return "queued";
  }
}

const DISPOSITION_TONE: Record<string, string> = {
  delivered: "text-success",
  "duplicate ignored": "text-muted-foreground",
  expired: "text-destructive",
  rejected: "text-destructive",
  queued: "text-muted-foreground",
};

/**
 * Restrained lifecycle colouring over the EXACT contract literals. In-flight
 * work is the accent, success is green, every terminal failure is destructive,
 * and the two states that are waiting on a human are amber — the only three
 * distinctions a reader scanning a timeline actually acts on.
 */
export function delegationStateToneClass(state: WorkjetDelegationState): string {
  switch (state) {
    case "running":
    case "accepted":
      return "text-info";
    case "completed":
      return "text-success";
    case "failed":
    case "cancelled":
      return "text-destructive";
    case "expired":
      return "text-muted-foreground";
    case "needs-input":
    case "review-requested":
    case "changes-requested":
      return "text-warning";
    case "queued":
    case "delivered":
      return "text-muted-foreground";
  }
}

/** Enough of an opaque environment id to tell two machines apart, never more. */
export function shortEnvironmentId(environmentId: string): string {
  return environmentId.length <= 12 ? environmentId : `${environmentId.slice(0, 12)}…`;
}

// ===============================
// Delegation lifecycle actions
// ===============================

/**
 * The bounded lifecycle operations a delegation card can offer. `reply`,
 * `request-review`, and `cancel` are the delegating side's; `approve` and
 * `request-changes` are a reviewer's verdict on a review-requested delegation.
 */
export type WorkjetDelegationActionKind =
  | "reply"
  | "request-review"
  | "cancel"
  | "approve"
  | "request-changes";

/** The typed intent a card action emits, resolved against the card model. */
export type WorkjetDelegationAction =
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "request-review"; readonly round: number; readonly text: string }
  | { readonly kind: "cancel" }
  | { readonly kind: "approve"; readonly round: number }
  | {
      readonly kind: "request-changes";
      readonly round: number;
      readonly reasons: ReadonlyArray<string>;
    };

const TERMINAL_DELEGATION_STATE_SET: ReadonlySet<WorkjetDelegationState> = new Set(
  WORKJET_TERMINAL_DELEGATION_STATES,
);

/**
 * Which lifecycle actions a delegation card offers for its current state.
 *
 * - Reply is always available on a delegation card.
 * - Request review is offered only while the delegation is `running`.
 * - Cancel is offered while the delegation is non-terminal.
 * - Approve / Request changes are a reviewer's verdict, offered only on a
 *   `review-requested` delegation shown to a reviewer.
 *
 * A card without a delegation id (a plain message) offers nothing.
 */
export function availableDelegationActions(
  model: Pick<WorkjetMailboxCardModel, "kind" | "delegationId" | "delegationState">,
  viewerIsReviewer: boolean,
): ReadonlyArray<WorkjetDelegationActionKind> {
  if (model.kind !== "task" || model.delegationId === null) return [];
  const state = model.delegationState;
  const actions: WorkjetDelegationActionKind[] = ["reply"];
  if (state === "running") actions.push("request-review");
  if (state !== null && !TERMINAL_DELEGATION_STATE_SET.has(state)) actions.push("cancel");
  if (state === "review-requested" && viewerIsReviewer) {
    actions.push("approve", "request-changes");
  }
  return actions;
}

/**
 * The inline draft a card holds while composing an action. It is CONTROLLED —
 * owned by the caller and passed back on change — so the card itself stays a
 * pure, hook-free presentational function like the composer panel content.
 */
export interface WorkjetDelegationActionState {
  /** The action whose inline popover is open, or `null` when none is. */
  readonly open: WorkjetDelegationActionKind | null;
  /** Reply / request-review body text. */
  readonly text: string;
  /** 1-based review round for request-review, approve, and request-changes. */
  readonly round: number;
  /** Newline-separated reasons for a request-changes verdict. */
  readonly reasons: string;
}

export const EMPTY_DELEGATION_ACTION_STATE: WorkjetDelegationActionState = {
  open: null,
  text: "",
  round: 1,
  reasons: "",
};

/** Split a reasons textarea into bounded, non-blank lines. */
export function parseDelegationReasons(reasons: string): ReadonlyArray<string> {
  return reasons
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const ACTION_LABEL: Record<WorkjetDelegationActionKind, string> = {
  reply: "Reply",
  "request-review": "Request review",
  cancel: "Cancel",
  approve: "Approve",
  "request-changes": "Request changes",
};

const ACTION_ICON: Record<WorkjetDelegationActionKind, typeof MessageSquareIcon> = {
  reply: MessageSquareIcon,
  "request-review": RotateCcwIcon,
  cancel: XIcon,
  approve: CheckIcon,
  "request-changes": RotateCcwIcon,
};

/** Actions that dispatch straight away; the rest open an inline popover first. */
const IMMEDIATE_ACTIONS: ReadonlySet<WorkjetDelegationActionKind> = new Set(["cancel", "approve"]);

export interface WorkjetMailboxActivityCardProps {
  readonly model: WorkjetMailboxCardModel;
  /**
   * Navigate to the peer thread. Only ever offered for a same-environment peer;
   * omitted (or absent) means the address renders as plain text.
   */
  readonly onOpenPeerThread?: (peer: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
  /**
   * Whether the current viewer may act as the delegation's reviewer, which
   * gates the Approve / Request changes verdict on a review-requested card.
   */
  readonly viewerIsReviewer?: boolean;
  /**
   * The controlled inline-action draft, its change handler, and the dispatcher
   * that runs a resolved action. All three must be present for actions to
   * render; when any is absent the card is display-only, exactly as before.
   */
  readonly actionState?: WorkjetDelegationActionState;
  readonly onActionStateChange?: (next: WorkjetDelegationActionState) => void;
  readonly onDelegationAction?: (action: WorkjetDelegationAction) => void;
  /** Disables the action controls while a dispatch is in flight. */
  readonly actionsBusy?: boolean;
}

const actionFieldClass =
  "w-full rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70";

function WorkjetDelegationActionRow(props: {
  readonly model: WorkjetMailboxCardModel;
  readonly viewerIsReviewer: boolean;
  readonly state: WorkjetDelegationActionState;
  readonly busy: boolean;
  readonly onStateChange: (next: WorkjetDelegationActionState) => void;
  readonly onAction: (action: WorkjetDelegationAction) => void;
}) {
  const { model, viewerIsReviewer, state, busy, onStateChange, onAction } = props;
  const actions = availableDelegationActions(model, viewerIsReviewer);
  if (actions.length === 0) return null;

  const close = () => onStateChange(EMPTY_DELEGATION_ACTION_STATE);
  const toggle = (kind: WorkjetDelegationActionKind) => {
    if (IMMEDIATE_ACTIONS.has(kind)) {
      if (kind === "cancel") onAction({ kind: "cancel" });
      else onAction({ kind: "approve", round: state.round });
      close();
      return;
    }
    onStateChange(
      state.open === kind
        ? EMPTY_DELEGATION_ACTION_STATE
        : { ...EMPTY_DELEGATION_ACTION_STATE, open: kind },
    );
  };

  const submit = () => {
    if (state.open === "reply") onAction({ kind: "reply", text: state.text });
    else if (state.open === "request-review")
      onAction({ kind: "request-review", round: state.round, text: state.text });
    else if (state.open === "request-changes")
      onAction({
        kind: "request-changes",
        round: state.round,
        reasons: parseDelegationReasons(state.reasons),
      });
    close();
  };

  const needsText = state.open === "reply" || state.open === "request-review";
  const submitDisabled = busy || (needsText && state.text.trim().length === 0);

  return (
    <div className="flex w-full flex-col gap-1" data-workjet-delegation-actions>
      <div className="flex flex-wrap items-center gap-1">
        {actions.map((kind) => {
          const Icon = ACTION_ICON[kind];
          return (
            <button
              key={kind}
              type="button"
              data-workjet-delegation-action={kind}
              aria-pressed={state.open === kind}
              disabled={busy}
              onClick={() => toggle(kind)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
                state.open === kind
                  ? "bg-accent/60 text-foreground"
                  : "text-muted-foreground hover:bg-accent/30",
                kind === "cancel" ? "hover:text-destructive" : "",
              )}
            >
              <Icon aria-hidden className="size-3" />
              {ACTION_LABEL[kind]}
            </button>
          );
        })}
      </div>
      {state.open !== null && !IMMEDIATE_ACTIONS.has(state.open) ? (
        <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-background/60 p-1.5">
          {state.open === "request-review" || state.open === "request-changes" ? (
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              Round
              <input
                aria-label="Review round"
                type="number"
                min={1}
                max={16}
                disabled={busy}
                className="w-14 rounded-md border border-border/60 bg-background px-1 py-0.5 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                value={state.round}
                onChange={(event) =>
                  onStateChange({ ...state, round: Number(event.target.value) || 1 })
                }
              />
            </label>
          ) : null}
          {needsText ? (
            <textarea
              aria-label={state.open === "reply" ? "Reply message" : "Review request message"}
              rows={2}
              disabled={busy}
              className={actionFieldClass}
              value={state.text}
              onChange={(event) => onStateChange({ ...state, text: event.target.value })}
            />
          ) : null}
          {state.open === "request-changes" ? (
            <textarea
              aria-label="Change reasons, one per line"
              placeholder="One reason per line"
              rows={2}
              disabled={busy}
              className={actionFieldClass}
              value={state.reasons}
              onChange={(event) => onStateChange({ ...state, reasons: event.target.value })}
            />
          ) : null}
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={close}
              className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/30"
            >
              Cancel
            </button>
            <button
              type="button"
              data-workjet-delegation-submit={state.open}
              disabled={submitDisabled}
              onClick={submit}
              className="rounded-md bg-accent/60 px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent/80 disabled:opacity-50"
            >
              {ACTION_LABEL[state.open]}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkjetMailboxActivityCard(props: WorkjetMailboxActivityCardProps) {
  const { model, onOpenPeerThread, onDelegationAction, onActionStateChange } = props;
  const outbound = model.direction === "outbound";
  const DirectionIcon = outbound ? ArrowUpRightIcon : ArrowDownLeftIcon;
  const label = model.kind === "task" ? "Task" : "Message";
  const lead = outbound ? `${label} to` : `${label} from`;
  const disposition = dispositionBadgeLabel(model.disposition);
  const linkable = model.peerIsLocal && onOpenPeerThread !== undefined;
  const peerLabel = `${shortEnvironmentId(model.peerEnvironmentId)} · ${model.peerThreadId}`;
  const actionsEnabled = onDelegationAction !== undefined && onActionStateChange !== undefined;

  return (
    <div
      data-workjet-mailbox-card={model.kind}
      className="-mx-1 flex w-full flex-col gap-1.5 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-[12px]"
    >
      <div className="flex w-full items-center gap-2">
        <DirectionIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-foreground">{lead}</span>
        {linkable ? (
          <button
            type="button"
            className="min-w-0 truncate font-mono text-[11px] text-info-foreground underline-offset-2 hover:underline"
            onClick={() =>
              onOpenPeerThread({
                environmentId: model.peerEnvironmentId,
                threadId: model.peerThreadId,
              })
            }
          >
            {peerLabel}
          </button>
        ) : (
          <span className="min-w-0 truncate font-mono text-[11px] text-secondary-label">
            {peerLabel}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[.7rem]">
          <span className={cn(DISPOSITION_TONE[disposition] ?? "text-muted-foreground")}>
            {disposition}
          </span>
          {model.delegationState ? (
            <span className={delegationStateToneClass(model.delegationState)}>
              {model.delegationState}
            </span>
          ) : null}
        </span>
      </div>
      {actionsEnabled
        ? // Invoked as a plain function (it holds no state) so the buttons are
          // host elements in this card's own tree rather than an unexpanded
          // child component.
          WorkjetDelegationActionRow({
            model,
            viewerIsReviewer: props.viewerIsReviewer ?? true,
            state: props.actionState ?? EMPTY_DELEGATION_ACTION_STATE,
            busy: props.actionsBusy ?? false,
            onStateChange: onActionStateChange,
            onAction: onDelegationAction,
          })
        : null}
    </div>
  );
}
