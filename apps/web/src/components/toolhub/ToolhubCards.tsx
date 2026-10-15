// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * One shared set of toolhub cards, used everywhere an app needs access:
 * in the chat (requests the CTOX instance raised via `ui/requests`, from any
 * harness) and in the Schnittstellen store. Same look, same behaviour.
 *
 * - CredentialCard: title, one help line, masked input + "Sicher speichern",
 *   optional per-connection fields (subdomain, shop …), shield note.
 * - ConnectCard: logo, name, one-line description, "Autorisieren" pill;
 *   after success "✓ Verbunden".
 * - ConfirmCard: what the agent wants to do, "Ablehnen" / "Freigeben".
 *
 * Secret values only live in component state until they are handed to the
 * instance; nothing is persisted locally.
 */
import { CheckIcon, Loader2Icon, ShieldCheckIcon, ShieldQuestionIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

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
    <div className="rounded-2xl border border-border/50 bg-card px-4 py-3.5 shadow-sm" {...rest}>
      {children}
    </div>
  );
}

export function CardPill(props: {
  onClick?: () => void;
  disabled?: boolean | undefined;
  children: ReactNode;
  type?: "button" | "submit";
  primary?: boolean | undefined;
}) {
  return (
    <button
      type={props.type ?? "button"}
      disabled={props.disabled}
      onClick={props.type === "submit" ? undefined : props.onClick}
      className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border px-4 text-[13.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${props.primary ? "border-transparent bg-muted text-foreground hover:bg-muted/70" : "border-border bg-transparent hover:bg-muted/60"}`}
    >
      {props.children}
    </button>
  );
}

export function StatePill({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-[13.5px] ${ok ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground"}`}
    >
      {ok ? <CheckIcon className="size-3.5" /> : null}
      {children}
    </span>
  );
}

const inputClass =
  "h-9 min-w-0 flex-1 rounded-lg border border-border bg-background/40 px-3 text-[13.5px] outline-none placeholder:text-muted-foreground/70 focus:border-ring";

export function CredentialCard(props: {
  readonly t: T;
  readonly title: string;
  readonly help: string;
  readonly appName: string;
  readonly secrets: ReadonlyArray<ToolhubSecretField>;
  readonly params: ReadonlyArray<ToolhubParam>;
  readonly busy?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly status?: "open" | "done" | "declined" | "expired" | undefined;
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
  const secretPlaceholder = (f: ToolhubSecretField) =>
    t(
      `Füge deinen ${props.appName} ${secretLabel(f.name, t)} ein`,
      `Paste your ${props.appName} ${secretLabel(f.name, t)}`,
    );

  return (
    <CardShell
      data-toolhub-card="credential"
      data-ui-status={status}
      {...(props.id ? { "data-ui-request": props.id } : {})}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">{props.title}</p>
          <p className="mt-0.5 text-[13.5px] text-muted-foreground">{props.help}</p>
        </div>
        {status !== "open" ? (
          <StatePill ok={status === "done"}>
            {status === "done"
              ? t("Gespeichert", "Saved")
              : status === "declined"
                ? t("Abgelehnt", "Declined")
                : t("Abgelaufen", "Expired")}
          </StatePill>
        ) : props.onDecline ? (
          <button
            type="button"
            onClick={props.onDecline}
            disabled={props.busy}
            className="text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            {t("Ablehnen", "Decline")}
          </button>
        ) : null}
      </div>
      {status === "open" ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {props.params.map((p) => (
            <label key={p.key} className="flex flex-col gap-1">
              <span className="text-[12.5px] text-muted-foreground">
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
              {p.help ? (
                <span className="text-[12px] text-muted-foreground/80">
                  {t(p.help.de, p.help.en)}
                </span>
              ) : null}
            </label>
          ))}
          {props.secrets.map((f, i) => (
            <div key={f.name} className="flex items-center gap-2">
              <input
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                aria-label={secretLabel(f.name, t)}
                placeholder={secretPlaceholder(f)}
                value={values[f.name] ?? ""}
                onChange={(e) => set(f.name, e.target.value)}
                className={inputClass}
              />
              {i === props.secrets.length - 1 ? (
                <CardPill type="submit" primary disabled={!ok || props.busy || props.disabled}>
                  {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                  {t("Sicher speichern", "Save securely")}
                </CardPill>
              ) : null}
            </div>
          ))}
          <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <ShieldCheckIcon className="size-3.5" />
            {t(
              "Sicher hinterlegt, wird deinem Bot nie angezeigt",
              "Stored securely, never shown to your bot",
            )}
          </p>
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
  readonly status?: "open" | "done" | "declined" | "expired" | undefined;
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
      <div className="flex items-center gap-3.5">
        <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/60">
          {props.logo ? (
            <img src={props.logo} alt="" className="size-[62%] object-contain" />
          ) : (
            <span className="text-[17px] font-semibold text-muted-foreground">
              {props.name.charAt(0)}
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{props.name}</span>
          <span className="block truncate text-[13.5px] text-muted-foreground">
            {props.description}
          </span>
        </span>
        {status === "done" ? (
          <StatePill ok>{t("Verbunden", "Connected")}</StatePill>
        ) : status !== "open" ? (
          <StatePill ok={false}>
            {status === "declined" ? t("Abgelehnt", "Declined") : t("Abgelaufen", "Expired")}
          </StatePill>
        ) : (
          <span className="flex items-center gap-2">
            {props.onDecline ? (
              <button
                type="button"
                onClick={props.onDecline}
                disabled={props.busy}
                className="text-[12.5px] text-muted-foreground hover:text-foreground"
              >
                {t("Ablehnen", "Decline")}
              </button>
            ) : null}
            <CardPill onClick={props.onAuthorize} disabled={props.busy || props.disabled}>
              {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {t("Autorisieren", "Authorize")}
            </CardPill>
          </span>
        )}
      </div>
    </CardShell>
  );
}

export function ConfirmCard(props: {
  readonly t: T;
  readonly title: string;
  readonly help: string;
  readonly busy?: boolean | undefined;
  readonly status?: "open" | "done" | "declined" | "expired" | undefined;
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
      <div className="flex items-center gap-3.5">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted/60">
          <ShieldQuestionIcon className="size-5 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold">{props.title}</span>
          <span className="block truncate text-[13.5px] text-muted-foreground">{props.help}</span>
        </span>
        {status !== "open" ? (
          <StatePill ok={status === "done"}>
            {status === "done"
              ? t("Freigegeben", "Approved")
              : status === "declined"
                ? t("Abgelehnt", "Declined")
                : t("Abgelaufen", "Expired")}
          </StatePill>
        ) : (
          <span className="flex gap-1.5">
            <CardPill onClick={() => props.onDecide("decline")} disabled={props.busy}>
              {t("Ablehnen", "Decline")}
            </CardPill>
            <CardPill primary onClick={() => props.onDecide("approve")} disabled={props.busy}>
              {t("Freigeben", "Approve")}
            </CardPill>
          </span>
        )}
      </div>
    </CardShell>
  );
}
