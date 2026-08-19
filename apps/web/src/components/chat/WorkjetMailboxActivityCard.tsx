import {
  WorkjetMailboxActivityPayload,
  type EnvironmentId,
  type ThreadId,
  type WorkjetDelegationState,
  type WorkjetDeliveryDisposition,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react";

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
}

export function WorkjetMailboxActivityCard(props: WorkjetMailboxActivityCardProps) {
  const { model, onOpenPeerThread } = props;
  const outbound = model.direction === "outbound";
  const DirectionIcon = outbound ? ArrowUpRightIcon : ArrowDownLeftIcon;
  const label = model.kind === "task" ? "Task" : "Message";
  const lead = outbound ? `${label} to` : `${label} from`;
  const disposition = dispositionBadgeLabel(model.disposition);
  const linkable = model.peerIsLocal && onOpenPeerThread !== undefined;
  const peerLabel = `${shortEnvironmentId(model.peerEnvironmentId)} · ${model.peerThreadId}`;

  return (
    <div
      data-workjet-mailbox-card={model.kind}
      className="-mx-1 flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-[12px]"
    >
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
  );
}
