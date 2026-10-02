import type {
  WorkjetGatewayAccountSummary,
  WorkjetGatewayApiKeyProvider,
  WorkjetGatewayOauthProvider,
  WorkjetGatewayProvider,
} from "@workjet/contracts";
import { PlusIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";
import {
  isWorkjetGatewayApiKeyProvider,
  WORKJET_GATEWAY_PROVIDER_ICONS,
  WORKJET_GATEWAY_PROVIDER_LABELS,
  WORKJET_GATEWAY_PROVIDERS,
  type WorkjetGatewaySectionState,
} from "./WorkjetGatewayAccounts";

export interface ModelsAccountHealth {
  readonly status: "ready" | "disabled" | "auth-required" | "cooldown" | "unavailable" | "unknown";
  readonly message: string | null;
  readonly retryAtMs: number | null;
  readonly windows: ReadonlyArray<{
    readonly label: string;
    readonly remainingPercent: number | null;
    readonly resetsAtMs: number | null;
  }>;
  readonly observedAtMs: number | null;
  readonly quotaSupported: boolean;
  readonly quotaRefreshing: boolean;
  readonly quotaError: string | null;
}

export interface ModelsManagementState {
  readonly accountHealth: Readonly<Record<string, ModelsAccountHealth>>;
  readonly accountErrors: Readonly<Record<string, string>>;
  readonly mutationBusy: boolean;
  readonly loginAccountId: string | null;
  readonly onEditAccount: (account: WorkjetGatewayAccountSummary, patch: { readonly label?: string; readonly enabled?: boolean }) => Promise<boolean>;
  readonly onEditModels: (accounts: ReadonlyArray<WorkjetGatewayAccountSummary>, models: ReadonlyArray<string>) => Promise<boolean>;
  readonly onDeleteAccount: (accountId: string) => Promise<boolean>;
  readonly onRelogin: (provider: WorkjetGatewayOauthProvider, accountId: string) => void;
  readonly onSaveApiKey: (provider: WorkjetGatewayApiKeyProvider, key: string, label: string, models: ReadonlyArray<string>, accountId?: string) => Promise<boolean>;
}

export function parseModels(value: string): ReadonlyArray<string> | null {
  const models = [...new Set(value.split(/[,\n]/).map((model) => model.trim()).filter(Boolean))];
  return models.length <= 128 && models.every((model) => model.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(model)) ? models : null;
}

function InlineField({ value, label, multiline = false, disabled, onSave, className }: {
  readonly value: string;
  readonly label: string;
  readonly multiline?: boolean;
  readonly disabled?: boolean;
  readonly onSave: (value: string) => Promise<boolean>;
  readonly className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const focused = useRef(false);
  const savingRef = useRef(false);
  const cancelledBlur = useRef(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  useEffect(() => {
    if (field.current) { field.current.style.height = "0px"; field.current.style.height = `${field.current.scrollHeight}px`; }
  }, [draft]);
  const save = async () => {
    if (savingRef.current || draft.trim() === value || disabled) return;
    savingRef.current = true;
    setSaving(true);
    try { setFailed(!(await onSave(draft.trim()))); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const shared = {
    "aria-label": label,
    "aria-invalid": failed,
    value: draft,
    disabled: disabled || saving,
    onFocus: () => { focused.current = true; },
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(event.target.value); setFailed(false); },
    onBlur: () => { focused.current = false; if (cancelledBlur.current) { cancelledBlur.current = false; return; } void save(); },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Escape") { cancelledBlur.current = true; setDraft(value); setFailed(false); event.currentTarget.blur(); }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void save(); }
    },
    className: cn("w-full min-w-0 rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none hover:border-border focus:border-ring focus:bg-background disabled:opacity-60", failed && "border-destructive", className),
  };
  return <div className="min-w-0">
    {multiline ? <textarea {...shared} ref={field} rows={1} className={cn(shared.className, "resize-none overflow-hidden")} /> : <input {...shared} maxLength={160} />}
    {failed && <span role="alert" className="text-xs text-destructive">Nicht gespeichert. Eingabe prüfen und erneut mit Enter speichern.</span>}
  </div>;
}

function resetLabel(at: number | null) {
  return at === null ? null : new Date(at).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function AccountLimits({ health }: { readonly health: ModelsAccountHealth | undefined }) {
  if (!health || health.windows.length === 0) return <span className="text-xs text-muted-foreground">{health?.quotaRefreshing ? "Limits werden geprüft …" : health?.quotaError ? "Limits derzeit nicht abrufbar" : health?.quotaSupported === false ? "Anbieter meldet keine Limits" : "Limits nicht verfügbar"}</span>;
  return <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums" title={health.observedAtMs === null ? undefined : `Stand: ${new Date(health.observedAtMs).toLocaleString()}`}>
    {health.windows.map((window) => <span key={window.label} className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground">{window.label}</span>
      <span>{window.remainingPercent === null ? "Rest unbekannt" : `${Math.round(window.remainingPercent)} % frei`}</span>
      {window.remainingPercent !== null && <span aria-hidden className="h-1 w-12 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-emerald-500/80" style={{ width: `${Math.max(0, Math.min(100, window.remainingPercent))}%` }} /></span>}
      {window.resetsAtMs !== null && <span className="text-muted-foreground">bis {resetLabel(window.resetsAtMs)}</span>}
    </span>)}
  </div>;
}

function KeyForm({ provider, account, models, state, onClose }: {
  readonly provider: WorkjetGatewayApiKeyProvider;
  readonly account?: WorkjetGatewayAccountSummary;
  readonly models: ReadonlyArray<string>;
  readonly state: WorkjetGatewaySectionState & ModelsManagementState;
  readonly onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState(account?.label ?? WORKJET_GATEWAY_PROVIDER_LABELS[provider]);
  const [modelText, setModelText] = useState(models.join(", "));
  const [error, setError] = useState<string | null>(null);
  return <form className="grid min-w-0 gap-2 border-t border-border/50 py-3 sm:grid-cols-[minmax(10rem,1fr)_minmax(12rem,2fr)_auto]" onSubmit={(event) => {
    event.preventDefault();
    const parsed = parseModels(modelText);
    if (!key.trim() || !label.trim() || !parsed || (account === undefined && parsed.length === 0)) { setError("Accountname, API-Key und mindestens einen gültigen Modellnamen eingeben."); return; }
    const credential = key;
    setKey("");
    setError(null);
    void state.onSaveApiKey(provider, credential, label.trim(), parsed, account?.id).then((saved) => { if (saved) onClose(); else setError("API-Key nicht gespeichert. Erneut eingeben und speichern."); });
  }}>
    <input aria-label="Accountname" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={160} className="rounded-md border bg-background px-2 py-1.5 text-sm" />
    <input aria-label={account ? `API-Key für ${account.label}` : `API-Key für ${WORKJET_GATEWAY_PROVIDER_LABELS[provider]}`} type="password" autoComplete="new-password" placeholder="API-Key" value={key} maxLength={512} onChange={(event) => setKey(event.target.value)} className="rounded-md border bg-background px-2 py-1.5 text-sm" />
    <div className="flex items-center gap-1"><Button type="submit" size="sm" disabled={state.mutationBusy || state.apiKey.status === "saving"}>Verbinden</Button><Button type="button" size="icon" variant="ghost" aria-label="API-Key Eingabe abbrechen" onClick={onClose}><XIcon className="size-4" /></Button></div>
    {!account && <label className="col-span-full grid gap-1 text-xs text-muted-foreground">Modelle<input aria-label={`Modelle für neuen ${WORKJET_GATEWAY_PROVIDER_LABELS[provider]} Account`} placeholder="Modell-IDs, durch Komma getrennt" value={modelText} onChange={(event) => setModelText(event.target.value)} className="rounded-md border bg-background px-2 py-1.5 text-sm text-foreground" /></label>}
    {error && <p role="alert" className="col-span-full text-xs text-destructive">{error}</p>}
  </form>;
}

function AccountRow({ account, state }: { readonly account: WorkjetGatewayAccountSummary; readonly state: WorkjetGatewaySectionState & ModelsManagementState }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [replaceKey, setReplaceKey] = useState(false);
  const health = state.accountHealth[account.id];
  const isKey = account.credentialKind === "api-key" || account.credentialSuffix !== null || !["claude", "codex", "antigravity", "xai"].includes(account.provider);
  const authRequired = account.enabled && health?.status === "auth-required";
  const problem = account.enabled && health && !["ready", "unknown", "disabled"].includes(health.status);
  const loginHere = state.loginAccountId === account.id && ["starting", "pending", "failed"].includes(state.login.status);
  return <div className={cn("py-1.5", !account.enabled && "text-muted-foreground")} data-account-id={account.id}>
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1.3fr)_auto]">
      <div className="min-w-0"><InlineField label={`Accountname ${account.label}`} value={account.label} disabled={state.mutationBusy} onSave={(label) => label.length > 0 ? state.onEditAccount(account, { label }) : Promise.resolve(false)} />
        {isKey && <button type="button" onClick={() => setReplaceKey(!replaceKey)} className="ml-1 text-xs text-muted-foreground hover:text-foreground" aria-label={`API-Key ${account.label} direkt ändern`}>API-Key{account.credentialSuffix === null ? "" : ` · ••••${account.credentialSuffix}`}</button>}
      </div>
      <div className="col-start-1 row-start-2 pl-1 sm:col-start-2 sm:row-start-1">{account.enabled ? <AccountLimits health={health} /> : <span className="text-xs">Deaktiviert</span>}</div>
      <div className="col-start-2 row-start-1 flex items-center gap-2 sm:col-start-3">
        {authRequired && !isKey && !loginHere && <Button size="sm" variant="outline" disabled={state.mutationBusy} onClick={() => state.onRelogin(account.provider as WorkjetGatewayOauthProvider, account.id)}>Re-login</Button>}
        <label className="relative inline-flex cursor-pointer items-center" title={account.enabled ? "Für Workjet deaktivieren" : "Für Workjet aktivieren"}>
          <input type="checkbox" role="switch" aria-label={`Account ${account.label} verwenden`} checked={account.enabled} disabled={state.mutationBusy} onChange={(event) => { void state.onEditAccount(account, { enabled: event.target.checked }); }} className="peer sr-only" />
          <span aria-hidden className="h-5 w-8 rounded-full bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:opacity-50"><span className={cn("m-0.5 block size-4 rounded-full bg-background transition-transform", account.enabled && "translate-x-3")} /></span>
        </label>
        <Button size="icon" variant="ghost" aria-label={`Account ${account.label} permanent entfernen`} disabled={state.mutationBusy} onClick={() => setConfirmDelete(!confirmDelete)}><Trash2Icon className="size-3.5" /></Button>
      </div>
    </div>
    {problem && !loginHere && <div role="status" className="flex flex-wrap items-center gap-2 pl-1 text-xs text-amber-500">
      <span>{health.message ?? (authRequired ? "Anmeldung abgelaufen." : health.status === "cooldown" ? "Limit erreicht. Andere verfügbare Accounts übernehmen neue Anfragen." : "Anbieter derzeit nicht erreichbar.")}{health.retryAtMs !== null && ` Erneut verfügbar: ${resetLabel(health.retryAtMs)}.`}</span>
      {authRequired && isKey && <button className="underline underline-offset-2" onClick={() => setReplaceKey(true)}>API-Key ersetzen</button>}
      {!authRequired && health.status === "unavailable" && <button className="underline underline-offset-2" onClick={state.onRefresh}>Erneut prüfen</button>}
    </div>}
    {state.accountErrors[account.id] && <p role="alert" className="pl-1 text-xs text-destructive">{state.accountErrors[account.id]}</p>}
    {loginHere && <LoginMessage state={state} />}
    {replaceKey && isWorkjetGatewayApiKeyProvider(account.provider) && <KeyForm provider={account.provider} account={account} models={account.modelIds} state={state} onClose={() => setReplaceKey(false)} />}
    {confirmDelete && <div className="flex flex-wrap items-center gap-2 rounded-md bg-destructive/5 p-2 text-xs"><span>Account und gespeicherte Zugangsdaten permanent entfernen?</span><Button size="sm" variant="destructive" disabled={state.mutationBusy} onClick={() => { void state.onDeleteAccount(account.id).then((removed) => { if (removed) setConfirmDelete(false); }); }}>Entfernen</Button><Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Abbrechen</Button></div>}
  </div>;
}

function LoginMessage({ state }: { readonly state: WorkjetGatewaySectionState }) {
  const login = state.login;
  if (login.status === "starting") return <p role="status" className="py-2 text-xs text-muted-foreground">Anmeldung wird geöffnet …</p>;
  if (login.status === "failed") return <p role="alert" className="py-2 text-xs text-destructive">{login.message}</p>;
  if (login.status !== "pending") return null;
  return <div role="status" className="flex flex-wrap items-center gap-3 py-2 text-xs text-muted-foreground"><span>Anmeldung im Browser abschließen. Dieser Account wird danach automatisch angezeigt.</span><a href={login.authorizationUrl} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">Anmeldung öffnen</a><button onClick={state.onCancelLogin} className="text-foreground">Abbrechen</button></div>;
}

export function WorkjetModelsProviders(state: WorkjetGatewaySectionState & ModelsManagementState) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [adding, setAdding] = useState<WorkjetGatewayProvider | null>(null);
  const [keyProvider, setKeyProvider] = useState<WorkjetGatewayApiKeyProvider | null>(null);
  const accounts = state.catalog?.accounts ?? [];
  const providers = WORKJET_GATEWAY_PROVIDERS.filter((provider) => accounts.some((account) => account.provider === provider) || adding === provider || (state.login.status !== "idle" && state.login.provider === provider));
  const startAdd = (provider: WorkjetGatewayProvider) => {
    setPickerOpen(false); setAdding(provider); setKeyProvider(null);
    if (provider !== "xai") {
      if (isWorkjetGatewayApiKeyProvider(provider)) setKeyProvider(provider);
      else state.onAddAccount(provider);
    }
  };
  const fault = state.statusError ?? state.catalogError ?? (state.status?.phase === "faulted" ? "Provider-Verbindung unterbrochen." : null);
  return <section className="space-y-4" aria-label="LLM-Anbieter" data-testid="models-providers">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">LLM-Anbieter</h2><p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><span className={cn("size-1.5 rounded-full", state.status?.phase === "ready" ? "bg-emerald-500" : "bg-muted-foreground")} />{state.isInitialLoading ? "Verbindung wird geladen …" : `${accounts.filter((account) => account.enabled).length} aktive Accounts · ${state.catalog?.models.length ?? 0} Modelle`}</p></div>
      <div className="relative flex gap-1"><Button size="icon" variant="ghost" aria-label="Anbieterstatus aktualisieren" disabled={state.isRefreshing} onClick={state.onRefresh}><RefreshCwIcon className="size-4" /></Button><Popover open={pickerOpen} onOpenChange={setPickerOpen}><PopoverTrigger render={<Button size="sm" variant="outline" disabled={state.mutationBusy} />}><PlusIcon className="size-4" /> Anbieter hinzufügen</PopoverTrigger>
        <PopoverPopup align="end" aria-label="Anbieter auswählen" viewportClassName="p-1">{WORKJET_GATEWAY_PROVIDERS.map((provider) => { const Icon = WORKJET_GATEWAY_PROVIDER_ICONS[provider]; return <button key={provider} type="button" onClick={() => startAdd(provider)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"><Icon className="size-4" />{WORKJET_GATEWAY_PROVIDER_LABELS[provider]}</button>; })}</PopoverPopup></Popover>
      </div>
    </div>
    {fault && <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 p-3 text-sm"><span>{fault}</span><Button size="sm" variant="outline" disabled={state.isOperating} onClick={state.onRetry}>Verbindung wiederherstellen</Button></div>}
    {accounts.length === 0 && adding === null && !state.isInitialLoading && <p className="py-4 text-sm text-muted-foreground">Anbieter hinzufügen und per Abo-Anmeldung oder API-Key verbinden.</p>}
    <div className="divide-y divide-border/60">
      {providers.map((provider) => {
        const providerAccounts = accounts.filter((account) => account.provider === provider);
        const models = [...new Set(providerAccounts.flatMap((account) => account.modelIds))];
        const Icon = WORKJET_GATEWAY_PROVIDER_ICONS[provider];
        const title = WORKJET_GATEWAY_PROVIDER_LABELS[provider];
        const loginHere = state.login.status !== "idle" && state.login.provider === provider && state.loginAccountId === null;
        return <div key={provider} className="py-4 first:pt-1" data-provider={provider}>
          <div className="mb-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 sm:grid-cols-[minmax(10rem,1fr)_minmax(12rem,2fr)_auto]">
            <div className="flex items-center gap-2 pt-1"><Icon className="size-5 shrink-0" /><h3 className="text-sm font-semibold">{title}</h3><span className="text-xs text-muted-foreground">{providerAccounts.length}</span></div>
            <div className="col-span-full row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1"><div className="flex items-baseline gap-2"><span className="shrink-0 text-[11px] text-muted-foreground">Modelle</span><div className="min-w-0 flex-1">{providerAccounts.length > 0 ? <InlineField label={`Modelle ${title}`} value={models.join(", ")} multiline disabled={state.mutationBusy} className="text-xs" onSave={(value) => { const parsed = parseModels(value); return parsed === null ? Promise.resolve(false) : state.onEditModels(providerAccounts, parsed); }} /> : <span className="text-xs text-muted-foreground">Nach dem Verbinden direkt bearbeitbar</span>}</div></div></div>
            <Button size="icon" variant="ghost" className="col-start-2 row-start-1 sm:col-start-3" aria-label={`Account zu ${title} hinzufügen`} disabled={state.mutationBusy || state.login.status === "pending" || state.login.status === "starting"} onClick={() => startAdd(provider)}><PlusIcon className="size-4" /></Button>
          </div>
          <div className="pl-0 sm:pl-6">{providerAccounts.map((account) => <AccountRow key={account.id} account={account} state={state} />)}
            {providerAccounts.length > 0 && models.length === 0 && <p role="status" className="py-1 text-xs text-amber-500">Keine Modelle zugeordnet. Modell-IDs oben eingeben, damit Workjet diesen Anbieter nutzen kann.</p>}
            {adding === provider && provider === "xai" && keyProvider === null && !loginHere && <div className="flex gap-2 py-2"><Button size="sm" variant="outline" onClick={() => state.onAddAccount("xai")}>Mit Abo anmelden</Button><Button size="sm" variant="outline" onClick={() => setKeyProvider("xai")}>API-Key hinzufügen</Button></div>}
            {keyProvider === provider && isWorkjetGatewayApiKeyProvider(provider) && <KeyForm provider={provider} models={models} state={state} onClose={() => { setAdding(null); setKeyProvider(null); }} />}
            {loginHere && <LoginMessage state={state} />}
          </div>
        </div>;
      })}
    </div>
  </section>;
}
