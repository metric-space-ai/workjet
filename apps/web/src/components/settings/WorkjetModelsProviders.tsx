import type {
  WorkjetGatewayAccountSummary,
  WorkjetGatewayApiKeyProvider,
  WorkjetGatewayOauthProvider,
  WorkjetGatewayProvider,
  WorkjetGatewayModelCheck,
} from "@workjet/contracts";
import { CheckIcon, LoaderIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
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
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SEGMENT_TOGGLE_CLASS } from "../ctox/InstanceAddInline";
import {
  setProviderDraft,
  updateProviderDraft,
  useProviderDraft,
  type ProviderDraft,
} from "./providerDraft";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useUiText } from "../../hooks/useUiText";
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
  /** Startet das Abo auf der Instanz; liefert den Rohcode eines Fehlers oder null. */
  readonly start: () => Promise<string | null>;
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

export function AccountLimits({ health }: { readonly health: ModelsAccountHealth | undefined }) {
  if (health?.balance) {
    const balance = health.balance;
    return (
      <div className="flex flex-col gap-1 text-xs">
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
  // Unknown limits are not information: show nothing instead of "—"/"unbekannt" (#610).
  const windows = (health?.windows ?? []).filter(
    (window) => window.notInPlan || window.unlimited || window.remainingPercent !== null,
  );
  if (!health || windows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-[11px] tabular-nums">
      {windows.map((window, index) => {
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
                  : `${(remaining ?? 0) > 0 && (remaining ?? 0) < 1 ? "<1" : Math.floor(remaining ?? 0)}%`}
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
  onSaved,
}: {
  readonly provider: WorkjetGatewayApiKeyProvider;
  readonly account?: WorkjetGatewayAccountSummary;
  readonly models: ReadonlyArray<string>;
  readonly state: WorkjetGatewaySectionState & ModelsManagementState;
  readonly onClose: () => void;
  /** Called instead of onClose once the key is saved. */
  readonly onSaved?: () => void;
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
    // Pasted keys often carry a trailing newline or space.
    const credential = key.trim();
    setKey("");
    setError(null);
    void state
      .onSaveApiKey(provider, credential, label.trim(), parsed, account?.id)
      .then((saved) => {
        if (saved) (onSaved ?? onClose)();
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
  const [editModels, setEditModels] = useState(false);
  const t = useUiText();
  const health = state.accountHealth[account.id];
  const ProviderIcon = WORKJET_GATEWAY_PROVIDER_ICONS[account.provider];
  const providerModels =
    state.catalog?.providerModels?.find((entry) => entry.provider === account.provider)?.modelIds ??
    account.modelIds;
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
  // One action set for every account row (#610): check, models, credentials.
  const menuActions: Array<RowMenuAction> = [];
  if (state.onCheckModels)
    menuActions.push({
      label: t("Neu prüfen", "Check again"),
      onSelect: () => {
        if (!state.checksBusy) state.onCheckModels?.(account.id);
      },
    });
  if (state.onEditProviderModels)
    menuActions.push({
      label: t("Modelle bearbeiten", "Edit models"),
      onSelect: () => setEditModels(true),
    });
  if (isKey && isWorkjetGatewayApiKeyProvider(account.provider))
    menuActions.push({
      label: t("API-Key ersetzen", "Replace API key"),
      onSelect: () => setReplaceKey(true),
    });
  else if (!isKey)
    menuActions.push({
      label: t("Neu anmelden", "Sign in again"),
      onSelect: () => state.onRelogin(account.provider as WorkjetGatewayOauthProvider, account.id),
    });
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
        className="py-1.5"
        name={
          <span className="flex min-w-0 items-center gap-2">
            <ProviderIcon
              role="img"
              aria-label={WORKJET_GATEWAY_PROVIDER_LABELS[account.provider]}
              className="size-4 shrink-0"
            />
            {rowStatus.status === "error" ? (
              <span className="sr-only">{rowStatus.label}</span>
            ) : null}
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
          </span>
        }
        meta={
          <span className="pl-6">
            {isKey
              ? `API-Key${account.credentialSuffix === null ? "" : ` ··${account.credentialSuffix}`}`
              : t("Abo", "Subscription")}
            {account.kimiConnection ? (
              <span title={account.kimiConnection.upstreamBaseUrl}>
                {" · "}
                {account.kimiConnection.plan === "coding"
                  ? t("Coding-Plan", "Coding plan")
                  : t("API-Plan", "API plan")}
              </span>
            ) : null}
          </span>
        }
        chips={<AccountLimits health={health} />}
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
      <div className="min-w-0 px-3 pb-1.5 pl-9">
        <WorkjetModelsCell
          account={account}
          state={state}
          models={
            state.catalog?.providerModels?.find((entry) => entry.provider === account.provider)
              ?.modelIds
          }
        />
      </div>
      {editModels && state.onEditProviderModels ? (
        <div className="min-w-0 px-3 pb-2 pl-9">
          <ProviderModelsField
            provider={account.provider}
            models={providerModels}
            state={state}
            onDone={() => setEditModels(false)}
          />
        </div>
      ) : null}
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
  onDone,
}: {
  readonly provider: WorkjetGatewayProvider;
  readonly models: ReadonlyArray<string>;
  readonly state: ModelsManagementState;
  readonly onDone?: () => void;
}) {
  const t = useUiText();
  const providerLabel = WORKJET_GATEWAY_PROVIDER_LABELS[provider];
  const remaining = (state.modelSuggestions?.[provider] ?? []).filter((id) => !models.includes(id));
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
        {onDone ? (
          <Button size="xs" variant="ghost" onClick={onDone}>
            {t("Fertig", "Done")}
          </Button>
        ) : null}
      </div>
      {remaining.length > 0 ? (
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
  const t = useUiText();
  const draft = useProviderDraft();
  const accounts = state.catalog?.accounts ?? [];
  // A completed login ends the draft only once its account really exists.
  useEffect(() => {
    const login = state.login;
    if (
      draft !== null &&
      login.status === "completed" &&
      login.provider === draft.provider &&
      accounts.some((account) => account.provider === login.provider)
    )
      setProviderDraft(null);
  }, [accounts, state.login, draft]);
  const providers = WORKJET_GATEWAY_PROVIDERS.filter((provider) =>
    accounts.some((account) => account.provider === provider),
  );
  const nativeRows = state.nativeProviderRows ?? state.instanceGrok?.row;
  const startAdd = (provider: WorkjetGatewayProvider) => {
    const key = isWorkjetGatewayApiKeyProvider(provider);
    // xAI offers both: the card opens on its choice; key-only providers open
    // their key field; subscription-only providers start their login.
    setProviderDraft({
      provider,
      mode: provider === "xai" || !key ? "subscription" : "key",
      keyFormOpen: key && provider !== "xai",
    });
    if (!key) state.onAddAccount(provider as WorkjetGatewayOauthProvider);
  };
  const fault =
    state.statusError ??
    state.catalogError ??
    (state.status?.phase === "faulted" ? "Anbieterverbindung unterbrochen." : null);
  const checking = Boolean(state.checksBusy || state.instanceGrok?.checking);
  // A login started outside a draft (e.g. re-login from elsewhere) keeps its own message.
  const orphanLogin =
    ["starting", "pending", "failed"].includes(state.login.status) &&
    state.login.status !== "idle" &&
    state.loginAccountId === null &&
    draft?.provider !== state.login.provider
      ? state.login.provider
      : null;
  return (
    <section className="space-y-3" aria-label="Anbieter" data-testid="models-providers">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("Anbieter", "Providers")}</h2>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={
              checking ||
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
            {checking ? (
              <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
            Alle prüfen
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
      {state.isInitialLoading && accounts.length === 0 && !nativeRows && draft === null ? (
        <EmptyLoading className="py-4" title="Anbieter laden …" onRetry={state.onRefresh} />
      ) : null}
      {nativeRows ? (
        <div className="overflow-x-auto">
          <div role="table" aria-label="Instanz-Konten" className="min-w-0 sm:min-w-[34rem]">
            <div role="row" className="sr-only">
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
      {nativeRows && (providers.length > 0 || draft !== null) ? (
        <h3 className="pt-2 text-xs font-semibold text-muted-foreground">Dieser Rechner</h3>
      ) : null}
      {accounts.length === 0 &&
      !state.instanceGrok?.installed &&
      draft === null &&
      !state.isInitialLoading ? (
        <p className="py-4 text-sm text-muted-foreground">Keine Anbieter</p>
      ) : null}
      {/* One list, one row pattern for every account; the provider is the row icon (#610). */}
      {accounts.length > 0 || draft !== null ? (
        <div className="divide-y divide-border/50 rounded-lg border" data-testid="models-accounts">
          {providers.flatMap((provider) =>
            accounts
              .filter((account) => account.provider === provider)
              .map((account) => (
                <div key={account.id} data-provider={provider}>
                  <AccountRow account={account} state={state} />
                </div>
              )),
          )}
          {draft !== null ? <DraftAccountRow draft={draft} state={state} /> : null}
        </div>
      ) : null}
      {orphanLogin !== null ? (
        <div data-provider-add={orphanLogin} className="rounded-lg border">
          <LoginMessage state={state} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Der gewählte Anbieter als volle Zeile im selben Raster wie die Konten:
 * Symbol, Name, Kontozeile, die Wahl Abo | API-Key in der Zeile, Modelle,
 * Schalter, Entfernen. Ein Fehler setzt nichts zurück; nur „Entfernen“
 * verwirft den Entwurf.
 */
function DraftAccountRow({
  draft,
  state,
}: {
  readonly draft: ProviderDraft;
  readonly state: WorkjetGatewaySectionState & ModelsManagementState;
}) {
  const { provider } = draft;
  const t = useUiText();
  const [instanceFailure, setInstanceFailure] = useState<string | null>(null);
  const [instanceBusy, setInstanceBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const Icon = WORKJET_GATEWAY_PROVIDER_ICONS[provider];
  const label = WORKJET_GATEWAY_PROVIDER_LABELS[provider];
  const keyProvider = isWorkjetGatewayApiKeyProvider(provider) ? provider : null;
  const subscription = provider === "xai" || keyProvider === null;
  const both = provider === "xai";
  const models =
    state.catalog?.providerModels?.find((entry) => entry.provider === provider)?.modelIds ?? [];
  const loginHere =
    state.login.status !== "idle" &&
    ["starting", "pending", "failed"].includes(state.login.status) &&
    state.login.provider === provider &&
    state.loginAccountId === null;
  const startInstance = async () => {
    const grok = state.instanceGrok;
    if (!grok) return;
    setInstanceBusy(true);
    setInstanceFailure(null);
    setShowDetails(false);
    const failure = await grok.start();
    setInstanceBusy(false);
    setInstanceFailure(failure);
  };
  const startLocal = () => {
    setInstanceFailure(null);
    state.onAddAccount(provider as WorkjetGatewayOauthProvider);
  };
  return (
    <div data-provider-draft={provider} data-provider-add={provider}>
      <Row
        className="py-1.5"
        name={
          <span className="flex min-w-0 items-center gap-2">
            <Icon role="img" aria-label={label} className="size-4 shrink-0" />
            <span className="truncate font-medium">{label}</span>
          </span>
        }
        meta={
          <span className="pl-6">
            {draft.mode === "key" ? "API-Key" : t("Abo", "Subscription")}
          </span>
        }
        chips={
          both ? (
            <ToggleGroup
              aria-label="Art des Kontos"
              size="xs"
              variant="outline"
              value={[draft.mode]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "subscription" || next === "key")
                  updateProviderDraft({ mode: next, keyFormOpen: next === "key" });
              }}
            >
              <Toggle className={SEGMENT_TOGGLE_CLASS} value="subscription">
                Abo
              </Toggle>
              <Toggle className={SEGMENT_TOGGLE_CLASS} value="key">
                API-Key
              </Toggle>
            </ToggleGroup>
          ) : undefined
        }
        active={false}
        activeDisabled
        activeLabel={`Konto ${label} verwenden`}
        onActiveChange={() => {}}
        onDelete={() => {
          if (loginHere) state.onCancelLogin();
          setProviderDraft(null);
        }}
        undoableDelete
        deleteLabel="Entfernen"
      />
      {models.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1 px-3 pb-1.5 pl-9">
          {models.map((modelId) => (
            <span
              key={modelId}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {modelId}
            </span>
          ))}
        </div>
      ) : null}
      {draft.mode === "subscription" && subscription && !loginHere ? (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-9">
          <Button
            size="xs"
            data-workjet-action={`models.provider.${provider}.subscription.local`}
            disabled={state.mutationBusy}
            onClick={startLocal}
          >
            Anmelden
          </Button>
          {provider === "xai" && state.instanceGrok && !state.instanceGrok.installed ? (
            <Button
              size="xs"
              variant="outline"
              data-workjet-action="models.provider.xai.subscription.instance"
              disabled={instanceBusy}
              onClick={() => void startInstance()}
            >
              {instanceBusy ? (
                <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
              ) : null}
              Auf {state.instanceGrok.label} anmelden
            </Button>
          ) : null}
        </div>
      ) : null}
      {instanceFailure !== null && state.instanceGrok ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-9 text-xs text-destructive"
          data-workjet-draft-failure=""
        >
          <span>Anmeldung auf {state.instanceGrok.label} nicht gestartet.</span>
          <Button size="xs" variant="outline" onClick={() => void startInstance()}>
            Erneut
          </Button>
          <Button size="xs" variant="outline" onClick={() => setShowDetails((open) => !open)}>
            Details
          </Button>
          {showDetails ? (
            <code className="w-full font-mono text-[11px] text-muted-foreground">
              {instanceFailure}
            </code>
          ) : null}
        </div>
      ) : null}
      {draft.mode === "key" && keyProvider !== null ? (
        draft.keyFormOpen ? (
          <WorkjetModelsKeyForm
            provider={keyProvider}
            models={models}
            state={state}
            onClose={() => updateProviderDraft({ keyFormOpen: false })}
            onSaved={() => setProviderDraft(null)}
          />
        ) : (
          <div className="px-3 pb-2 pl-9">
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateProviderDraft({ keyFormOpen: true })}
            >
              API-Key eingeben
            </Button>
          </div>
        )
      ) : null}
      {loginHere ? <LoginMessage state={state} onCancel={state.onCancelLogin} /> : null}
    </div>
  );
}
