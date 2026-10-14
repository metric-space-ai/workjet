// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * In-session cards for requests an agent raised with `ctox ui request …`
 * (or that `ctox toolhub exec` raised when a connection was missing).
 *
 * The instance owns the request; the card only resolves it. Secret values go
 * from the masked input straight to the instance secret store and are never
 * put into the transcript, the model context or local state after submit.
 */
import { CheckIcon, KeyRoundIcon, Loader2Icon, ShieldQuestionIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useUiText } from "../../hooks/useUiText";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { INTEGRATIONS } from "../settings/integrationsCatalog";

export interface SessionUiRequest {
  readonly id: string;
  readonly kind: "credential" | "connect" | "confirm";
  readonly status: "open" | "done" | "declined" | "expired";
  readonly toolkit: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly secret: boolean }>;
  readonly message?: string;
  readonly session?: string;
  readonly created_at: number;
  readonly resolved_at?: number;
}

const POLL_MS = 3000;
const SHOW_RESOLVED_SECS = 10 * 60;

function appName(slug: string): string {
  return (
    INTEGRATIONS.find((e) => e.slug === slug)?.name ?? slug.charAt(0).toUpperCase() + slug.slice(1)
  );
}
function appLogo(slug: string): string | null {
  return INTEGRATIONS.find((e) => e.slug === slug)?.logo ?? null;
}
const FIELD_LABELS: Record<string, { de: string; en: string }> = {
  token: { de: "Zugangsschlüssel", en: "Access key" },
  api_key: { de: "API-Schlüssel", en: "API key" },
  password: { de: "Passwort", en: "Password" },
  username: { de: "Benutzername", en: "Username" },
  client_id: { de: "Client-ID", en: "Client ID" },
  client_secret: { de: "Client-Geheimnis", en: "Client secret" },
};

/** Pure: which requests to show in this session right now. */
export function visibleRequests(
  all: ReadonlyArray<SessionUiRequest>,
  sessionId: string | null,
  nowSecs: number,
): SessionUiRequest[] {
  return all
    .filter((r) => !r.session || r.session === sessionId)
    .filter(
      (r) => r.status === "open" || nowSecs - (r.resolved_at ?? r.created_at) < SHOW_RESOLVED_SECS,
    )
    .slice(0, 4);
}

export function SessionRequestCards({ sessionId }: { readonly sessionId: string | null }) {
  const t = useUiText();
  const { selectedId } = useCtoxMode();
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const [requests, setRequests] = useState<ReadonlyArray<SessionUiRequest>>([]);
  const alive = useRef(true);

  const call = useCallback(
    async (route: string, body: unknown) => {
      if (!bridge?.toolhubRequest || typeof selectedId !== "string") throw new Error("unavailable");
      const r = await bridge.toolhubRequest({ instanceId: selectedId, route, body });
      const b = (r.body ?? {}) as Record<string, unknown>;
      if (r.status !== 200)
        throw Object.assign(new Error(String(b.message ?? r.status)), { status: r.status });
      return b;
    },
    [bridge, selectedId],
  );

  const load = useCallback(async () => {
    try {
      const b = await call("ui/requests", sessionId ? { session: sessionId } : {});
      if (alive.current) setRequests((b.requests as SessionUiRequest[] | undefined) ?? []);
    } catch {
      // Unreachable instance: keep the last known cards; the settings page explains outages.
    }
  }, [call, sessionId]);

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const shown = visibleRequests(requests, sessionId, Date.now() / 1000);
  if (shown.length === 0) return null;
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-1 pb-2"
      data-session-request-cards
    >
      {shown.map((r) => (
        <RequestCard key={r.id} request={r} t={t} call={call} onChanged={load} />
      ))}
    </div>
  );
}

type T = (de: string, en: string) => string;

function StatePill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] ${ok ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground"}`}
    >
      {ok ? <CheckIcon className="size-3.5" /> : null}
      {children}
    </span>
  );
}

function PillButton(props: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={props.type ?? "button"}
      disabled={props.disabled}
      onClick={props.type === "submit" ? undefined : props.onClick}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted px-3.5 text-[13px] font-medium hover:bg-muted/70 disabled:opacity-50"
    >
      {props.children}
    </button>
  );
}

function humanError(e: unknown, t: T, name: string): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 403)
    return t(
      `Nur Admins dieser Instanz können ${name} verbinden.`,
      `Only admins of this instance can connect ${name}.`,
    );
  if (status === undefined || status === 0)
    return t(
      "Die Instanz ist gerade nicht erreichbar. Versuch es gleich noch einmal.",
      "The instance can't be reached right now. Try again in a moment.",
    );
  return t(
    "Das hat nicht geklappt. Prüf die Eingabe und versuch es noch einmal.",
    "That didn't work. Check your input and try again.",
  );
}

export function RequestCard({
  request: r,
  t,
  call,
  onChanged,
}: {
  request: SessionUiRequest;
  t: T;
  call: (route: string, body: unknown) => Promise<Record<string, unknown>>;
  onChanged: () => Promise<void>;
}) {
  const name = appName(r.toolkit);
  const logo = appLogo(r.toolkit);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(humanError(e, t, name));
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    run(async () => {
      const payload = { ...values };
      setValues({}); // never keep the secret around after handing it over
      await call("ui/resolve", { id: r.id, action: "submit", values: payload });
    });
  const connect = () =>
    run(async () => {
      const c = await call("connect", { server: r.toolkit });
      if (!bridge?.toolhubAuthorize) throw new Error("unavailable");
      const result = await bridge.toolhubAuthorize({ authorizeUrl: String(c.authorize_url ?? "") });
      if (result._tag === "cancelled") return;
      await call("ui/resolve", { id: r.id, action: "connected" });
    });
  const decide = (action: "approve" | "decline") =>
    run(async () => void (await call("ui/resolve", { id: r.id, action })));

  const title =
    r.kind === "credential"
      ? t(`Bei ${name} anmelden`, `Sign in to ${name}`)
      : r.kind === "connect"
        ? name
        : (r.message ?? t(`${name}: Aktion bestätigen`, `${name}: confirm action`));
  const subtitle =
    r.kind === "credential"
      ? t("Sicheres Formular", "Secure form")
      : r.kind === "connect"
        ? t(
            "Dein Agent braucht Zugriff, um weiterzumachen.",
            "Your agent needs access to continue.",
          )
        : t("Dein Agent wartet auf deine Freigabe.", "Your agent is waiting for your approval.");

  const done = r.status === "done";
  const closed = r.status !== "open";
  const resolvedLabel = done
    ? r.kind === "credential"
      ? t("Übermittelt", "Submitted")
      : r.kind === "connect"
        ? t("Verbunden", "Connected")
        : t("Freigegeben", "Approved")
    : r.status === "declined"
      ? t("Abgelehnt", "Declined")
      : t("Abgelaufen", "Expired");

  return (
    <div
      className="rounded-2xl border border-border/60 bg-card px-4 py-3"
      data-ui-request={r.id}
      data-ui-kind={r.kind}
      data-ui-status={r.status}
    >
      <div className="flex items-center gap-3.5">
        <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/40">
          {r.kind === "connect" && logo ? (
            <img src={logo} alt="" className="size-[70%] object-contain" />
          ) : r.kind === "confirm" ? (
            <ShieldQuestionIcon className="size-5 text-muted-foreground" />
          ) : (
            <KeyRoundIcon className="size-5 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-medium">{title}</span>
          <span className="block truncate text-[13px] text-muted-foreground">{subtitle}</span>
        </span>
        {closed ? (
          <StatePill ok={done}>{resolvedLabel}</StatePill>
        ) : r.kind === "connect" ? (
          <PillButton onClick={() => void connect()} disabled={busy}>
            {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {t("Verbinden", "Connect")}
          </PillButton>
        ) : r.kind === "confirm" ? (
          <span className="flex gap-1.5">
            <PillButton onClick={() => void decide("decline")} disabled={busy}>
              {t("Ablehnen", "Decline")}
            </PillButton>
            <PillButton onClick={() => void decide("approve")} disabled={busy}>
              {t("Freigeben", "Approve")}
            </PillButton>
          </span>
        ) : null}
      </div>
      {!closed && r.kind === "credential" ? (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {r.fields.map((f) => (
            <input
              key={f.name}
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              aria-label={t(FIELD_LABELS[f.name]?.de ?? f.name, FIELD_LABELS[f.name]?.en ?? f.name)}
              placeholder={t(
                FIELD_LABELS[f.name]?.de ?? f.name,
                FIELD_LABELS[f.name]?.en ?? f.name,
              )}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              className="h-9 min-w-0 flex-1 rounded-full border border-border bg-background px-3.5 text-[13px] outline-none focus:border-ring"
            />
          ))}
          <span className="flex gap-1.5">
            <PillButton onClick={() => void decide("decline")} disabled={busy}>
              {t("Abbrechen", "Cancel")}
            </PillButton>
            <PillButton
              type="submit"
              onClick={() => undefined}
              disabled={busy || r.fields.some((f) => (values[f.name] ?? "").trim() === "")}
            >
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {t("Übermitteln", "Submit")}
            </PillButton>
          </span>
        </form>
      ) : null}
      {error ? <p className="mt-2 text-[12.5px] text-muted-foreground">{error}</p> : null}
    </div>
  );
}
