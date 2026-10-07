import type {
  WorkjetGatewayAccountSummary,
  WorkjetGatewayApiKeyProvider,
  WorkjetGatewayOauthProvider,
  WorkjetGatewayProvider,
} from "@workjet/contracts";
import { CheckIcon, EllipsisIcon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";
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
    readonly label: string;
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
  readonly status: "ok" | "error";
  readonly errorClass: string | null;
  readonly checkedAtMs: number;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
}

export interface ModelsManagementState {
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
}: {
  readonly value: string;
  readonly label: string;
  readonly multiline?: boolean;
  readonly disabled?: boolean;
  readonly onSave: (value: string) => Promise<boolean>;
  readonly className?: string;
  readonly action?: string;
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
    <div className="min-w-0">
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
          Not saved. Check your entry and press Enter to try again.
        </span>
      )}
    </div>
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

function AccountLimits({ health }: { readonly health: ModelsAccountHealth | undefined }) {
  if (health?.balance) {
    const balance = health.balance;
    return (
      <span
        className="text-xs tabular-nums"
        title={`${balance.fresh ? "Available" : "Last reported"} API balance · ${new Date(balance.observedAtMs).toLocaleString()}${health.quotaError ? " · Refresh failed" : ""}`}
      >
        {balance.currency}{" "}
        {balance.availableBalance.toLocaleString(undefined, { maximumSignificantDigits: 6 })}
        {!balance.fresh && <span className="ml-1 text-muted-foreground">stale</span>}
      </span>
    );
  }
  if (!health || health.windows.length === 0)
    return (
      <span
        className="text-xs text-muted-foreground"
        title={
          health?.quotaRefreshing
            ? "Checking provider limits"
            : health?.quotaError
              ? "Provider limits could not be refreshed"
              : "This provider does not report limits to the hub."
        }
      >
        —
      </span>
    );
  return (
    <div className="flex flex-col gap-1 text-[11px] tabular-nums">
      {health.windows.map((window) => {
        const remaining = window.remainingPercent;
        const reported = remaining !== null && !window.notInPlan && !window.unlimited;
        return (
          <span
            key={window.label}
            className="flex items-center gap-1.5"
            title={`${window.label}${window.resetsAtMs === null ? "" : ` · resets ${resetLabel(window.resetsAtMs)}`}${health.observedAtMs === null ? "" : ` · observed ${new Date(health.observedAtMs).toLocaleString()}`}${health.quotaError ? " · Refresh failed" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{window.label}</span>
            {reported && (
              <span aria-hidden className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn(
                    "block h-full",
                    remaining === 0 ? "bg-amber-500" : "bg-emerald-500/80",
                  )}
                  style={{ width: `${Math.max(0, Math.min(100, remaining ?? 0))}%` }}
                />
              </span>
            )}
            <span className="shrink-0">
              {window.notInPlan
                ? "No plan"
                : window.unlimited
                  ? "∞"
                  : remaining === null
                    ? "—"
                    : `${remaining > 0 && remaining < 1 ? "<1" : Math.floor(remaining)}%`}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function KeyForm({
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
  const [modelText, setModelText] = useState(models.join(", "));
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      data-settings-inline-editor=""
      className="grid min-w-0 gap-2 border-t border-border/50 py-3 sm:grid-cols-[minmax(10rem,1fr)_minmax(12rem,2fr)_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseModels(modelText);
        if (
          !key.trim() ||
          !label.trim() ||
          !parsed ||
          (account === undefined && parsed.length === 0)
        ) {
          setError("Enter an account name, API key and at least one valid model name.");
          return;
        }
        const credential = key;
        setKey("");
        setError(null);
        void state
          .onSaveApiKey(provider, credential, label.trim(), parsed, account?.id)
          .then((saved) => {
            if (saved) onClose();
            else setError("API key was not saved. Enter it again and retry.");
          });
      }}
    >
      <input
        data-workjet-action={`models.key-form.${account?.id ?? provider}.label`}
        aria-label="Account name"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        maxLength={160}
        className="rounded-md border bg-background px-2 py-1.5 text-sm"
      />
      <input
        aria-label={
          account
            ? `API key for ${account.label}`
            : `API key for ${WORKJET_GATEWAY_PROVIDER_LABELS[provider]}`
        }
        type="password"
        data-workjet-action={`models.key-form.${account?.id ?? provider}.value`}
        autoComplete="new-password"
        placeholder="API-Key"
        value={key}
        maxLength={512}
        onChange={(event) => setKey(event.target.value)}
        className="rounded-md border bg-background px-2 py-1.5 text-sm"
      />
      <div className="flex items-center gap-1">
        <Button
          data-workjet-action={`models.key-form.${account?.id ?? provider}.save`}
          type="submit"
          size="sm"
          disabled={state.mutationBusy || state.apiKey.status === "saving"}
        >
          Connect
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Cancel API key entry"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      {!account && (
        <label className="col-span-full grid gap-1 text-xs text-muted-foreground">
          Models
          <input
            aria-label={`Models for a new ${WORKJET_GATEWAY_PROVIDER_LABELS[provider]} account`}
            placeholder="Model IDs, separated by commas"
            value={modelText}
            onChange={(event) => setModelText(event.target.value)}
            className="rounded-md border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
      )}
      {error && (
        <p role="alert" className="col-span-full text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

const MODELS_TABLE_COLUMNS =
  "grid grid-cols-[minmax(9rem,1.15fr)_minmax(0,2fr)_minmax(6rem,.7fr)_2rem_1.75rem] items-center gap-x-3";

function AccountRow({
  account,
  state,
  grouped,
  onAddAccount,
}: {
  readonly account: WorkjetGatewayAccountSummary;
  readonly state: WorkjetGatewaySectionState & ModelsManagementState;
  readonly grouped: boolean;
  readonly onAddAccount: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
        (check) => check.accountId === account.id && check.errorClass === "auth",
      ));
  const problem =
    account.enabled && health && !["ready", "unknown", "disabled"].includes(health.status);
  const loginHere =
    state.loginAccountId === account.id &&
    ["starting", "pending", "failed"].includes(state.login.status);
  const Icon = WORKJET_GATEWAY_PROVIDER_ICONS[account.provider];
  const title = WORKJET_GATEWAY_PROVIDER_LABELS[account.provider];
  return (
    <div
      role="rowgroup"
      data-account-id={account.id}
      className="border-b border-border/50 last:border-0"
    >
      <div
        role="row"
        className={cn(
          MODELS_TABLE_COLUMNS,
          "min-h-14 py-1.5",
          !account.enabled && "text-muted-foreground",
        )}
      >
        <div role="cell" className="min-w-0">
          {!grouped && (
            <div className="flex h-5 items-center gap-1.5">
              <Icon className="size-4 shrink-0" />
              <span className="truncate text-xs font-medium">{title}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Add account to ${title}`}
                data-workjet-action={`models.provider.${account.provider}.add-account`}
                disabled={state.mutationBusy}
                onClick={onAddAccount}
              >
                <PlusIcon className="size-3" />
              </Button>
            </div>
          )}
          <div className={cn("flex min-w-0 items-center gap-1", grouped && "pl-5")}>
            <div className="min-w-0 flex-1">
              <InlineField
                action={`models.account.${account.id}.name`}
                label={`Account name ${account.label}`}
                value={account.label}
                className="text-[11px] leading-4"
                disabled={state.mutationBusy}
                onSave={(label) =>
                  label.length > 0
                    ? state.onEditAccount(account, { label })
                    : Promise.resolve(false)
                }
              />
            </div>
            {isKey && (
              <button
                type="button"
                onClick={() => setReplaceKey(!replaceKey)}
                className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
                aria-label={`Edit API key for ${account.label}`}
              >
                {account.credentialSuffix === null ? "Key" : `••${account.credentialSuffix}`}
              </button>
            )}
          </div>
        </div>
        <div role="cell" className="min-w-0">
          <WorkjetModelsCell account={account} state={state} />
        </div>
        <div role="cell" className="min-w-0">
          <AccountLimits health={health} />
        </div>
        <div role="cell" className="flex justify-center">
          <label
            className="relative inline-flex cursor-pointer items-center"
            title={account.enabled ? "Disable for Workjet" : "Enable for Workjet"}
          >
            <input
              type="checkbox"
              data-workjet-action={`models.account.${account.id}.enabled`}
              role="switch"
              aria-label={`Use account ${account.label}`}
              checked={account.enabled}
              disabled={state.mutationBusy}
              onChange={(event) => {
                void state.onEditAccount(account, { enabled: event.target.checked });
              }}
              className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            />
            <span
              aria-hidden
              className="h-4 w-7 rounded-full bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:opacity-50"
            >
              <span
                className={cn(
                  "m-0.5 block size-3 rounded-full bg-background transition-transform",
                  account.enabled && "translate-x-3",
                )}
              />
            </span>
          </label>
        </div>
        <div role="cell">
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Actions for ${account.label}`}
                  data-workjet-action={`models.account.${account.id}.menu`}
                />
              }
            >
              <EllipsisIcon className="size-4" />
            </PopoverTrigger>
            <PopoverPopup align="end" viewportClassName="p-1">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                disabled={state.checksBusy || !state.onCheckModels}
                onClick={() => {
                  setMenuOpen(false);
                  state.onCheckModels?.(account.id);
                }}
              >
                <RefreshCwIcon className="size-3.5" />
                Re-check models
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-destructive hover:bg-accent disabled:opacity-50"
                aria-label={`Permanently remove account ${account.label}`}
                data-workjet-action={`models.account.${account.id}.remove-start`}
                disabled={state.mutationBusy}
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmDelete(true);
                }}
              >
                <Trash2Icon className="size-3.5" />
                Remove account
              </button>
            </PopoverPopup>
          </Popover>
        </div>
      </div>
      {(problem || authRequired) && !loginHere && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 pb-2 text-xs text-amber-500"
        >
          <span>
            {authRequired
              ? "Credentials rejected."
              : (health?.message ??
                (health?.status === "cooldown"
                  ? "Limit reached. Available accounts handle new requests."
                  : "Provider unavailable."))}
            {health?.retryAtMs != null && ` Available again: ${resetLabel(health.retryAtMs)}.`}
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
              Re-login
            </Button>
          ) : authRequired && isKey ? (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setReplaceKey(true)}
            >
              Replace API key
            </button>
          ) : (
            health?.status === "unavailable" && (
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={state.onRefresh}
              >
                Check again
              </button>
            )
          )}
        </div>
      )}
      {state.accountErrors[account.id] && (
        <p role="alert" className="pb-2 text-xs text-destructive">
          {state.accountErrors[account.id]}
        </p>
      )}
      {loginHere && (
        <LoginMessage
          state={state}
          onRetry={() =>
            state.onRelogin(account.provider as WorkjetGatewayOauthProvider, account.id)
          }
        />
      )}
      {replaceKey && isWorkjetGatewayApiKeyProvider(account.provider) && (
        <KeyForm
          provider={account.provider}
          account={account}
          models={account.modelIds}
          state={state}
          onClose={() => setReplaceKey(false)}
        />
      )}
      {confirmDelete && (
        <div className="flex flex-wrap items-center gap-2 bg-destructive/5 p-2 text-xs">
          <span>Permanently remove this account and its saved credentials?</span>
          <Button
            size="xs"
            variant="destructive"
            data-workjet-action={`models.account.${account.id}.remove-confirm`}
            disabled={state.mutationBusy}
            onClick={() => {
              void state.onDeleteAccount(account.id).then((removed) => {
                if (removed) setConfirmDelete(false);
              });
            }}
          >
            Remove
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
        </div>
      )}
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
      <div role="status" className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
        Opening sign-in …<button onClick={cancel}>Cancel</button>
      </div>
    );
  if (login.status === "failed")
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 py-2 text-xs text-destructive">
        <span>{login.message}</span>
        <button
          onClick={onRetry ?? (() => state.onAddAccount(login.provider))}
          className="underline underline-offset-2"
        >
          Restart sign-in
        </button>
        <button onClick={cancel}>Cancel</button>
      </div>
    );
  if (login.status !== "pending") return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 py-2 text-xs text-muted-foreground"
    >
      <span>Complete sign-in in your browser.</span>
      <a
        href={login.authorizationUrl}
        target="_blank"
        rel="noreferrer"
        className="text-foreground underline underline-offset-2"
      >
        Open sign-in
      </a>
      <button onClick={cancel} className="text-foreground">
        Cancel
      </button>
    </div>
  );
}

export function WorkjetModelsProviders(state: WorkjetGatewaySectionState & ModelsManagementState) {
  const [pickerOpen, setPickerOpen] = useState(false);
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
  const startAdd = (provider: WorkjetGatewayProvider) => {
    setPickerOpen(false);
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
    (state.status?.phase === "faulted" ? "Provider connection interrupted." : null);
  return (
    <section className="space-y-3" aria-label="LLM providers" data-testid="models-providers">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold">LLM providers</h2>
          <span className="text-xs text-muted-foreground">
            {state.isInitialLoading
              ? "Loading…"
              : `${accounts.filter((account) => account.enabled).length} active accounts`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={
              state.checksBusy ||
              !state.onCheckModels ||
              accounts.every((account) => !account.enabled || account.modelIds.length === 0)
            }
            data-workjet-action="models.check-all"
            onClick={() => state.onCheckModels?.()}
          >
            <CheckIcon className="size-3.5" />
            {state.checksBusy ? "Checking…" : "Check all"}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh provider status"
            disabled={state.isRefreshing}
            onClick={state.onRefresh}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger
              render={
                <Button
                  size="sm"
                  disabled={state.mutationBusy}
                  data-workjet-action="models.add-provider"
                />
              }
            >
              <PlusIcon className="size-3.5" />
              Add provider
            </PopoverTrigger>
            <PopoverPopup align="end" aria-label="Choose provider" viewportClassName="p-1">
              {WORKJET_GATEWAY_PROVIDERS.map((provider) => {
                const Icon = WORKJET_GATEWAY_PROVIDER_ICONS[provider];
                return (
                  <button
                    data-workjet-action={`models.provider.${provider}.select`}
                    key={provider}
                    type="button"
                    onClick={() => startAdd(provider)}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
                  >
                    <Icon className="size-4" />
                    {WORKJET_GATEWAY_PROVIDER_LABELS[provider]}
                  </button>
                );
              })}
            </PopoverPopup>
          </Popover>
        </div>
      </div>
      {fault && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 p-2 text-xs"
        >
          <span>{fault}</span>
          <Button size="xs" variant="outline" disabled={state.isOperating} onClick={state.onRetry}>
            Reconnect
          </Button>
        </div>
      )}
      {state.checksError && (
        <p role="alert" className="text-xs text-destructive">
          {state.checksError}
        </p>
      )}
      {(state.deferredChecksCount ?? 0) > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {state.deferredChecksCount} model checks remaining.
          {!state.checksBusy && " Use Check all to continue."}
        </p>
      )}
      {accounts.length === 0 && adding === null && !state.isInitialLoading && (
        <p className="py-4 text-sm text-muted-foreground">
          Add a provider and connect through subscription sign-in or an API key.
        </p>
      )}
      <div className="overflow-x-auto">
        <div role="table" aria-label="LLM provider accounts" className="min-w-[34rem]">
          <div
            role="row"
            className={cn(
              MODELS_TABLE_COLUMNS,
              "border-b border-border py-2 text-[11px] text-muted-foreground",
            )}
          >
            <span role="columnheader">Provider / account</span>
            <span role="columnheader">Models</span>
            <span role="columnheader">Limits</span>
            <span role="columnheader" className="text-center">
              Active
            </span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {providers.map((provider) => {
            const providerAccounts = accounts.filter((account) => account.provider === provider);
            const models = [...new Set(providerAccounts.flatMap((account) => account.modelIds))];
            const Icon = WORKJET_GATEWAY_PROVIDER_ICONS[provider];
            const title = WORKJET_GATEWAY_PROVIDER_LABELS[provider];
            const loginHere =
              ["starting", "pending", "failed"].includes(state.login.status) &&
              state.login.status !== "idle" &&
              state.login.provider === provider &&
              state.loginAccountId === null;
            const grouped = providerAccounts.length > 1;
            return (
              <div key={provider} data-provider={provider}>
                {(grouped || providerAccounts.length === 0) && (
                  <div className="flex items-center gap-1.5 border-b border-border/50 pt-2 pb-1">
                    <Icon className="size-4" />
                    <h3 className="text-xs font-medium">{title}</h3>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Add account to ${title}`}
                      data-workjet-action={`models.provider.${provider}.add-account`}
                      disabled={state.mutationBusy}
                      onClick={() => startAdd(provider)}
                    >
                      <PlusIcon className="size-3" />
                    </Button>
                  </div>
                )}
                {providerAccounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    state={state}
                    grouped={grouped}
                    onAddAccount={() => startAdd(provider)}
                  />
                ))}
                {adding === provider &&
                  provider === "xai" &&
                  keyProvider === null &&
                  !loginHere && (
                    <div className="flex gap-2 py-2">
                      <Button size="xs" variant="outline" onClick={() => state.onAddAccount("xai")}>
                        Sign in with subscription
                      </Button>
                      <Button size="xs" variant="outline" onClick={() => setKeyProvider("xai")}>
                        Add API key
                      </Button>
                    </div>
                  )}
                {keyProvider === provider && isWorkjetGatewayApiKeyProvider(provider) && (
                  <KeyForm
                    provider={provider}
                    models={models}
                    state={state}
                    onClose={() => {
                      setAdding(null);
                      setKeyProvider(null);
                    }}
                  />
                )}
                {loginHere && (
                  <LoginMessage
                    state={state}
                    onCancel={() => {
                      state.onCancelLogin();
                      setAdding(null);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
