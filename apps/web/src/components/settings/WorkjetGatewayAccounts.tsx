import {
  WorkjetGatewayOperationError,
  type WorkjetGatewayAccountSummary,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayFailureReason,
  type WorkjetGatewayProvider,
  type WorkjetGatewayStatus,
} from "@t3tools/contracts";
import { CheckCircle2Icon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * The gateway's own provider catalog. These are LLM accounts owned by the
 * Workjet provider gateway, deliberately unrelated to the Code harness
 * provider drivers (Codex, Claude, Grok) shown in Providers settings.
 */
export const WORKJET_GATEWAY_PROVIDERS: ReadonlyArray<WorkjetGatewayProvider> = [
  "claude",
  "codex",
  "antigravity",
];

export const WORKJET_GATEWAY_PROVIDER_LABELS: Readonly<Record<WorkjetGatewayProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};

/** Three seconds is short enough to feel immediate and slow enough not to hammer the host. */
export const WORKJET_GATEWAY_OAUTH_POLL_INTERVAL_MS = 3_000;
/** ~5 minutes of polling; a browser login that takes longer has effectively been abandoned. */
export const WORKJET_GATEWAY_OAUTH_POLL_MAX_ATTEMPTS = 100;

export type WorkjetGatewayLoginState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly provider: WorkjetGatewayProvider }
  | {
      readonly status: "pending";
      readonly provider: WorkjetGatewayProvider;
      readonly state: string;
      readonly authorizationUrl: string;
    }
  | {
      readonly status: "failed";
      readonly provider: WorkjetGatewayProvider;
      readonly message: string;
    }
  | {
      readonly status: "completed";
      readonly provider: WorkjetGatewayProvider;
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
  readonly onAddAccount: (provider: WorkjetGatewayProvider) => void;
  readonly onCancelLogin: () => void;
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
}): boolean {
  if (state.isOperating) return false;
  if (state.login.status === "starting" || state.login.status === "pending") return false;
  const phase = state.status?.phase;
  return phase === "ready" || phase === "stopped" || phase === "starting";
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

export function WorkjetGatewayAccountsSectionView(state: WorkjetGatewaySectionState) {
  const phase = state.status?.phase ?? null;
  const canAdd = canAddWorkjetGatewayAccount(state);

  return (
    <SettingsSection
      id={searchableSetting("workjet-provider-accounts").id}
      title="Workjet gateway accounts"
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
        description="These are the LLM accounts owned by the Workjet provider gateway on the selected server. The harness runtimes above are CLI runtimes, not LLM accounts, and are never listed here."
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

      {WORKJET_GATEWAY_PROVIDERS.map((provider) => {
        const accounts = workjetGatewayAccountsByProvider(state.catalog, provider);
        const isActiveLogin = state.login.status !== "idle" && state.login.provider === provider;
        return (
          <SettingsRow
            key={provider}
            title={WORKJET_GATEWAY_PROVIDER_LABELS[provider]}
            description={
              accounts.length === 0
                ? "No accounts are configured for this provider."
                : `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"} configured.`
            }
            control={
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canAdd}
                onClick={() => state.onAddAccount(provider)}
              >
                <PlusIcon className="size-3.5" />
                Add account
              </Button>
            }
          >
            <div className="mt-1 space-y-2 pb-3.5">
              {accounts.map((account) => (
                <div
                  key={account.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-border/40 pt-2 first:border-t-0 first:pt-0"
                >
                  <span className="min-w-0 truncate text-sm text-foreground">{account.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {account.enabled ? "Enabled" : "Disabled"} · {account.modelIds.length}{" "}
                    {account.modelIds.length === 1 ? "model" : "models"}
                  </span>
                </div>
              ))}
              {isActiveLogin ? (
                <AddAccountProgress login={state.login} onCancel={state.onCancelLogin} />
              ) : null}
            </div>
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
