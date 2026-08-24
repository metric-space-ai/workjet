import {
  WorkjetGatewayOperationError,
  type WorkjetGatewayAccountSummary,
  type WorkjetGatewayModelDiscovery,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayApiKeyProvider,
  type WorkjetGatewayFailureReason,
  type WorkjetGatewayOauthProvider,
  type WorkjetGatewayProvider,
  type WorkjetGatewayStatus,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { cn } from "~/lib/utils";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * The gateway's own provider catalog. These are LLM accounts owned by the
 * Workjet provider gateway, deliberately unrelated to the Code harness
 * provider drivers (Codex, Claude, Grok) shown in Providers settings.
 */
export const WORKJET_GATEWAY_OAUTH_PROVIDERS: ReadonlyArray<WorkjetGatewayOauthProvider> = [
  "claude",
  "codex",
  "antigravity",
];

/**
 * Providers added by pasting a key rather than by a browser login. They sit in
 * the same list as the OAuth providers because they are the same kind of thing
 * to the user — an LLM account the gateway owns — and differ only in how the
 * credential arrives.
 */
export const WORKJET_GATEWAY_API_KEY_PROVIDERS: ReadonlyArray<WorkjetGatewayApiKeyProvider> = [
  "zai",
  "minimax",
  "xai",
  "kimi",
];

export const WORKJET_GATEWAY_PROVIDERS: ReadonlyArray<WorkjetGatewayProvider> = [
  ...WORKJET_GATEWAY_OAUTH_PROVIDERS,
  ...WORKJET_GATEWAY_API_KEY_PROVIDERS,
];

export const WORKJET_GATEWAY_PROVIDER_LABELS: Readonly<Record<WorkjetGatewayProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  zai: "Z.ai (GLM)",
  minimax: "MiniMax",
  xai: "xAI (Grok)",
  kimi: "Kimi (Moonshot)",
};

export function isWorkjetGatewayApiKeyProvider(
  provider: WorkjetGatewayProvider,
): provider is WorkjetGatewayApiKeyProvider {
  return (WORKJET_GATEWAY_API_KEY_PROVIDERS as ReadonlyArray<string>).includes(provider);
}

/** Longest key the add-key field accepts, mirroring the contract's bound. */
export const WORKJET_GATEWAY_API_KEY_MAX_INPUT_LENGTH = 512;

/** Three seconds is short enough to feel immediate and slow enough not to hammer the host. */
export const WORKJET_GATEWAY_OAUTH_POLL_INTERVAL_MS = 3_000;
/** ~5 minutes of polling; a browser login that takes longer has effectively been abandoned. */
export const WORKJET_GATEWAY_OAUTH_POLL_MAX_ATTEMPTS = 100;

/**
 * Progress of the one operation that carries a credential. The key value is
 * never part of this state: it lives in the field until it is dispatched and
 * is cleared immediately afterwards.
 */
export type WorkjetGatewayApiKeyState =
  | { readonly status: "idle" }
  | { readonly status: "saving"; readonly provider: WorkjetGatewayApiKeyProvider }
  | {
      readonly status: "failed";
      readonly provider: WorkjetGatewayApiKeyProvider;
      readonly message: string;
    }
  | { readonly status: "completed"; readonly provider: WorkjetGatewayApiKeyProvider };

export type WorkjetGatewayLoginState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly provider: WorkjetGatewayOauthProvider }
  | {
      readonly status: "pending";
      readonly provider: WorkjetGatewayOauthProvider;
      readonly state: string;
      readonly authorizationUrl: string;
    }
  | {
      readonly status: "failed";
      readonly provider: WorkjetGatewayOauthProvider;
      readonly message: string;
    }
  | {
      readonly status: "completed";
      readonly provider: WorkjetGatewayOauthProvider;
      readonly accountIds: ReadonlyArray<string>;
    };

export interface WorkjetGatewaySectionState {
  readonly status: WorkjetGatewayStatus | null;
  readonly catalog: WorkjetGatewayCatalog | null;
  readonly isInitialLoading: boolean;
  readonly isRefreshing: boolean;
  readonly statusError: string | null;
  readonly catalogError: string | null;
  readonly isOperating: boolean;
  readonly login: WorkjetGatewayLoginState;
  readonly onRefresh: () => void;
  /**
   * Recovery only. The server autostarts the gateway when a login begins, so
   * the happy path never asks the user to start anything; this is offered
   * exclusively as a retry on a faulted gateway.
   */
  readonly onRetry: () => void;
  readonly onAddAccount: (provider: WorkjetGatewayOauthProvider) => void;
  readonly onCancelLogin: () => void;
  readonly apiKey: WorkjetGatewayApiKeyState;
  /**
   * Submit one API key. The caller must not retain the value: it goes straight
   * to the server over the existing gateway RPC and is never logged or echoed.
   */
  readonly onAddApiKey: (provider: WorkjetGatewayApiKeyProvider, apiKey: string) => void;
  /** Removes one account; the server deletes its secrets and reloads. */
  readonly onRemoveAccount: (accountId: string) => void;
}

const GATEWAY_FAILURE_REASONS = new Set<WorkjetGatewayFailureReason>([
  "host-unavailable",
  "invalid-configuration",
  "secret-unavailable",
  "startup-timeout",
  "invalid-readiness",
  "management-unavailable",
  "process-exit",
  "shutdown-timeout",
  "gateway-not-ready",
  "oauth-unavailable",
  "oauth-session-invalid",
]);

/**
 * Reuse the contract's own operation copy for every reason it already names, so
 * the surface never invents a second wording for a documented failure.
 */
export function workjetGatewayFailureDescription(error: unknown): string {
  const reason =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "WorkjetGatewayOperationError" &&
    "reason" in error &&
    typeof error.reason === "string" &&
    GATEWAY_FAILURE_REASONS.has(error.reason as WorkjetGatewayFailureReason)
      ? (error.reason as WorkjetGatewayFailureReason)
      : null;
  if (reason === null) return "The Workjet provider gateway operation failed.";
  return new WorkjetGatewayOperationError({ reason }).message;
}

/**
 * A login that fails or outlives the bounded poll window is the same thing from
 * the surface's point of view: the session no longer exists.
 */
export function workjetGatewayOauthSessionInvalidMessage(): string {
  return new WorkjetGatewayOperationError({ reason: "oauth-session-invalid" }).message;
}

/** The opaque session handle is shown only as a short recognizable stub. */
export function maskGatewayOauthState(state: string): string {
  const trimmed = state.trim();
  if (trimmed.length <= 8) return "•".repeat(Math.max(trimmed.length, 1));
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function workjetGatewayAccountsByProvider(
  catalog: WorkjetGatewayCatalog | null,
  provider: WorkjetGatewayProvider,
): ReadonlyArray<WorkjetGatewayAccountSummary> {
  return (catalog?.accounts ?? []).filter((account) => account.provider === provider);
}

/**
 * The server autostarts the gateway when a login begins, so a stopped or
 * starting gateway must not block the add-account affordance — otherwise a
 * surface without a start button would be a dead end. Only a faulted or
 * stopping gateway, an in-flight lifecycle operation, or a live login blocks
 * it; a faulted gateway is recovered through the retry affordance instead.
 */
export function canAddWorkjetGatewayAccount(state: {
  readonly status: WorkjetGatewayStatus | null;
  readonly login: WorkjetGatewayLoginState;
  readonly isOperating: boolean;
  readonly apiKey?: WorkjetGatewayApiKeyState;
}): boolean {
  if (state.isOperating) return false;
  if (state.login.status === "starting" || state.login.status === "pending") return false;
  if (state.apiKey?.status === "saving") return false;
  const phase = state.status?.phase;
  return phase === "ready" || phase === "stopped" || phase === "starting";
}

/** Renders the recognition suffix, or nothing when no suffix was recorded. */
export function maskGatewayCredentialSuffix(suffix: string | null): string | null {
  const trimmed = suffix?.trim() ?? "";
  return trimmed === "" ? null : `Key ••••${trimmed}`;
}

/**
 * Whether the gateway would currently pick this account, taken from the
 * derived pool rather than guessed from `enabled`. An enabled account whose
 * provider pool holds it back behind a higher priority is not "Enabled" in any
 * useful sense, and saying so is the whole point.
 *
 * `null` means the catalog carries no pool for this account yet, in which case
 * the row says nothing rather than assuming.
 */
export function gatewayAccountRotationLabel(
  catalog: WorkjetGatewayCatalog | null,
  account: WorkjetGatewayAccountSummary,
): string | null {
  const pool = (catalog?.providerPools ?? []).find((entry) => entry.provider === account.provider);
  const member = pool?.members.find((entry) => entry.accountId === account.id);
  if (member === undefined) return null;
  if (!member.enabled) return "Disabled";
  return member.selectable ? "In rotation" : "Held back by priority";
}

export function workjetGatewayPhaseSummary(status: WorkjetGatewayStatus | null): string {
  if (status === null) return "Select a primary environment to inspect its provider gateway.";
  switch (status.phase) {
    case "ready":
      return `Ready · ${status.configuredAccountCount} accounts · ${status.configuredModelCount} models`;
    case "starting":
      return "Starting…";
    case "stopping":
      return "Stopping…";
    case "stopped":
      return "Stopped";
    case "faulted":
      return status.failureReason === null
        ? "Faulted"
        : new WorkjetGatewayOperationError({ reason: status.failureReason }).message;
  }
}

function GatewayRuntimeStatus({
  status,
  isInitialLoading,
  statusError,
}: {
  readonly status: WorkjetGatewayStatus | null;
  readonly isInitialLoading: boolean;
  readonly statusError: string | null;
}) {
  if (isInitialLoading) {
    return (
      <div role="status" className="flex items-center gap-2">
        <Spinner className="size-3.5" />
        Checking the provider gateway…
      </div>
    );
  }
  if (statusError !== null) {
    return (
      <div role="alert" className="flex items-start gap-1.5 text-destructive">
        <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        {statusError}
      </div>
    );
  }
  const summary = workjetGatewayPhaseSummary(status);
  return (
    <div role="status" className="space-y-0.5">
      <p className={status?.phase === "faulted" ? "text-destructive" : "text-foreground"}>
        {status?.phase === "ready" ? (
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2Icon className="size-3.5 text-success" />
            {summary}
          </span>
        ) : (
          summary
        )}
      </p>
      {status?.providerEndpoint ? (
        <p className="break-all font-mono text-[11px]">{status.providerEndpoint}</p>
      ) : null}
    </div>
  );
}

function AddAccountProgress({
  login,
  onCancel,
}: {
  readonly login: WorkjetGatewayLoginState;
  readonly onCancel: () => void;
}) {
  if (login.status === "idle") return null;
  const providerLabel = WORKJET_GATEWAY_PROVIDER_LABELS[login.provider];

  if (login.status === "starting") {
    return (
      <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        Preparing the {providerLabel} login…
      </div>
    );
  }
  if (login.status === "pending") {
    return (
      <div className="space-y-1 text-xs text-muted-foreground">
        <p role="status" className="flex items-center gap-2">
          <Spinner className="size-3.5" />
          Finish the {providerLabel} login in your browser, then return here.
        </p>
        <p>
          Login session <span className="font-mono">{maskGatewayOauthState(login.state)}</span>.
          Workjet never sees your credentials.
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel login
        </Button>
      </div>
    );
  }
  if (login.status === "failed") {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
        <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        {login.message}
      </p>
    );
  }
  return (
    <p role="status" className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-success" />
      {login.accountIds.length === 1
        ? `Added one ${providerLabel} account.`
        : `Added ${login.accountIds.length} ${providerLabel} accounts.`}
    </p>
  );
}

/**
 * Bounded key entry. The value lives only in this component's state and is
 * cleared the moment it is submitted or the form is dismissed; it is never put
 * into a URL, a toast, or the account list.
 */
function AddApiKeyForm({
  provider,
  disabled,
  apiKey,
  onSubmit,
  onDismiss,
}: {
  readonly provider: WorkjetGatewayApiKeyProvider;
  readonly disabled: boolean;
  readonly apiKey: WorkjetGatewayApiKeyState;
  readonly onSubmit: (value: string) => void;
  readonly onDismiss: () => void;
}) {
  const [value, setValue] = useState("");
  const fieldId = `workjet-gateway-api-key-${provider}`;
  const providerLabel = WORKJET_GATEWAY_PROVIDER_LABELS[provider];
  const isSaving = apiKey.status === "saving" && apiKey.provider === provider;
  const submit = () => {
    const trimmed = value.trim();
    if (trimmed === "" || disabled || isSaving) return;
    setValue("");
    onSubmit(trimmed);
  };

  return (
    <form
      className="mt-1 space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={fieldId} className="block text-xs text-muted-foreground">
        {providerLabel} API key
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={fieldId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={WORKJET_GATEWAY_API_KEY_MAX_INPUT_LENGTH}
          value={value}
          disabled={disabled || isSaving}
          placeholder="Paste the key"
          onChange={(event) => setValue(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        />
        <Button type="submit" size="sm" disabled={disabled || isSaving || value.trim() === ""}>
          {isSaving ? <Spinner className="size-3.5" /> : null}
          Save key
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isSaving}
          onClick={() => {
            setValue("");
            onDismiss();
          }}
        >
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The key is stored on the server and never shown again. This list keeps only its last four
        characters.
      </p>
    </form>
  );
}

function AddApiKeyProgress({
  provider,
  apiKey,
}: {
  readonly provider: WorkjetGatewayApiKeyProvider;
  readonly apiKey: WorkjetGatewayApiKeyState;
}) {
  if (apiKey.status === "idle" || apiKey.provider !== provider) return null;
  const providerLabel = WORKJET_GATEWAY_PROVIDER_LABELS[provider];
  if (apiKey.status === "saving") {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        Storing the {providerLabel} key…
      </p>
    );
  }
  if (apiKey.status === "failed") {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
        <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        {apiKey.message}
      </p>
    );
  }
  return (
    <p role="status" className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-success" />
      Added a {providerLabel} account.
    </p>
  );
}

export function WorkjetGatewayAccountsSectionView(
  state: WorkjetGatewaySectionState & {
    /**
     * Model discovery, supplied by useWorkjetGatewaySection alongside the
     * account state. Optional so a caller that only has accounts still type
     * checks; without it no account is ever marked as serving nothing, which
     * is the safe direction — a false alarm is worse than a missing one.
     */
    readonly pools?: { readonly models: WorkjetGatewayModelDiscovery | null } | undefined;
  },
) {
  const phase = state.status?.phase ?? null;
  const canAdd = canAddWorkjetGatewayAccount(state);
  // Which provider's key field is open. Only one at a time, so a pasted key
  // can never be left visible in a second collapsed row.
  const [openApiKeyProvider, setOpenApiKeyProvider] = useState<WorkjetGatewayApiKeyProvider | null>(
    null,
  );

  /**
   * Does the gateway serve ANY model for this provider?
   *
   * Two different things look alike and must not be conflated. An account's
   * `modelIds` are the models recorded ON THE ACCOUNT; the gateway's catalog
   * is what it serves for the provider. An account with no recorded models is
   * completely normal — Claude serves 15 catalog models with zero recorded on
   * the account. What is NOT normal is a provider the gateway has no catalog
   * for and no recorded models either: that account cannot answer a request.
   *
   * `null` means discovery has not answered yet, which is not a fault to show.
   */
  const providerServesModels = (provider: WorkjetGatewayProvider): boolean | null => {
    const entry = state.pools?.models?.providers.find(
      (item: { readonly provider: WorkjetGatewayProvider }) => item.provider === provider,
    );
    return entry === undefined ? null : entry.models.length > 0;
  };

  // Connected first: those are the rows with state worth reading. The rest is
  // a short menu of what can still be added.
  const providersWithAccounts = WORKJET_GATEWAY_PROVIDERS.filter(
    (provider) => workjetGatewayAccountsByProvider(state.catalog, provider).length > 0,
  );
  const providersWithoutAccounts = WORKJET_GATEWAY_PROVIDERS.filter(
    (provider) => workjetGatewayAccountsByProvider(state.catalog, provider).length === 0,
  );

  return (
    <SettingsSection
      id={searchableSetting("workjet-provider-accounts").id}
      title="LLM providers"
      headerAction={
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={state.onRefresh}
            disabled={state.isRefreshing}
          >
            <RefreshCwIcon className={state.isRefreshing ? "size-3.5 animate-spin" : "size-3.5"} />
            Refresh
          </Button>
          {/*
            No start control in the happy path: the server starts the gateway
            when a login begins. A faulted gateway is the one state the user
            cannot wait out, so recovery is offered there and nowhere else.
          */}
          {phase === "faulted" ? (
            <Button type="button" size="sm" onClick={state.onRetry} disabled={state.isOperating}>
              {state.isOperating ? <Spinner className="size-3.5" /> : null}
              Retry gateway
            </Button>
          ) : null}
        </div>
      }
    >
      <SettingsRow
        title="Provider gateway"
        description="Connect the LLM accounts the provider gateway routes through on the selected server. Harnesses are CLI runtimes, live under Settings → Harnesses, and never appear here."
        status={
          <GatewayRuntimeStatus
            status={state.status}
            isInitialLoading={state.isInitialLoading}
            statusError={state.statusError}
          />
        }
      />

      {state.catalogError !== null ? (
        <SettingsRow
          title="Accounts unavailable"
          status={
            <span role="alert" className="flex items-start gap-1.5 text-destructive">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              {state.catalogError}
            </span>
          }
        />
      ) : null}

      {/*
        A DENSE list, not SettingsRow. SettingsRow is built for one sparse
        setting at a time; used per provider it spent ~180px on a single line
        of fact, repeated "No accounts are configured. This provider is added
        with an API key." next to a button that already says "Add API key",
        and printed "1 account configured." directly above the one account.
        Seven providers became a page nobody could scan.

        Connected providers come first because they are the ones with state
        worth reading. The rest are a short menu of what can still be added.
      */}
      {(
        [
          ["Connected", providersWithAccounts],
          ["Available", providersWithoutAccounts],
        ] as ReadonlyArray<readonly [string, ReadonlyArray<WorkjetGatewayProvider>]>
      ).map(([groupLabel, providers]) =>
        providers.length === 0 ? null : (
          <div key={groupLabel} className="px-3 sm:px-4">
            <h4 className="pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
              {groupLabel}
            </h4>
            <div className="divide-y divide-border/40">
              {providers.map((provider) => {
                const accounts = workjetGatewayAccountsByProvider(state.catalog, provider);
                const isActiveLogin =
                  state.login.status !== "idle" && state.login.provider === provider;
                const isApiKey = isWorkjetGatewayApiKeyProvider(provider);
                const isKeyFormOpen = isApiKey && openApiKeyProvider === provider;
                return (
                  <div key={provider} className="py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-medium text-foreground">
                        {WORKJET_GATEWAY_PROVIDER_LABELS[provider]}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {/* xAI is BOTH kinds of account: a Grok subscription
                            arrives by device-code browser login, an API key
                            by paste — so it alone carries both buttons. */}
                        {provider === "xai" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={!canAdd}
                            onClick={() => state.onAddAccount("xai")}
                          >
                            <PlusIcon className="size-3.5" />
                            Add account
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={!canAdd || isKeyFormOpen}
                          onClick={() =>
                            isApiKey
                              ? setOpenApiKeyProvider(provider)
                              : state.onAddAccount(provider)
                          }
                        >
                          {isApiKey ? (
                            <KeyRoundIcon className="size-3.5" />
                          ) : (
                            <PlusIcon className="size-3.5" />
                          )}
                          {accounts.length === 0
                            ? isApiKey
                              ? "Add API key"
                              : "Add account"
                            : "Add another"}
                        </Button>
                      </span>
                    </div>

                    {accounts.map((account) => {
                      const suffix = maskGatewayCredentialSuffix(account.credentialSuffix);
                      const serves = providerServesModels(provider);
                      return (
                        <div
                          key={account.id}
                          className="flex flex-wrap items-baseline justify-between gap-x-3 pl-3 text-xs"
                        >
                          <span className="min-w-0 truncate text-muted-foreground">
                            {account.label}
                            {suffix === null ? null : (
                              <span className="text-muted-foreground/60"> · {suffix}</span>
                            )}
                          </span>
                          <span
                            className={cn(
                              "flex shrink-0 items-center gap-2",
                              serves === false ? "text-amber-500" : "text-muted-foreground/70",
                            )}
                          >
                            <span>
                              {serves === false ? "serves no models · " : ""}
                              {/*
                                Explicitly "recorded on this account", never a
                                bare model count: the bare number reads as what
                                the provider serves, which is the gateway
                                catalog and a different figure entirely.
                              */}
                              {account.modelIds.length > 0
                                ? `${account.modelIds.length} ${account.modelIds.length === 1 ? "model" : "models"} recorded · `
                                : ""}
                              {gatewayAccountRotationLabel(state.catalog, account) ??
                                (account.enabled ? "Enabled" : "Disabled")}
                            </span>
                            {/* Per-access re-login, as in the Swift original
                                (ProviderAccountsView: "Neu anmelden" on the
                                access). Same begin flow as adding — logging
                                into the same identity updates this account's
                                secrets — but the affordance sits WHERE the
                                expired access is, instead of asking the
                                operator to know that "Add another" heals it. */}
                            {isApiKey ? null : (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1.5 text-[11px]"
                                disabled={!canAdd || isActiveLogin}
                                onClick={() => state.onAddAccount(provider)}
                              >
                                Re-login
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-1.5 text-[11px] text-destructive hover:text-destructive"
                              aria-label={`Remove account ${account.label}`}
                              disabled={!canAdd}
                              onClick={() => state.onRemoveAccount(account.id)}
                            >
                              <Trash2Icon className="size-3" />
                            </Button>
                          </span>
                        </div>
                      );
                    })}

                    {isKeyFormOpen ? (
                      <div className="pt-2">
                        <AddApiKeyForm
                          provider={provider}
                          disabled={!canAdd}
                          apiKey={state.apiKey}
                          onSubmit={(value) => state.onAddApiKey(provider, value)}
                          onDismiss={() => setOpenApiKeyProvider(null)}
                        />
                      </div>
                    ) : null}
                    {isApiKey ? (
                      <AddApiKeyProgress provider={provider} apiKey={state.apiKey} />
                    ) : null}
                    {isActiveLogin ? (
                      <AddAccountProgress login={state.login} onCancel={state.onCancelLogin} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ),
      )}
    </SettingsSection>
  );
}
