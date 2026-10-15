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
} from "@workjet/contracts";
import {
  CheckCircle2Icon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  AntigravityIcon,
  ClaudeAI,
  KimiIcon,
  MiniMaxIcon,
  OpenAI,
  XaiIcon,
  ZaiIcon,
} from "../Icons";
import type * as React from "react";
import { useState, useEffect } from "react";

import { Button } from "../ui/button";
import { InlineExpand } from "../ui/inline-expand";
import { InlinePanel } from "../ui/inline-panel";
import { Row } from "../ui/row";
import { Spinner } from "../ui/spinner";
import { cn } from "~/lib/utils";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  formatWorkjetGatewayAccountPatternCount,
  WorkjetGatewayModelCountsHelp,
} from "./WorkjetGatewayModelCountsHelp";

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

/** The provider marks the Swift app shipped, ported to Icons.tsx. */
export const WORKJET_GATEWAY_PROVIDER_ICONS: Readonly<
  Record<WorkjetGatewayProvider, React.FC<React.SVGProps<SVGSVGElement>>>
> = {
  claude: ClaudeAI,
  codex: OpenAI,
  antigravity: AntigravityIcon,
  zai: ZaiIcon,
  minimax: MiniMaxIcon,
  xai: XaiIcon,
  kimi: KimiIcon,
};

export const WORKJET_GATEWAY_PROVIDER_LABELS: Readonly<Record<WorkjetGatewayProvider, string>> = {
  claude: "Claude",
  codex: "Codex (OpenAI)",
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
      readonly accountId?: string;
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
  "kimi-key-not-accepted",
  "api-key-model-list-unavailable",
  "invalid-model-selection",
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
  if (reason === null) return "Gateway-Vorgang fehlgeschlagen.";
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
  return trimmed === "" ? null : `API-Key ••••${trimmed}`;
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
  if (!member.enabled) return "Deaktiviert";
  return member.selectable ? "In Rotation" : "Zurückgestellt";
}

export function workjetGatewayPhaseSummary(status: WorkjetGatewayStatus | null): string {
  if (status === null) return "Kein Rechner gewählt";
  switch (status.phase) {
    case "ready":
      return `Bereit · ${status.configuredAccountCount} Konten · ${status.configuredModelCount} Modelle`;
    case "starting":
      return "Startet …";
    case "stopping":
      return "Stoppt …";
    case "stopped":
      return "Gestoppt";
    case "faulted":
      return status.failureReason === null
        ? "Gestört"
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
        Gateway wird geprüft …
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
    <p
      role="status"
      className={status?.phase === "faulted" ? "text-destructive" : "text-foreground"}
    >
      {status?.phase === "ready" ? (
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2Icon className="size-3.5 text-success" />
          {summary}
        </span>
      ) : (
        summary
      )}
    </p>
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
        {providerLabel}-Anmeldung wird vorbereitet …
      </div>
    );
  }
  if (login.status === "pending") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span role="status" className="flex items-center gap-2">
          <Spinner className="size-3.5" />
          {providerLabel}-Anmeldung im Browser abschließen.
        </span>
        <Button type="button" size="xs" variant="outline" onClick={onCancel}>
          Anmeldung abbrechen
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
        ? `${providerLabel}-Konto hinzugefügt.`
        : `${login.accountIds.length} ${providerLabel}-Konten hinzugefügt.`}
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
    <div data-settings-inline-editor="">
      <InlinePanel
        triggerLabel={`${providerLabel} API-Key`}
        open
        onOpenChange={(open) => {
          if (open || isSaving) return;
          setValue("");
          onDismiss();
        }}
        submitLabel="Speichern"
        onSubmit={submit}
        submitDisabled={disabled || value.trim() === ""}
        busy={isSaving}
      >
        <input
          id={fieldId}
          aria-label={`${providerLabel} API-Key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={WORKJET_GATEWAY_API_KEY_MAX_INPUT_LENGTH}
          value={value}
          disabled={disabled || isSaving}
          placeholder="API-Key einfügen"
          onChange={(event) => setValue(event.target.value)}
          className="min-w-0 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        />
      </InlinePanel>
    </div>
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
        {providerLabel}-Key wird gespeichert …
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
      {providerLabel}-Konto hinzugefügt.
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
  // Visible refresh feedback: the WS refetch can answer in tens of
  // milliseconds, which read as "the button does nothing". Hold the spinner
  // long enough to be seen; the data still comes from the real refetch.
  const [refreshSpinUntil, setRefreshSpinUntil] = useState(0);
  const [, forceSpinTick] = useState(0);
  const refreshSpinning = state.isRefreshing || Date.now() < refreshSpinUntil;
  useEffect(() => {
    if (Date.now() >= refreshSpinUntil) return;
    const id = setTimeout(() => forceSpinTick((tick) => tick + 1), refreshSpinUntil - Date.now());
    return () => clearTimeout(id);
  }, [refreshSpinUntil]);
  // Which provider's key field is open. Only one at a time, so a pasted key
  // can never be left visible in a second collapsed row.
  const [openApiKeyProvider, setOpenApiKeyProvider] = useState<WorkjetGatewayApiKeyProvider | null>(
    null,
  );

  /**
   * Does the gateway serve ANY model for this provider? An account with no
   * recorded models is normal; a provider without catalog AND without recorded
   * models cannot answer a request. `null` means discovery has not answered.
   */
  const providerServesModels = (provider: WorkjetGatewayProvider): boolean | null => {
    const entry = state.pools?.models?.providers.find(
      (item: { readonly provider: WorkjetGatewayProvider }) => item.provider === provider,
    );
    return entry === undefined ? null : entry.models.length > 0;
  };

  // Connected first: those are the rows with state worth reading.
  const providersWithAccounts = WORKJET_GATEWAY_PROVIDERS.filter(
    (provider) => workjetGatewayAccountsByProvider(state.catalog, provider).length > 0,
  );
  const providersWithoutAccounts = WORKJET_GATEWAY_PROVIDERS.filter(
    (provider) => workjetGatewayAccountsByProvider(state.catalog, provider).length === 0,
  );

  return (
    <SettingsSection
      id={searchableSetting("workjet-provider-accounts").id}
      title={searchableSetting("workjet-provider-accounts").title}
      headerAction={
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              // Minimum spin so a fast WebSocket refetch still shows feedback.
              setRefreshSpinUntil(Date.now() + 900);
              state.onRefresh();
            }}
            disabled={refreshSpinning}
          >
            <RefreshCwIcon className={refreshSpinning ? "size-3.5 animate-spin" : "size-3.5"} />
            Aktualisieren
          </Button>
          {/* A faulted gateway is the one state the user cannot wait out. */}
          {phase === "faulted" ? (
            <Button type="button" size="sm" onClick={state.onRetry} disabled={state.isOperating}>
              {state.isOperating ? <Spinner className="size-3.5" /> : null}
              Gateway neu starten
            </Button>
          ) : null}
        </div>
      }
    >
      <SettingsRow
        title="Gateway"
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
          title="Konten fehlen"
          status={
            <span role="alert" className="flex items-start gap-1.5 text-destructive">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              {state.catalogError}
            </span>
          }
        />
      ) : null}

      {(
        [
          ["Verbunden", providersWithAccounts],
          ["Verfügbar", providersWithoutAccounts],
        ] as ReadonlyArray<readonly [string, ReadonlyArray<WorkjetGatewayProvider>]>
      ).map(([groupLabel, providers]) =>
        providers.length === 0 ? null : (
          <div key={groupLabel} className="px-3 sm:px-4">
            <h4 className="pt-3 pb-1 text-[11px] font-medium text-muted-foreground">
              {groupLabel}
            </h4>
            <div className="divide-y divide-border/40">
              {providers.map((provider) => {
                const accounts = workjetGatewayAccountsByProvider(state.catalog, provider);
                const isActiveLogin =
                  state.login.status !== "idle" && state.login.provider === provider;
                const isApiKey = isWorkjetGatewayApiKeyProvider(provider);
                const isKeyFormOpen = isApiKey && openApiKeyProvider === provider;
                const ProviderIcon = WORKJET_GATEWAY_PROVIDER_ICONS[provider];
                return (
                  <div key={provider} className="py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2 truncate text-sm font-medium text-foreground">
                        <ProviderIcon className="size-4 shrink-0 text-foreground/80" aria-hidden />
                        {WORKJET_GATEWAY_PROVIDER_LABELS[provider]}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {/* xAI is BOTH kinds of account: subscription login and API key. */}
                        {provider === "xai" ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={!canAdd}
                            onClick={() => state.onAddAccount("xai")}
                          >
                            <PlusIcon className="size-3.5" />
                            {accounts.length === 0 ? "Konto hinzufügen" : "Weiteres Konto"}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
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
                          {provider === "xai"
                            ? "API-Key hinzufügen"
                            : accounts.length === 0
                              ? isApiKey
                                ? "API-Key hinzufügen"
                                : "Konto hinzufügen"
                              : "Weiteres Konto"}
                        </Button>
                      </span>
                    </div>

                    {accounts.map((account) => {
                      const suffix = maskGatewayCredentialSuffix(account.credentialSuffix);
                      const serves = providerServesModels(provider);
                      const rotation =
                        gatewayAccountRotationLabel(state.catalog, account) ??
                        (account.enabled ? "Aktiv" : "Deaktiviert");
                      return (
                        <Row
                          key={account.id}
                          className="px-0"
                          status={serves === false ? "error" : account.enabled ? "ok" : "off"}
                          statusLabel={rotation}
                          name={account.label}
                          meta={suffix ?? undefined}
                          chips={
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 text-xs",
                                serves === false ? "text-amber-500" : "text-muted-foreground",
                              )}
                            >
                              {serves === false ? "liefert keine Modelle · " : ""}
                              {account.modelIds.length > 0 ? (
                                <>
                                  {formatWorkjetGatewayAccountPatternCount(account.modelIds.length)}{" "}
                                  erfasst
                                  <WorkjetGatewayModelCountsHelp /> ·{" "}
                                </>
                              ) : null}
                              {rotation}
                            </span>
                          }
                          onDelete={() => state.onRemoveAccount(account.id)}
                          deleteLabel="Entfernen"
                          deleteConfirmTitle="Konto entfernen?"
                          menuActions={
                            isApiKey || !canAdd || isActiveLogin
                              ? []
                              : [
                                  {
                                    label: "Neu anmelden",
                                    onSelect: () => state.onAddAccount(provider),
                                  },
                                ]
                          }
                          menuLabel={`Aktionen für ${account.label}`}
                        />
                      );
                    })}

                    {isApiKey ? (
                      <InlineExpand
                        label={WORKJET_GATEWAY_PROVIDER_LABELS[provider]}
                        open={isKeyFormOpen}
                        onOpenChange={(open) => {
                          if (!open) setOpenApiKeyProvider(null);
                        }}
                      >
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
                      </InlineExpand>
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
