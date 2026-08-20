import {
  WORKJET_CROSS_MODE_ACTIVITY_KINDS,
  WorkjetCrossModeActivityPayload,
  WorkjetCrossModeError,
  type CtoxAppModuleId,
  type CtoxManagedInstanceId,
  type EnvironmentId,
  type ThreadId,
  type WorkjetBusinessOsObjectId,
  type WorkjetBusinessOsObjectKind,
  type WorkjetCrossModeCommandApproval,
  type WorkjetCrossModeLinkId,
  type WorkjetCrossModeOperation,
  type WorkjetCrossModeResultOutcome,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ArrowUpRightIcon,
  CornerDownRightIcon,
  ExternalLinkIcon,
  LinkIcon,
  RotateCcwIcon,
  SendIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";

/**
 * The timeline face of the cross-mode workflow bridge (docs/workjet-plan.md →
 * "Cross-mode workflow bridge": "Add `Return to Business OS`, result/evidence
 * submission, review request, and follow-up actions to linked Code threads").
 *
 * The bridge writes two thread activities — `workjet.crossmode.linked` on the
 * Code thread when a link is created, and `workjet.crossmode.returned` for every
 * reverse operation — whose payloads are deliberately redacted: typed references,
 * the operation, the approval state, and the link's own bounded title. This card
 * renders exactly that and nothing else, so the timeline cannot become a second
 * place where a Business OS record leaks. There is no evidence summary here and
 * no scoped-context brief: an activity row is a trace, not a transcript.
 *
 * It mirrors `WorkjetMailboxActivityCard` deliberately — same nullable parse,
 * same controlled draft, same plain-function action row, same `data-*` hooks —
 * because it is the same interaction in a different direction, and a second
 * shape for it would be a second thing to learn and a second thing to break.
 */

export const WORKJET_CROSS_MODE_ACTIVITY_KIND_SET: ReadonlySet<string> = new Set(
  WORKJET_CROSS_MODE_ACTIVITY_KINDS,
);

export interface WorkjetCrossModeCardModel {
  /** `link` is the durable backlink; `return` is the trace of one reverse operation. */
  readonly kind: "link" | "return";
  readonly linkId: WorkjetCrossModeLinkId;
  readonly instanceId: CtoxManagedInstanceId;
  readonly moduleId: CtoxAppModuleId;
  readonly objectKind: WorkjetBusinessOsObjectKind;
  readonly objectId: WorkjetBusinessOsObjectId;
  readonly codeEnvironmentId: EnvironmentId;
  readonly codeThreadId: ThreadId;
  /** The link's bounded, redacted label. Never a record field. */
  readonly title: string;
  /** Set on a `return` card only. */
  readonly operation: WorkjetCrossModeOperation | null;
  readonly approval: WorkjetCrossModeCommandApproval | null;
}

const decodePayload = Schema.decodeUnknownOption(WorkjetCrossModeActivityPayload);

/**
 * Decode one cross-mode activity into what the card needs, or `null` when this
 * is not one (or carries a payload this build cannot read — a version-skewed
 * server must degrade to no card, never to a crash).
 */
export function parseWorkjetCrossModeActivity(
  kind: string,
  payload: unknown,
): WorkjetCrossModeCardModel | null {
  if (!WORKJET_CROSS_MODE_ACTIVITY_KIND_SET.has(kind)) {
    return null;
  }
  const decoded = decodePayload(payload);
  if (Option.isNone(decoded)) {
    return null;
  }
  const value = decoded.value;
  return {
    kind: value.direction === "to-code" ? "link" : "return",
    linkId: value.linkId,
    instanceId: value.ctox.instanceId,
    moduleId: value.ctox.moduleId,
    objectKind: value.ctox.objectKind,
    objectId: value.ctox.objectId,
    codeEnvironmentId: value.code.environmentId,
    codeThreadId: value.code.threadId,
    title: value.title,
    operation: value.operation ?? null,
    approval: value.approval ?? null,
  };
}

/** `module/kind/id` — the reference an operator can resolve in Business OS. */
export function crossModeObjectLabel(
  model: Pick<WorkjetCrossModeCardModel, "moduleId" | "objectKind" | "objectId">,
): string {
  return `${model.moduleId}/${model.objectKind}/${model.objectId}`;
}

/**
 * How a reverse operation's approval state reads.
 *
 * `not-required` is the ordinary outcome and deliberately renders as "sent", not
 * as "applied": this server cannot observe what the Business OS did with the
 * command, and a word implying it could would be a claim the bridge cannot
 * support. `pending` says a human still has to clear it on the CTOX side.
 */
export function crossModeApprovalLabel(approval: WorkjetCrossModeCommandApproval | null): string {
  switch (approval) {
    case "not-required":
      return "sent";
    case "pending":
      return "awaiting approval";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    default:
      return "sent";
  }
}

const APPROVAL_TONE: Record<string, string> = {
  sent: "text-muted-foreground",
  "awaiting approval": "text-warning-foreground",
  approved: "text-success-foreground",
  rejected: "text-destructive",
};

export const CROSS_MODE_OPERATION_LABEL: Record<WorkjetCrossModeOperation, string> = {
  "submit-result": "Submit result",
  "request-review": "Request review",
  "follow-up": "Follow up",
};

/**
 * The actions a linked Code thread offers.
 *
 * Only the LINK card offers them. A `return` card is the durable trace of an
 * action already taken, and putting the same buttons on every past trace would
 * let one thread accumulate a row of identical, ambiguous action bars.
 */
export function availableCrossModeActions(
  model: Pick<WorkjetCrossModeCardModel, "kind">,
): ReadonlyArray<WorkjetCrossModeOperation> {
  return model.kind === "link" ? ["submit-result", "request-review", "follow-up"] : [];
}

/**
 * The inline draft a card holds while composing a return. CONTROLLED — owned by
 * the caller and passed back on change — so the card stays a pure, hook-free
 * presentational function, exactly like the mailbox card.
 */
export interface WorkjetCrossModeActionState {
  readonly open: WorkjetCrossModeOperation | null;
  /** The bounded evidence summary. Required by the contract for every operation. */
  readonly summary: string;
  /** The terminal verdict, used by `submit-result` only. */
  readonly outcome: WorkjetCrossModeResultOutcome;
  /**
   * The bounded refusal from the last dispatch, or `null`. Refusals are shown ON
   * the card because that is where the action was taken; a success needs no note,
   * since the durable re-render already carries the new activity.
   */
  readonly error: string | null;
}

export const EMPTY_CROSS_MODE_ACTION_STATE: WorkjetCrossModeActionState = {
  open: null,
  summary: "",
  outcome: "completed",
  error: null,
};

/** The resolved intent a card emits upward. */
export type WorkjetCrossModeAction =
  | {
      readonly kind: "submit-result";
      readonly linkId: WorkjetCrossModeLinkId;
      readonly summary: string;
      readonly outcome: WorkjetCrossModeResultOutcome;
    }
  | {
      readonly kind: "request-review";
      readonly linkId: WorkjetCrossModeLinkId;
      readonly summary: string;
    }
  | {
      readonly kind: "follow-up";
      readonly linkId: WorkjetCrossModeLinkId;
      readonly summary: string;
    };

const ACTION_ICON: Record<WorkjetCrossModeOperation, typeof SendIcon> = {
  "submit-result": SendIcon,
  "request-review": RotateCcwIcon,
  "follow-up": CornerDownRightIcon,
};

export interface WorkjetCrossModeLinkCardProps {
  readonly model: WorkjetCrossModeCardModel;
  /**
   * `Return to Business OS`: select the counterpart in the other mode. Absent
   * means the reference renders as plain text — a host with no mode switch must
   * not offer a button that goes nowhere.
   */
  readonly onOpenBusinessOsObject?: (target: {
    readonly instanceId: CtoxManagedInstanceId;
    readonly moduleId: CtoxAppModuleId;
    readonly objectKind: WorkjetBusinessOsObjectKind;
    readonly objectId: WorkjetBusinessOsObjectId;
  }) => void;
  /**
   * The controlled draft, its change handler, and the dispatcher. All three must
   * be present for the command actions to render; when any is absent the card is
   * display-only.
   */
  readonly actionState?: WorkjetCrossModeActionState;
  readonly onActionStateChange?: (next: WorkjetCrossModeActionState) => void;
  readonly onCrossModeAction?: (action: WorkjetCrossModeAction) => void;
  readonly actionsBusy?: boolean;
}

const actionFieldClass =
  "w-full rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70";

function WorkjetCrossModeActionRow(props: {
  readonly model: WorkjetCrossModeCardModel;
  readonly state: WorkjetCrossModeActionState;
  readonly busy: boolean;
  readonly onStateChange: (next: WorkjetCrossModeActionState) => void;
  readonly onAction: (action: WorkjetCrossModeAction) => void;
}) {
  const { model, state, busy, onStateChange, onAction } = props;
  const actions = availableCrossModeActions(model);
  if (actions.length === 0) return null;

  const close = () => onStateChange(EMPTY_CROSS_MODE_ACTION_STATE);
  const toggle = (kind: WorkjetCrossModeOperation) => {
    onStateChange(
      state.open === kind
        ? EMPTY_CROSS_MODE_ACTION_STATE
        : { ...EMPTY_CROSS_MODE_ACTION_STATE, open: kind },
    );
  };

  const submit = () => {
    const summary = state.summary;
    if (state.open === "submit-result") {
      onAction({ kind: "submit-result", linkId: model.linkId, summary, outcome: state.outcome });
    } else if (state.open === "request-review") {
      onAction({ kind: "request-review", linkId: model.linkId, summary });
    } else if (state.open === "follow-up") {
      onAction({ kind: "follow-up", linkId: model.linkId, summary });
    }
    close();
  };

  // Every operation carries evidence, and the contract's summary is a non-empty
  // bounded string, so an empty draft can never be a valid submission.
  const submitDisabled = busy || state.summary.trim().length === 0;

  return (
    <div className="flex w-full flex-col gap-1" data-workjet-crossmode-actions>
      <div className="flex flex-wrap items-center gap-1">
        {actions.map((kind) => {
          const Icon = ACTION_ICON[kind];
          return (
            <button
              key={kind}
              type="button"
              data-workjet-crossmode-action={kind}
              aria-pressed={state.open === kind}
              disabled={busy}
              onClick={() => toggle(kind)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
                state.open === kind
                  ? "bg-accent/60 text-foreground"
                  : "text-muted-foreground hover:bg-accent/30",
              )}
            >
              <Icon aria-hidden className="size-3" />
              {CROSS_MODE_OPERATION_LABEL[kind]}
            </button>
          );
        })}
      </div>
      {state.open === null ? null : (
        <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-background/60 p-1.5">
          {state.open === "submit-result" ? (
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              Outcome
              <select
                aria-label="Result outcome"
                disabled={busy}
                className={actionFieldClass}
                value={state.outcome}
                onChange={(event) =>
                  onStateChange({
                    ...state,
                    outcome: event.target.value as WorkjetCrossModeResultOutcome,
                  })
                }
              >
                <option value="completed">completed</option>
                <option value="failed">failed</option>
                <option value="cancelled">cancelled</option>
              </select>
            </label>
          ) : null}
          <textarea
            aria-label="Evidence summary"
            placeholder="What was done, and what the reviewer should check"
            rows={2}
            disabled={busy}
            className={actionFieldClass}
            value={state.summary}
            onChange={(event) => onStateChange({ ...state, summary: event.target.value })}
          />
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
              data-workjet-crossmode-submit={state.open}
              disabled={submitDisabled}
              onClick={submit}
              className="rounded-md bg-accent/60 px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent/80 disabled:opacity-50"
            >
              {CROSS_MODE_OPERATION_LABEL[state.open]}
            </button>
          </div>
        </div>
      )}
      {state.error === null ? null : (
        <p data-workjet-crossmode-action-error className="text-[11px] text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}

export function WorkjetCrossModeLinkCard(props: WorkjetCrossModeLinkCardProps) {
  const { model, onOpenBusinessOsObject, onCrossModeAction, onActionStateChange } = props;
  const isLink = model.kind === "link";
  const DirectionIcon = isLink ? LinkIcon : ArrowUpRightIcon;
  const lead = isLink
    ? "Linked to"
    : `${model.operation === null ? "Returned to" : CROSS_MODE_OPERATION_LABEL[model.operation]} →`;
  const objectLabel = crossModeObjectLabel(model);
  const approval = crossModeApprovalLabel(model.approval);
  const linkable = onOpenBusinessOsObject !== undefined;
  const actionsEnabled = onCrossModeAction !== undefined && onActionStateChange !== undefined;

  return (
    <div
      data-workjet-crossmode-card={model.kind}
      className="-mx-1 flex w-full flex-col gap-1.5 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-[12px]"
    >
      <div className="flex w-full items-center gap-2">
        <DirectionIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-foreground">{lead}</span>
        {linkable ? (
          <button
            type="button"
            data-workjet-crossmode-open
            title="Return to Business OS"
            className="min-w-0 truncate font-mono text-[11px] text-info-foreground underline-offset-2 hover:underline"
            onClick={() =>
              onOpenBusinessOsObject({
                instanceId: model.instanceId,
                moduleId: model.moduleId,
                objectKind: model.objectKind,
                objectId: model.objectId,
              })
            }
          >
            {model.title}
            <ExternalLinkIcon aria-hidden className="ml-1 inline size-3" />
          </button>
        ) : (
          <span className="min-w-0 truncate font-mono text-[11px] text-secondary-label">
            {model.title}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[.7rem]">
          <span className="text-muted-foreground">{objectLabel}</span>
          {model.kind === "return" ? (
            <span className={cn(APPROVAL_TONE[approval] ?? "text-muted-foreground")}>
              {approval}
            </span>
          ) : null}
        </span>
      </div>
      {actionsEnabled
        ? // Invoked as a plain function (it holds no state) so the buttons are
          // host elements in this card's own tree rather than an unexpanded
          // child component.
          WorkjetCrossModeActionRow({
            model,
            state: props.actionState ?? EMPTY_CROSS_MODE_ACTION_STATE,
            busy: props.actionsBusy ?? false,
            onStateChange: onActionStateChange,
            onAction: onCrossModeAction,
          })
        : null}
    </div>
  );
}

/**
 * The bounded refusal a failed return renders on the card.
 *
 * It re-derives the message from the contract's own error rather than printing
 * whatever came back: the reasons are a closed set, and anything outside it —
 * a transport fault, a serialization problem — must collapse to one generic
 * sentence rather than leaking a server string into the timeline. Mirrors
 * `workjetMailboxFailureMessage`.
 */
const CROSS_MODE_FAILURE_REASONS: ReadonlySet<string> = new Set([
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

export function workjetCrossModeFailureMessage(error: unknown): string {
  const reason =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "WorkjetCrossModeError" &&
    "reason" in error &&
    typeof error.reason === "string" &&
    CROSS_MODE_FAILURE_REASONS.has(error.reason)
      ? (error.reason as WorkjetCrossModeError["reason"])
      : null;
  if (reason === null) return "The return to Business OS failed.";
  return new WorkjetCrossModeError({ reason }).message;
}
