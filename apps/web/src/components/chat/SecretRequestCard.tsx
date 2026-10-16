import { KeyRoundIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { WORKJET_SECRET_VALUE_MAX, type WorkjetSecretRequestRecord } from "@workjet/contracts";
import { Button } from "../ui/button";
import { SecretInput } from "../ui/secret-input";
import { toastManager } from "../ui/toast";
import {
  type SecretRequestOutcome,
  declineSecretRequest,
  fulfillSecretRequest,
  listSecretRequests,
  secretRequestText,
} from "../../workjetSecretRequests";
import { getCtoxClient, subscribeCtoxClients } from "../../ctox/ctoxClient";
import {
  CTOX_SECRET_REQUEST_DECLINE,
  CTOX_SECRET_REQUEST_FULFILL,
  ctoxRouteOffered,
  markV4RouteUnavailable,
  subscribeV4Capabilities,
} from "../../ctox/v4Capabilities";

function subscribeRouteOffer(listener: () => void) {
  const offClients = subscribeCtoxClients(listener);
  const offCapabilities = subscribeV4Capabilities(listener);
  return () => {
    offClients();
    offCapabilities();
  };
}

/** V3 keeps both actions; V4 offers a route only once the Core grants it in hello_ok. */
function useRouteOffered(instanceId: string, route: string): boolean {
  const read = () => ctoxRouteOffered(instanceId, route);
  return useSyncExternalStore(subscribeRouteOffer, read, read);
}

/** One agent request for a credential, answered with a masked field. */
export function SecretRequestCard(props: {
  readonly instanceId: string;
  readonly request: WorkjetSecretRequestRecord;
  readonly language: "de" | "en";
  readonly onSettled?: (requestId: string) => void;
}) {
  const t = secretRequestText(props.language);
  // The value lives only in this component's memory and is cleared on submit.
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const { request } = props;
  const canFulfill = useRouteOffered(props.instanceId, CTOX_SECRET_REQUEST_FULFILL);
  const canDecline = useRouteOffered(props.instanceId, CTOX_SECRET_REQUEST_DECLINE);
  const settle = (outcome: SecretRequestOutcome, route: string, title: string) => {
    setBusy(false);
    if (outcome.ok) props.onSettled?.(request.requestId);
    else if (outcome.reason === "unavailable" && getCtoxClient(props.instanceId) !== null)
      // V4 Core without the route: the action leaves silently for this session.
      markV4RouteUnavailable(props.instanceId, route);
    else toastManager.add({ type: "error", title });
  };
  const store = async () => {
    if (!value || busy) return;
    const submitted = value;
    setValue("");
    setBusy(true);
    const outcome = await fulfillSecretRequest(props.instanceId, request.requestId, submitted);
    settle(outcome, CTOX_SECRET_REQUEST_FULFILL, t.failed);
  };
  const decline = async () => {
    setBusy(true);
    const outcome = await declineSecretRequest(props.instanceId, request.requestId);
    settle(outcome, CTOX_SECRET_REQUEST_DECLINE, t.declineFailed);
  };
  const declineButton = canDecline ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => void decline()}
    >
      {t.decline}
    </Button>
  ) : null;
  return (
    <section
      className="mb-3 flex flex-col gap-2 rounded-lg border bg-card/40 px-3 py-2 text-[13.5px]"
      aria-label={`${t.heading}: ${request.label}`}
      data-workjet-secret-request={request.requestId}
    >
      <p className="flex min-w-0 items-center gap-2 font-medium">
        <KeyRoundIcon className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{request.label}</span>
      </p>
      {request.reason ? <p className="text-xs text-muted-foreground">{request.reason}</p> : null}
      {canFulfill ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void store();
          }}
        >
          <span className="min-w-0 flex-1">
            <SecretInput
              label={`${t.field}: ${request.label}`}
              value={value}
              onChange={setValue}
              disabled={busy}
              placeholder={t.field}
              maxLength={WORKJET_SECRET_VALUE_MAX}
              language={props.language}
            />
          </span>
          <span className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || value.length === 0}>
              {t.store}
            </Button>
            {declineButton}
          </span>
        </form>
      ) : declineButton ? (
        <span className="flex gap-2">{declineButton}</span>
      ) : null}
    </section>
  );
}

const POLL_MS = 5_000;

/** Pending secret requests for this instance (and thread, when CTOX knows it). */
export function SecretRequestCards(props: {
  readonly instanceId: string | null;
  readonly threadKey?: string | null;
  readonly language: "de" | "en";
}) {
  const [requests, setRequests] = useState<readonly WorkjetSecretRequestRecord[]>([]);
  // Answered requests leave at once, before the next poll confirms it.
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const instanceId = props.instanceId;
    if (!instanceId) return;
    let alive = true;
    const poll = async () => {
      const list = await listSecretRequests(instanceId).catch(() => null);
      if (!alive || list === null) return;
      setRequests(
        list.filter(
          (r) =>
            r.status === "pending" &&
            (r.threadKey === null || !props.threadKey || r.threadKey === props.threadKey),
        ),
      );
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [props.instanceId, props.threadKey]);
  const shown = requests.filter((r) => !settled.has(r.requestId));
  if (!props.instanceId || shown.length === 0) return null;
  return (
    <>
      {shown.map((request) => (
        <SecretRequestCard
          key={request.requestId}
          instanceId={props.instanceId!}
          request={request}
          language={props.language}
          onSettled={(id) => setSettled((prev) => new Set(prev).add(id))}
        />
      ))}
    </>
  );
}
