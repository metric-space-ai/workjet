// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * One shared set of toolhub cards, used everywhere an app needs access:
 * in the chat (requests the CTOX instance raised via `ui/requests`, from any
 * harness) and in the Schnittstellen store. Same look, same behaviour.
 *
 * - CredentialCard: title, masked input with lock + "Ablehnen" / "Sicher speichern",
 *   optional per-connection fields (subdomain, shop …).
 * - ConnectCard: logo, name, one-line description, "Ablehnen" / "Autorisieren".
 * - ConfirmCard: what the worker wants to do, "Ablehnen" / "Freigeben".
 *
 * Actions are `ui/button` (default/outline); settled cards show only a status
 * dot; a failure shows one short line and the primary turns into "Erneut versuchen".
 *
 * Secret values only live in component state until they are handed to the
 * instance; nothing is persisted locally.
 */
import { Loader2Icon, LockIcon, ShieldQuestionIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../ui/button";

export type T = (de: string, en: string) => string;
export interface Localized {
  readonly de: string;
  readonly en: string;
}

/** Non-secret per-connection parameter (e.g. subdomain), as the instance describes it. */
export interface ToolhubParam {
  readonly key: string;
  readonly label?: Localized;
  readonly help?: Localized;
  readonly placeholder?: string;
  readonly required?: boolean;
}

/** Secret field of a credential request. */
export interface ToolhubSecretField {
  readonly name: string;
  readonly secret: boolean;
}

const SECRET_LABELS: Record<string, Localized> = {
  token: { de: "Zugangsschlüssel", en: "Access key" },
  api_key: { de: "API-Schlüssel", en: "API key" },
  password: { de: "Passwort", en: "Password" },
  username: { de: "Benutzername", en: "Username" },
  client_id: { de: "Client-ID", en: "Client ID" },
  client_secret: { de: "Client-Geheimnis", en: "Client secret" },
};

export function secretLabel(name: string, t: T): string {
  const l = SECRET_LABELS[name];
  return l ? t(l.de, l.en) : name.replace(/_/g, " ");
}

/** Pure: may the credential form be submitted with these values? */
export function canSubmitCredential(
  secrets: ReadonlyArray<ToolhubSecretField>,
  params: ReadonlyArray<ToolhubParam>,
  values: Readonly<Record<string, string>>,
): boolean {
  const filled = (k: string) => (values[k] ?? "").trim() !== "";
  return secrets.every((f) => filled(f.name)) && params.every((p) => !p.required || filled(p.key));
}

export function CardShell({
  children,
  ...rest
}: { children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div className="rounded-xl border border-border/50 bg-card px-3 py-2.5 shadow-sm" {...rest}>
      {children}
    </div>
  );
}

export type ToolhubCardStatus = "open" | "done" | "declined" | "expired";

/** Erledigte Karten zeigen nur einen Statuspunkt, keine Status-Pille (UI-Vertrag §2). */
export function StatusDot({ status, t }: { status: ToolhubCardStatus; t: T }) {
  const label =
    status === "done"
      ? t("Erledigt", "Done")
      : status === "declined"
        ? t("Abgelehnt", "Declined")
        : t("Abgelaufen", "Expired");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-toolhub-status-dot={status}
      className={`size-2 shrink-0 rounded-full ${status === "done" ? "bg-success" : "bg-muted-foreground/50"}`}
    />
  );
}

/** Fehlerzeile der Karte: höchstens 12 Wörter, die Aktion ist der Primär-Button. */
function CardError({ text }: { text: string | null | undefined }) {
  return text ? (
    <p role="alert" className="mt-2 text-[12px] text-destructive" data-toolhub-card-error="">
      {text}
    </p>
  ) : null;
}

const inputClass =
  "h-8 min-w-0 flex-1 rounded-lg border border-border bg-background/40 px-3 text-[13.5px] outline-none placeholder:text-muted-foreground/70 focus:border-ring";

export function CredentialCard(props: {
  readonly t: T;
  readonly title: string;
  readonly help?: string | undefined;
  readonly appName: string;
  readonly secrets: ReadonlyArray<ToolhubSecretField>;
  readonly params: ReadonlyArray<ToolhubParam>;
  readonly busy?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly status?: ToolhubCardStatus | undefined;
  /** Kurze Fehlerzeile nach einem Fehlschlag; der Speichern-Button wird zu „Erneut versuchen“. */
  readonly error?: string | null | undefined;
  readonly onSubmit: (values: Record<string, string>) => void;
  readonly onDecline?: () => void;
  readonly id?: string;
}) {
  const { t } = props;
  const [values, setValues] = useState<Record<string, string>>({});
  const status = props.status ?? "open";
  const ok = canSubmitCredential(props.secrets, props.params, values);
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));
  const submit = () => {
    if (!ok || props.busy || props.disabled) return;
    const payload = { ...values };
    setValues({}); // never keep secrets around after handing them over
    props.onSubmit(payload);
  };
  const secretPlaceholder = (f: ToolhubSecretField) => `${props.appName} ${secretLabel(f.name, t)}`;

  return (
    <CardShell
      data-toolhub-card="credential"
      data-ui-status={status}
      {...(props.id ? { "data-ui-request": props.id } : {})}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold">{props.title}</p>
          {props.help ? (
            <p className="mt-0.5 text-[12px] text-muted-foreground">{props.help}</p>
          ) : null}
        </div>
        {status !== "open" ? <StatusDot status={status} t={t} /> : null}
      </div>
      {status === "open" ? (
        <form
          className="mt-2.5 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {props.params.map((p) => (
            <label key={p.key} className="flex flex-col gap-1">
              <span className="text-[12px] text-muted-foreground">
                {p.label ? t(p.label.de, p.label.en) : p.key}
                {p.required ? "" : t(" (optional)", " (optional)")}
              </span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                data-param={p.key}
                placeholder={p.placeholder ?? ""}
                value={values[p.key] ?? ""}
                onChange={(e) => set(p.key, e.target.value)}
                className={`${inputClass} flex-none`}
              />
            </label>
          ))}
          {props.secrets.map((f, i) => (
            <div key={f.name} className="flex flex-wrap items-center gap-2">
              <span className="relative flex min-w-40 flex-1 items-center">
                {f.secret ? (
                  <LockIcon
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
                  />
                ) : null}
                <input
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={secretLabel(f.name, t)}
                  placeholder={secretPlaceholder(f)}
                  value={values[f.name] ?? ""}
                  onChange={(e) => set(f.name, e.target.value)}
                  className={`${inputClass} ${f.secret ? "pl-8" : ""}`}
                />
              </span>
              {i === props.secrets.length - 1 ? (
                <span className="flex shrink-0 items-center gap-2">
                  {props.onDecline ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={props.onDecline}
                      disabled={props.busy}
                    >
                      {t("Ablehnen", "Decline")}
                    </Button>
                  ) : null}
                  <Button type="submit" size="sm" disabled={!ok || props.busy || props.disabled}>
                    {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                    {props.error
                      ? t("Erneut versuchen", "Try again")
                      : t("Sicher speichern", "Save securely")}
                  </Button>
                </span>
              ) : null}
            </div>
          ))}
          <CardError text={props.error} />
        </form>
      ) : null}
    </CardShell>
  );
}

export function ConnectCard(props: {
  readonly t: T;
  readonly name: string;
  readonly description: string;
  readonly logo: string | null;
  readonly busy?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly status?: ToolhubCardStatus | undefined;
  /** Kurze Fehlerzeile nach einem Fehlschlag; „Autorisieren“ wird zu „Erneut versuchen“. */
  readonly error?: string | null | undefined;
  readonly onAuthorize: () => void;
  readonly onDecline?: () => void;
  readonly id?: string;
}) {
  const { t } = props;
  const status = props.status ?? "open";
  return (
    <CardShell
      data-toolhub-card="connect"
      data-ui-status={status}
      {...(props.id ? { "data-ui-request": props.id } : {})}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/60">
            {props.logo ? (
              <img src={props.logo} alt="" className="size-[62%] object-contain" />
            ) : (
              <span className="text-[13.5px] font-semibold text-muted-foreground">
                {props.name.charAt(0)}
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold">{props.name}</span>
            <span className="block truncate text-[12px] text-muted-foreground">
              {props.description}
            </span>
          </span>
        </span>
        {status !== "open" ? (
          <StatusDot status={status} t={t} />
        ) : (
          <span className="flex shrink-0 items-center gap-2">
            {props.onDecline ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={props.onDecline}
                disabled={props.busy}
              >
                {t("Ablehnen", "Decline")}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              onClick={props.onAuthorize}
              disabled={props.busy || props.disabled}
            >
              {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {props.error ? t("Erneut versuchen", "Try again") : t("Autorisieren", "Authorize")}
            </Button>
          </span>
        )}
      </div>
      <CardError text={props.error} />
    </CardShell>
  );
}

export function ConfirmCard(props: {
  readonly t: T;
  readonly title: string;
  readonly help?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly status?: ToolhubCardStatus | undefined;
  /** Kurze Fehlerzeile nach einem Fehlschlag. */
  readonly error?: string | null | undefined;
  readonly onDecide: (action: "approve" | "decline") => void;
  readonly id?: string;
}) {
  const { t } = props;
  const status = props.status ?? "open";
  return (
    <CardShell
      data-toolhub-card="confirm"
      data-ui-status={status}
      {...(props.id ? { "data-ui-request": props.id } : {})}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
            <ShieldQuestionIcon className="size-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold">{props.title}</span>
            {props.help ? (
              <span className="block truncate text-[12px] text-muted-foreground">{props.help}</span>
            ) : null}
          </span>
        </span>
        {status !== "open" ? (
          <StatusDot status={status} t={t} />
        ) : (
          <span className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => props.onDecide("decline")}
              disabled={props.busy}
            >
              {t("Ablehnen", "Decline")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => props.onDecide("approve")}
              disabled={props.busy}
            >
              {props.error ? t("Erneut versuchen", "Try again") : t("Freigeben", "Approve")}
            </Button>
          </span>
        )}
      </div>
      <CardError text={props.error} />
    </CardShell>
  );
}
