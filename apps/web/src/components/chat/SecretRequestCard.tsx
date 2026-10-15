import { KeyRoundIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkjetSecretRequestRecord } from "@workjet/contracts";
import { Button } from "../ui/button";
import { SecretInput } from "../ui/secret-input";
import {
  declineSecretRequest,
  fulfillSecretRequest,
  listSecretRequests,
  secretRequestText,
} from "../../workjetSecretRequests";

type Settled = { readonly kind: "stored"; readonly ref: string } | { readonly kind: "declined" };

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
  const [failed, setFailed] = useState(false);
  const [settled, setSettled] = useState<Settled | null>(null);
  const [replacing, setReplacing] = useState(false);
  const { request } = props;
  const store = async () => {
    if (!value || busy) return;
    const submitted = value;
    setValue("");
    setBusy(true);
    setFailed(false);
    const outcome = await fulfillSecretRequest(props.instanceId, request.requestId, submitted);
    setBusy(false);
    if (outcome.ok) {
      setSettled({ kind: "stored", ref: outcome.ref ?? `${request.scope}/${request.name}` });
      setReplacing(false);
      props.onSettled?.(request.requestId);
    } else setFailed(true);
  };
  const decline = async () => {
    setBusy(true);
    const outcome = await declineSecretRequest(props.instanceId, request.requestId);
    setBusy(false);
    if (outcome.ok) {
      setSettled({ kind: "declined" });
      props.onSettled?.(request.requestId);
    } else setFailed(true);
  };
  const showForm = settled === null || replacing;
  return (
    <section
      className="mb-3 flex flex-col gap-2 rounded-lg border bg-card/40 p-3 text-sm"
      aria-label={`${t.heading}: ${request.label}`}
      data-workjet-secret-request={request.requestId}
    >
      <p className="flex items-center gap-2 font-medium">
        <KeyRoundIcon className="size-4 shrink-0" aria-hidden />
        <span>{request.label}</span>
      </p>
      {request.reason ? <p className="text-xs text-muted-foreground">{request.reason}</p> : null}
      {showForm ? (
        <form
          className="flex flex-col gap-2"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void store();
          }}
        >
          <SecretInput
            label={`${t.field}: ${request.label}`}
            value={value}
            onChange={setValue}
            disabled={busy}
            placeholder={t.placeholder}
            maxLength={8192}
            language={props.language}
          />
          <p className="text-xs text-muted-foreground">{t.hint}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || value.length === 0}>
              {t.store}
            </Button>
            {settled === null ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void decline()}
              >
                {t.decline}
              </Button>
            ) : null}
          </div>
          {failed ? (
            <p role="alert" className="text-xs text-destructive">
              {t.failed}
            </p>
          ) : null}
        </form>
      ) : (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          role="status"
        >
          <span>{settled.kind === "stored" ? t.stored(settled.ref) : t.declined}</span>
          {settled.kind === "stored" ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setReplacing(true)}>
              {t.replace}
            </Button>
          ) : null}
        </div>
      )}
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
  const settledIds = useRef(new Set<string>());
  const [shown, setShown] = useState<readonly WorkjetSecretRequestRecord[]>([]);
  useEffect(() => {
    const instanceId = props.instanceId;
    if (!instanceId) return;
    let alive = true;
    const poll = async () => {
      const list = await listSecretRequests(instanceId).catch(() => null);
      if (!alive || list === null) return;
      setRequests(
        list.filter(
          (r) => r.threadKey === null || !props.threadKey || r.threadKey === props.threadKey,
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
  useEffect(() => {
    // Keep settled cards visible (with their reference) after they leave the pending list.
    setShown((prev) => {
      const kept = prev.filter((r) => settledIds.current.has(r.requestId));
      const fresh = requests.filter((r) => !kept.some((k) => k.requestId === r.requestId));
      return [...kept, ...fresh];
    });
  }, [requests]);
  if (!props.instanceId || shown.length === 0) return null;
  return (
    <>
      {shown.map((request) => (
        <SecretRequestCard
          key={request.requestId}
          instanceId={props.instanceId!}
          request={request}
          language={props.language}
          onSettled={(id) => settledIds.current.add(id)}
        />
      ))}
    </>
  );
}
