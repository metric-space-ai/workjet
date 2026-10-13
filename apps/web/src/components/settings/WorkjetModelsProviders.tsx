import type {
  WorkjetGatewayAccountSummary,
  WorkjetGatewayApiKeyProvider,
  WorkjetGatewayOauthProvider,
  WorkjetGatewayProvider,
  WorkjetGatewayModelCheck,
} from "@workjet/contracts";
import { CheckIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Button } from "../ui/button";
import { EmptyLoading } from "../ui/empty";
import { InlinePanel } from "../ui/inline-panel";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Row, type RowMenuAction, type RowStatus } from "../ui/row";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import {
  type WorkjetStatus,
  workjetStatusFromModelsHealth,
  workjetStatusWord,
} from "../../workjetStatus";
import { WorkjetModelsCell } from "./WorkjetModelsCell";
import { parseModels } from "./WorkjetModelsFields";
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
  readonly balance: {
    readonly availableBalance: number;
    readonly currency: "USD" | "CNY";
    readonly observedAtMs: number;
    readonly fresh: boolean;
  } | null;
  readonly windows: ReadonlyArray<{
    readonly id?: string;
    readonly label: string;
    readonly tooltip?: string;
    readonly unknownReason?: string | null;
    readonly tone?: "red" | "yellow" | "green";
    readonly unlimited?: boolean;
    readonly notInPlan?: boolean;
    readonly remainingPercent: number | null;
    readonly resetsAtMs: number | null;
  }>;
  readonly observedAtMs: number | null;
  readonly quotaSupported: boolean;
  readonly quotaRefreshing: boolean;
  readonly quotaError: string | null;
}

export interface ModelsModelCheck {
  readonly accountId: string;
  readonly modelId: string;
  readonly status: WorkjetGatewayModelCheck["status"];
  readonly errorClass: string | null;
  readonly source?: WorkjetGatewayModelCheck["source"];
  readonly unavailableReason?: WorkjetGatewayModelCheck["unavailableReason"];
  readonly checkedAtMs: number;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
}

export interface InstanceGrokAccountPresentation {
  readonly connectionFailure?:
    | import("../../workjetProjectControl").WorkjetProjectControlFailure
    | undefined;
  readonly row: ReactNode;
  readonly label: string;
  readonly installed: boolean;
  readonly hasModels: boolean;
  readonly checking: boolean;
  readonly start: () => void;
  readonly checkAll: () => void;
  readonly refresh: () => void;
}
export interface ModelsManagementState {
  readonly nativeProviderRows?: ReactNode;
  readonly instanceGrok?: InstanceGrokAccountPresentation;
  readonly modelChecks?: ReadonlyArray<ModelsModelCheck>;
  readonly pendingModelChecks?: ReadonlyArray<{
    readonly accountId: string;
    readonly modelId: string;
    readonly status: "queued" | "running";
  }>;
  readonly deferredChecksCount?: number;
  readonly checksBusy?: boolean;
  readonly checksError?: string | null;
  readonly onCheckModels?: (accountId?: string) => void;
  readonly accountHealth: Readonly<Record<string, ModelsAccountHealth>>;
  readonly accountErrors: Readonly<Record<string, string>>;
  readonly mutationBusy: boolean;
  readonly loginAccountId: string | null;
  readonly onEditAccount: (
    account: WorkjetGatewayAccountSummary,
    patch: { readonly label?: string; readonly enabled?: boolean },
  ) => Promise<boolean>;
  readonly onEditModels: (
    accounts: ReadonlyArray<WorkjetGatewayAccountSummary>,
    models: ReadonlyArray<string>,
  ) => Promise<boolean>;
  readonly onEditProviderModels?: (
    provider: WorkjetGatewayProvider,
    models: ReadonlyArray<string>,
  ) => Promise<boolean>;
  readonly modelSuggestions?: Readonly<
    Partial<Record<WorkjetGatewayProvider, ReadonlyArray<string>>>
  >;
  readonly onExcludeModel?: (
    account: WorkjetGatewayAccountSummary,
    model: string,
    excluded: boolean,
  ) => Promise<boolean>;
  readonly onDeleteAccount: (accountId: string) => Promise<boolean>;
  readonly onRelogin: (provider: WorkjetGatewayOauthProvider, accountId: string) => void;
  readonly onSaveApiKey: (
    provider: WorkjetGatewayApiKeyProvider,
    key: string,
    label: string,
    models: ReadonlyArray<string>,
    accountId?: string,
  ) => Promise<boolean>;
}

export { parseModels } from "./WorkjetModelsFields";

function InlineField({
  value,
  label,
  multiline = false,
  disabled,
  onSave,
  className,
  action,
  failureMessage,
}: {
  readonly value: string;
  readonly label: string;
  readonly multiline?: boolean;
  readonly disabled?: boolean;
  readonly onSave: (value: string) => Promise<boolean>;
  readonly className?: string;
  readonly action?: string;
  readonly failureMessage?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const focused = useRef(false);
  const savingRef = useRef(false);
  const cancelledBlur = useRef(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  useEffect(() => {
    if (field.current) {
      field.current.style.height = "0px";
      field.current.style.height = `${field.current.scrollHeight}px`;
    }
  }, [draft]);
  const save = async () => {
    if (savingRef.current || draft.trim() === value || disabled) return;
    savingRef.current = true;
    setSaving(true);
    try {
      setFailed(!(await onSave(draft.trim())));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const shared = {
    "data-workjet-action": action,
    "aria-label": label,
    "aria-invalid": failed,
    value: draft,
    disabled: disabled || saving,
    onFocus: () => {
      focused.current = true;
    },
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(event.target.value);
      setFailed(false);
    },
    onBlur: () => {
      focused.current = false;
      if (cancelledBlur.current) {
        cancelledBlur.current = false;
        return;
      }
      void save();
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelledBlur.current = true;
        setDraft(value);
        setFailed(false);
        event.currentTarget.blur();
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void save();
      }
    },
    className: cn(
      "w-full min-w-0 rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none hover:border-border focus:border-ring focus:bg-background disabled:opacity-60",
      failed && "border-destructive",
      className,
    ),
  };
  return (
    <span className="block min-w-0">
      {multiline ? (
        <textarea
          {...shared}
          ref={field}
          rows={1}
          className={cn(shared.className, "resize-none overflow-hidden")}
        />
      ) : (
        <input {...shared} maxLength={160} />
      )}
      {failed && (
        <span role="alert" className="text-xs text-destructive">
          {failureMessage ?? "Nicht gespeichert."}
        </span>
      )}
    </span>
  );
}

function resetLabel(at: number | null) {
  return at === null
    ? null
    : new Date(at).toLocaleString(undefined, {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function AccountLimits({
  health,
  provider,
}: {
  readonly health: ModelsAccountHealth | undefined;
  readonly provider: string;
}) {
  if (health?.balance) {
    const balance = health.balance;
    return (
      <div className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground" title="Anbieter meldet kein Limit">
          —
        </span>
        <span
          className="text-xs tabular-nums"
          title={`${balance.fresh ? "Guthaben" : "Zuletzt gemeldetes Guthaben"} · ${new Date(balance.observedAtMs).toLocaleString()}${health.quotaError ? " · Aktualisierung fehlgeschlagen" : ""}`}
        >
          {balance.currency}{" "}
          {balance.availableBalance.toLocaleString(undefined, { maximumSignificantDigits: 6 })}
          {!balance.fresh && <span className="ml-1 text-muted-foreground">veraltet</span>}
        </span>
      </div>
    );
  }
  if (!health || health.windows.length === 0)
    return (
      <span
        className="text-xs text-muted-foreground"
        title={
          provider === "xai" || provider === "kimi"
            ? "Anbieter meldet kein Limit"
            : health?.quotaRefreshing
              ? "Limits werden geprüft"
              : health?.quotaError
                ? "Limits nicht aktualisiert"
                : "Anbieter meldet kein Limit"
        }
      >
        —
      </span>
    );
  return (
    <div className="flex flex-col gap-1 text-[11px] tabular-nums">
      {health.windows.map((window, index) => {
        const remaining = window.remainingPercent;
        const reported = remaining !== null && !window.notInPlan && !window.unlimited;
        return (
          <span
            key={window.id ?? `${window.label}:${index}`}
            className="flex flex-wrap items-center gap-1.5"
            title={`${window.tooltip ?? window.label}${window.resetsAtMs === null ? "" : ` · Reset ${resetLabel(window.resetsAtMs)}`}${health.observedAtMs === null ? "" : ` · gemessen ${new Date(health.observedAtMs).toLocaleString()}`}${health.quotaError ? " · Aktualisierung fehlgeschlagen" : ""}`}
          >
            <span className="shrink-0 flex-1 whitespace-nowrap text-muted-foreground">
              {window.label}
            </span>
            {reported && (
              <span
                role="meter"
                aria-label={`${window.label} verbleibend`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={remaining}
                className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-muted"
              >
                <span
                  className={cn(
                    "block h-full",
                    window.tone === "red"
                      ? "bg-red-500"
                      : window.tone === "yellow"
                        ? "bg-amber-500"
                        : "bg-emerald-500/80",
                  )}
                  style={{ width: `${Math.max(0, Math.min(100, remaining ?? 0))}%` }}
                />
              </span>
            )}
            <span
              className={cn(
                "shrink-0",
                window.tone === "red"
                  ? "text-red-500"
                  : window.tone === "yellow"
                    ? "text-amber-500"
                    : null,
              )}
            >
              {window.notInPlan
                ? "Nicht im Tarif"
                : window.unlimited
                  ? "∞"
                  : remaining === null
                    ? "unbekannt"
                    : `${remaining > 0 && remaining < 1 ? "<1" : Math.floor(remaining)}%`}
            </span>
            {reported && remaining === 0 && (
              <span className="basis-full whitespace-nowrap text-red-500">Limit erreicht</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function WorkjetModelsKeyForm({
  provider,
  account,
  models,
  state,
  onClose,
}: {
  readonly provider: WorkjetGatewayApiKeyProvider;
  readonly account?: WorkjetGatewayAccountSummary;
  readonly models: ReadonlyArray<string>;
  readonly state: WorkjetGatewaySectionState & ModelsManagementState;
  readonly onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState(account?.label ?? WORKJET_GATEWAY_PROVIDER_LABELS[provider]);
  const sharedModels = state.onEditProviderModels !== undefined;
  const [modelText, setModelText] = useState(provider === "kimi" ? "" : models.join(", "));
  const [error, setError] = useState<string | null>(null);
  const providerLabel = WORKJET_GATEWAY_PROVIDER_LABELS[provider];
  const apiKeyError =
    state.apiKey.status === "failed" &&
    state.apiKey.provider === provider &&
    state.apiKey.accountId === account?.id
      ? state.apiKey.message
      : null;
  const message = error ?? apiKeyError;
  const submit = () => {
    // Discover this key's own plan before intersecting shared provider models.
    const selectedModels = provider === "kimi" ? [] : (account?.modelIds ?? models);
    const parsed = sharedModels ? selectedModels : parseModels(modelText);
    if (
      !key.trim() ||
      !label.trim() ||
      !parsed ||
      (account === undefined && provider !== "kimi" && parsed.length === 0)
    ) {
      setError(
        provider === "kimi"
          ? "Kontoname und API-Key eingeben."
          : "Kontoname, API-Key und ein Modell eingeben.",
      );
      return;
    }
    const credential = key;
    setKey("");
    setError(null);
    void state
      .onSaveApiKey(provider, credential, label.trim(), parsed, account?.id)
      .then((saved) => {
        if (saved) onClose();
        else setError(null);
      });
  };
  return (
    <div data-settings-inline-editor="" className="px-3 py-2">
      <InlinePanel
        triggerLabel={account ? "API-Key ersetzen" : `${providerLabel} verbinden`}
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        submitLabel={account ? "Speichern" : "Verbinden"}
        onSubmit={submit}
        busy={state.mutationBusy || state.apiKey.status === "saving"}
        status={message ?? undefined}
        statusTone="error"
      >
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          <input
            data-workjet-action={`models.key-form.${account?.id ?? provider}.label`}
            aria-label="Kontoname"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={160}
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
          />
          <input
            aria-label={account ? `API-Key für ${account.label}` : `API-Key für ${providerLabel}`}
            type="password"
            data-workjet-action={`models.key-form.${account?.id ?? provider}.value`}
            autoComplete="new-password"
            placeholder="API-Key"
            value={key}
            maxLength={512}
            onChange={(event) => setKey(event.target.value)}
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </div>
        {!account && !sharedModels ? (
          <input
            aria-label={`Modelle für ${providerLabel}`}
            placeholder={
              provider === "kimi" ? "Modell-IDs (optional)" : "Modell-IDs, kommagetrennt"
            }
            value={modelText}
            onChange={(event) => setModelText(event.target.value)}
            className="rounded-md border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        ) : null}
      </InlinePanel>
    </div>
  );
}

function accountRowStatus(
  enabled: boolean,
  failing: boolean,
  health: ModelsAccountHealth | undefined,
): { readonly status: RowStatus; readonly label: string } {
  // Words from the central vocabulary (#566); "off" keeps its own word because
  // the switch, not a status, owns that state.
  if (!enabled) return { status: "off", label: "Deaktiviert" };
  const status: WorkjetStatus = failing
    ? "blocked"
    : workjetStatusFromModelsHealth(health?.status ?? "unknown");
  const rowStatus: RowStatus =
    status === "ok" ? "ok" : status === "blocked" ? "error" : status === "missing" ? "off" : "busy";
  return { status: rowStatus, label: workjetStatusWord(status) };
}

function AccountRow({
  account,
  state,
}: {
  readonly account: WorkjetGatewayAccountSummary;
  readonly state: WorkjetGatewaySectionState & ModelsManagementState;
}) {
  const [replaceKey, setReplaceKey] = useState(false);
  const health = state.accountHealth[account.id];
  const isKey =
    account.credentialKind === "api-key" ||
    account.credentialSuffix !== null ||
    !["claude", "codex", "antigravity", "xai"].includes(account.provider);
  const authRequired =
    account.enabled &&
    (health?.status === "auth-required" ||
      state.modelChecks?.some(
        (check) =>
          check.accountId === account.id &&
          check.status === "error" &&
          check.source === "upstream" &&
          check.errorClass === "auth" &&
          check.httpStatus === 401,
      ));
  const accessDenied =
    account.enabled &&
    state.modelChecks?.some(
      (check) =>
        check.accountId === account.id &&
        check.status === "error" &&
        check.source === "upstream" &&
        check.errorClass === "auth" &&
        check.httpStatus === 403,
    );
  const problem =
    account.enabled &&
    (accessDenied || (health && !["ready", "unknown", "disabled"].includes(health.status)));
  const loginHere =
    state.loginAccountId === account.id &&
    ["starting", "pending", "failed"].includes(state.login.status);
  const rowStatus = accountRowStatus(account.enabled, Boolean(problem || authRequired), health);
  const menuActions: Array<RowMenuAction> = [];
  if (state.onCheckModels && !state.checksBusy)
    menuActions.push({ label: "Neu prüfen", onSelect: () => state.onCheckModels?.(account.id) });
  if (isKey && isWorkjetGatewayApiKeyProvider(account.provider))
    menuActions.push({ label: "API-Key ersetzen", onSelect: () => setReplaceKey(true) });
  const offerRecheck = health?.status === "unavailable";
  const problemLine = authRequired
    ? "Anmeldedaten abgelehnt."
    : (health?.message ??
      (accessDenied
        ? "Zugriff verweigert (HTTP 403)."
        : health?.status === "cooldown"
          ? "Konto pausiert."
          : "Anbieter nicht erreichbar."));
  return (
    <div data-account-id={account.id} className={cn(!account.enabled && "text-muted-foreground")}>
      <Row
        status={rowStatus.status}
        statusLabel={rowStatus.label}
        name={
          <InlineField
            action={`models.account.${account.id}.name`}
            label={`Kontoname ${account.label}`}
            value={account.label}
            className="font-medium"
            disabled={state.mutationBusy}
            onSave={(label) =>
              label.length > 0 ? state.onEditAccount(account, { label }) : Promise.resolve(false)
            }
          />
        }
        meta={
          isKey || account.kimiConnection ? (
            <>
              {isKey
                ? `API-Key${account.credentialSuffix === null ? "" : ` ··${account.credentialSuffix}`}`
                : null}
              {account.kimiConnection ? (
                <span title={account.kimiConnection.upstreamBaseUrl}>
                  {isKey ? " · " : ""}
                  {account.kimiConnection.plan === "coding" ? "Coding-Plan" : "API-Plan"}
                </span>
              ) : null}
            </>
          ) : undefined
        }
        chips={<AccountLimits health={health} provider={account.provider} />}
        active={account.enabled}
        activeLabel={`Konto ${account.label} verwenden`}
        onActiveChange={(enabled) => {
          if (!state.mutationBusy) void state.onEditAccount(account, { enabled });
        }}
        onDelete={() => {
          if (!state.mutationBusy) void state.onDeleteAccount(account.id);
        }}
        deleteLabel="Entfernen"
        deleteConfirmTitle="Konto entfernen?"
        menuActions={menuActions}
        menuLabel={`Aktionen für ${account.label}`}
      />
      <div className="min-w-0 px-3 pb-2 pl-8">
        <WorkjetModelsCell
          account={account}
          state={state}
          models={
            state.catalog?.providerModels?.find((entry) => entry.provider === account.provider)
              ?.modelIds
          }
        />
      </div>
      {(problem || authRequired) && !loginHere ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-8 text-xs text-amber-500"
        >
          <span>
            {problemLine}
            {health?.retryAtMs != null && ` Neuer Versuch ab ${resetLabel(health.retryAtMs)}.`}
          </span>
          {authRequired && !isKey ? (
            <Button
              size="xs"
              variant="outline"
              disabled={state.mutationBusy}
              onClick={() =>
                state.onRelogin(account.provider as WorkjetGatewayOauthProvider, account.id)
              }
            >
              Neu anmelden
            </Button>
          ) : authRequired && isKey ? (
            <Button size="xs" variant="outline" onClick={() => setReplaceKey(true)}>
              API-Key ersetzen
            </Button>
          ) : offerRecheck ? (
            <Button size="xs" variant="outline" onClick={state.onRefresh}>
              Neu prüfen
            </Button>
          ) : null}
        </div>
      ) : null}
      {state.accountErrors[account.id] ? (
        <p role="alert" className="px-3 pb-2 pl-8 text-xs text-destructive">
          {state.accountErrors[account.id]}
        </p>
      ) : null}
      {loginHere ? (
        <LoginMessage
          state={state}
          onRetry={() =>
            state.onRelogin(account.provider as WorkjetGatewayOauthProvider, account.id)
          }
        />
      ) : null}
      {replaceKey && isWorkjetGatewayApiKeyProvider(account.provider) ? (
        <WorkjetModelsKeyForm
          provider={account.provider}
          account={account}
          models={account.modelIds}
          state={state}
          onClose={() => setReplaceKey(false)}
        />
      ) : null}
    </div>
  );
}

function LoginMessage({
  state,
  onRetry,
  onCancel,
}: {
  readonly state: WorkjetGatewaySectionState;
  readonly onRetry?: () => void;
  readonly onCancel?: () => void;
}) {
  const login = state.login;
  const cancel = onCancel ?? state.onCancelLogin;
  if (login.status === "starting")
    return (
      <div
        role="status"
        className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground"
      >
        <span>Anmeldung wird geöffnet …</span>
        <Button size="xs" variant="outline" onClick={cancel}>
          Abbrechen
        </Button>
      </div>
    );
  if (login.status === "failed")
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs text-destructive"
      >
        <span>{login.message}</span>
        <Button
          size="xs"
          variant="outline"
          onClick={onRetry ?? (() => state.onAddAccount(login.provider))}
        >
          Erneut anmelden
        </Button>
        <Button size="xs" variant="outline" onClick={cancel}>
          Abbrechen
        </Button>
      </div>
    );
  if (login.status !== "pending") return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs text-muted-foreground"
    >
      <span>Anmeldung im Browser abschließen.</span>
      <Button
        size="xs"
        variant="outline"
        render={<a href={login.authorizationUrl} target="_blank" rel="noreferrer" />}
      >
        Anmeldung öffnen
      </Button>
      <Button size="xs" variant="outline" onClick={cancel}>
        Abbrechen
      </Button>
    </div>
  );
}

function ProviderModelsField({
  provider,
  models,
  state,
}: {
  readonly provider: WorkjetGatewayProvider;
  readonly models: ReadonlyArray<string>;
  readonly state: ModelsManagementState;
}) {
  const providerLabel = WORKJET_GATEWAY_PROVIDER_LABELS[provider];
  const remaining = (state.modelSuggestions?.[provider] ?? []).filter((id) => !models.includes(id));
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionError, setSuggestionError] = useState(false);
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1">
          <InlineField
            value={models.join(", ")}
            multiline
            label={`Modelle für ${providerLabel}`}
            action={`models.provider.${provider}.models`}
            disabled={state.mutationBusy}
            className="font-mono text-[11px]"
            onSave={async (value) => {
              const parsed = parseModels(value);
              return parsed !== null && !!(await state.onEditProviderModels?.(provider, parsed));
            }}
          />
        </div>
        {remaining.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Modellvorschläge für ${providerLabel}`}
                  aria-expanded={showSuggestions}
                  disabled={state.mutationBusy}
                  onClick={() => setShowSuggestions((open) => !open)}
                />
              }
            >
              <PlusIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup>Vorschläge</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {showSuggestions && remaining.length > 0 ? (
        <div
          role="group"
          aria-label={`Modellvorschläge für ${providerLabel}`}
          className="mt-1 flex flex-wrap gap-1"
        >
          {remaining.map((id) => (
            <Button
              key={id}
              size="xs"
              variant="outline"
              className="font-mono"
              disabled={state.mutationBusy}
              onClick={() => {
                setSuggestionError(false);
                void state
                  .onEditProviderModels?.(provider, [...models, id])
                  .then((saved) => setSuggestionError(!saved));
              }}
            >
              <PlusIcon className="size-3" />
              {id}
            </Button>
          ))}
        </div>
      ) : null}
      {suggestionError ? (
        <span role="alert" className="text-xs text-destructive">
          Nicht gespeichert.
        </span>
      ) : null}
    </div>
  );
}

export function WorkjetModelsProviders(state: WorkjetGatewaySectionState & ModelsManagementState) {
  const [adding, setAdding] = useState<WorkjetGatewayProvider | null>(null);
  const [keyProvider, setKeyProvider] = useState<WorkjetGatewayApiKeyProvider | null>(null);
  const accounts = state.catalog?.accounts ?? [];
  useEffect(() => {
    const login = state.login;
    if (
      login.status === "completed" &&
      accounts.some((account) => account.provider === login.provider)
    )
      setAdding(null);
  }, [accounts, state.login]);
  const providers = WORKJET_GATEWAY_PROVIDERS.filter(
    (provider) =>
      accounts.some((account) => account.provider === provider) ||
      adding === provider ||
      (["starting", "pending", "failed"].includes(state.login.status) &&
        state.login.status !== "idle" &&
        state.login.provider === provider),
  );
  const nativeRows = state.nativeProviderRows ?? state.instanceGrok?.row;
  const activeCount =
    accounts.filter((account) => account.enabled).length + (state.instanceGrok?.installed ? 1 : 0);
  const startAdd = (provider: WorkjetGatewayProvider) => {
    setAdding(provider);
    setKeyProvider(null);
    if (provider !== "xai") {
      if (isWorkjetGatewayApiKeyProvider(provider)) setKeyProvider(provider);
      else state.onAddAccount(provider);
    }
  };
  const fault =
    state.statusError ??
    state.catalogError ??
    (state.status?.phase === "faulted" ? "Anbieterverbindung unterbrochen." : null);
  return (
    <section className="space-y-3" aria-label="Anbieter" data-testid="models-providers">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold">Anbieter</h2>
          <span className="text-xs text-muted-foreground">
            {state.isInitialLoading ? "Lädt …" : `${activeCount} aktive Konten`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={
              state.checksBusy ||
              state.instanceGrok?.checking ||
              (!state.onCheckModels && !state.instanceGrok?.hasModels) ||
              (accounts.every((account) => !account.enabled || account.modelIds.length === 0) &&
                !state.instanceGrok?.hasModels)
            }
            data-workjet-action="models.check-all"
            onClick={() => {
              state.onCheckModels?.();
              state.instanceGrok?.checkAll();
            }}
          >
            <CheckIcon className="size-3.5" />
            {state.checksBusy || state.instanceGrok?.checking ? "Prüft …" : "Alle prüfen"}
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Aktualisieren"
                  disabled={state.isRefreshing}
                  onClick={() => {
                    state.onRefresh();
                    state.instanceGrok?.refresh();
                  }}
                />
              }
            >
              <RefreshCwIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Aktualisieren</TooltipPopup>
          </Tooltip>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="sm"
                  disabled={state.mutationBusy}
                  data-workjet-action="models.add-provider"
                />
              }
            >
              <PlusIcon className="size-3.5" />
              Hinzufügen
            </MenuTrigger>
            <MenuPopup align="end">
              {WORKJET_GATEWAY_PROVIDERS.map((provider) => {
                const Icon = WORKJET_GATEWAY_PROVIDER_ICONS[provider];
                return (
                  <MenuItem
                    key={provider}
                    data-workjet-action={`models.provider.${provider}.select`}
                    onClick={() => startAdd(provider)}
                  >
                    <Icon className="size-4" />
                    {WORKJET_GATEWAY_PROVIDER_LABELS[provider]}
                  </MenuItem>
                );
              })}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {fault ? (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-[13.5px]"
        >
          <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate">{fault}</span>
          <Button size="sm" variant="outline" disabled={state.isOperating} onClick={state.onRetry}>
            Neu verbinden
          </Button>
        </div>
      ) : null}
      {state.checksError ? (
        <p role="alert" className="text-xs text-destructive">
          {state.checksError}
        </p>
      ) : null}
      {(state.deferredChecksCount ?? 0) > 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          {state.deferredChecksCount} Prüfungen offen
        </p>
      ) : null}
      {state.isInitialLoading && accounts.length === 0 && !nativeRows ? (
        <EmptyLoading className="py-4" title="Anbieter laden …" onRetry={state.onRefresh} />
      ) : null}
      {nativeRows ? (
        <div className="overflow-x-auto">
          <div role="table" aria-label="Instanz-Konten" className="min-w-0 sm:min-w-[34rem]">
            <div
              role="row"
              className="grid grid-cols-[minmax(0,1fr)_minmax(8.5rem,1fr)_2rem_4rem] items-center gap-x-2 border-b border-border py-2 text-[11px] text-muted-foreground sm:grid-cols-[minmax(9rem,1.15fr)_minmax(0,2fr)_minmax(6rem,.7fr)_2rem_4rem] sm:gap-x-3"
            >
              <span role="columnheader">Konto</span>
              <span role="columnheader" className="hidden sm:block">
                Modelle
              </span>
              <span role="columnheader">Limits</span>
              <span role="columnheader" className="text-center">
                Aktiv
              </span>
              <span role="columnheader" className="sr-only">
                Aktionen
              </span>
            </div>
            {nativeRows}
          </div>
        </div>
      ) : null}
      {nativeRows && providers.length > 0 ? (
        <h3 className="pt-2 text-xs font-semibold text-muted-foreground">Dieser Rechner</h3>
      ) : null}
      {accounts.length === 0 &&
      !state.instanceGrok?.installed &&
      adding === null &&
      !state.isInitialLoading ? (
        <p className="py-4 text-sm text-muted-foreground">Keine Anbieter</p>
      ) : null}
      {providers.map((provider) => {
        const providerAccounts = accounts.filter((account) => account.provider === provider);
        const Icon = WORKJET_GATEWAY_PROVIDER_ICONS[provider];
        const title = WORKJET_GATEWAY_PROVIDER_LABELS[provider];
        const loginHere =
          ["starting", "pending", "failed"].includes(state.login.status) &&
          state.login.status !== "idle" &&
          state.login.provider === provider &&
          state.loginAccountId === null;
        const models = state.catalog?.providerModels?.find((entry) => entry.provider === provider)
          ?.modelIds ?? [...new Set(providerAccounts.flatMap((account) => account.modelIds))];
        return (
          <div key={provider} data-provider={provider} className="rounded-lg border">
            <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
              <Icon className="size-4 shrink-0" />
              <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{title}</h3>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Konto zu ${title} hinzufügen`}
                      data-workjet-action={`models.provider.${provider}.add-account`}
                      disabled={state.mutationBusy}
                      onClick={() => startAdd(provider)}
                    />
                  }
                >
                  <PlusIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Konto hinzufügen</TooltipPopup>
              </Tooltip>
            </div>
            {state.onEditProviderModels ? (
              <div className="border-b border-border/50 px-3 py-2">
                <ProviderModelsField provider={provider} models={models} state={state} />
              </div>
            ) : null}
            <div className="divide-y divide-border/50">
              {providerAccounts.map((account) => (
                <AccountRow key={account.id} account={account} state={state} />
              ))}
            </div>
            {adding === provider && provider === "xai" && keyProvider === null && !loginHere ? (
              <div className="flex flex-wrap gap-2 px-3 py-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    if (state.instanceGrok) {
                      state.instanceGrok.start();
                      setAdding(null);
                    } else state.onAddAccount("xai");
                  }}
                >
                  {state.instanceGrok
                    ? `Grok-Abo auf ${state.instanceGrok.label}`
                    : "Mit Abo anmelden"}
                </Button>
                <Button size="xs" variant="outline" onClick={() => setKeyProvider("xai")}>
                  API-Key hinzufügen
                </Button>
              </div>
            ) : null}
            {keyProvider === provider && isWorkjetGatewayApiKeyProvider(provider) ? (
              <WorkjetModelsKeyForm
                provider={provider}
                models={models}
                state={state}
                onClose={() => {
                  setAdding(null);
                  setKeyProvider(null);
                }}
              />
            ) : null}
            {loginHere ? (
              <LoginMessage
                state={state}
                onCancel={() => {
                  state.onCancelLogin();
                  setAdding(null);
                }}
              />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
