import { CheckCircle2Icon } from "lucide-react";

import { V4_INVITE_FAILURE_TEXT, type V4InviteFailureCode } from "../../ctox/v4DeviceInvite";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

export type V4InviteRedeemState =
  | { readonly phase: "running" }
  | { readonly phase: "connected" }
  | { readonly phase: "failed"; readonly code: V4InviteFailureCode };

export const V4_INVITE_PROGRESS_TEXT = "Verbinden …";
export const V4_INVITE_CONNECTED_TEXT = "Verbunden.";
export const V4_INVITE_ACTION_LABEL = {
  retry: "Erneut versuchen",
  new_link: "Neuer Link",
} as const;

/** E54.4: one line — progress, then green; a failure is a short text with exactly one action. */
export function V4InviteRedeemLine({
  state,
  onRetry,
  onNewLink,
}: {
  readonly state: V4InviteRedeemState;
  readonly onRetry: () => void;
  readonly onNewLink: () => void;
}) {
  if (state.phase === "running") {
    return (
      <div
        className="flex min-h-7 items-center gap-2 text-muted-foreground text-xs"
        data-workjet-v4-invite="running"
        role="status"
      >
        <Spinner aria-hidden className="size-3.5" />
        <span>{V4_INVITE_PROGRESS_TEXT}</span>
      </div>
    );
  }
  if (state.phase === "connected") {
    return (
      <div
        className="flex min-h-7 items-center gap-2 text-success text-xs"
        data-workjet-v4-invite="connected"
        role="status"
      >
        <CheckCircle2Icon aria-hidden className="size-3.5" />
        <span>{V4_INVITE_CONNECTED_TEXT}</span>
      </div>
    );
  }
  const failure = V4_INVITE_FAILURE_TEXT[state.code];
  return (
    <div
      className="flex min-h-7 items-center justify-between gap-2 text-destructive text-xs"
      data-workjet-v4-invite="failed"
      data-workjet-v4-invite-code={state.code}
      role="alert"
    >
      <span className="min-w-0 truncate">{failure.text}</span>
      <Button
        size="xs"
        type="button"
        variant="outline"
        onClick={failure.action === "retry" ? onRetry : onNewLink}
      >
        {V4_INVITE_ACTION_LABEL[failure.action]}
      </Button>
    </div>
  );
}
