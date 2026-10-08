import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@workjet/client-runtime/state/runtime";
import type {
  EnvironmentId,
  WorkjetGatewayAccountSummary,
  WorkjetGatewayCatalog,
  WorkjetGatewayApiKeyProvider,
  WorkjetGatewayOauthProvider,
  WorkjetGatewayUpdateRoutingInput,
} from "@workjet/contracts";
import { WorkjetGatewayAccountId } from "@workjet/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  workjetGatewayFailureDescription,
  workjetGatewayOauthSessionInvalidMessage,
  WORKJET_GATEWAY_OAUTH_POLL_INTERVAL_MS,
  WORKJET_GATEWAY_PROVIDER_LABELS,
  WORKJET_GATEWAY_OAUTH_POLL_MAX_ATTEMPTS,
  type WorkjetGatewayApiKeyState,
  type WorkjetGatewayLoginState,
  type WorkjetGatewaySectionState,
} from "./WorkjetGatewayAccounts";
import type {
  WorkjetGatewayPoolsSectionState,
  WorkjetGatewayRoutingState,
} from "./WorkjetGatewayPools";
import type { ModelsManagementState } from "./WorkjetModelsProviders";
import { modelsAccountHealth } from "./WorkjetModelsHealth";
import {
  createModelCheckPass,
  remainingModelChecks,
  type ModelCheckPass,
} from "./WorkjetModelsChecks";

/**
 * Runtime state for the Workjet provider-gateway account surface.
 *
 * Extracted from the Workjet settings page so the single provider surface
 * (Settings → Providers) owns the interactive gateway section while the
 * Workjet page keeps read-only access to the account catalog for LLM routes.
 * No RPC is renamed or moved: this is the same set of environment commands the
 * Workjet page dispatched before.
 */
export function useWorkjetGatewaySection(
  environmentId: EnvironmentId | null,
): WorkjetGatewaySectionState &
  ModelsManagementState & { readonly pools: WorkjetGatewayPoolsSectionState } {
  const statusQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetGatewayStatus({ environmentId, input: {} }),
  );
  const catalogQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetGatewayCatalog({ environmentId, input: {} }),
  );
  const healthQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetGatewayHealth({ environmentId, input: {} }),
  );
  const modelsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetGatewayModels({ environmentId, input: {} }),
  );
  const checksQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetGatewayModelChecks({ environmentId, input: {} }),
  );
  const checkModels = useAtomCommand(serverEnvironment.checkWorkjetGatewayModels, {
    reportFailure: false,
  });
  const [checksSubmitting, setChecksSubmitting] = useState(false);
  const [checksError, setChecksError] = useState<string | null>(null);
  const checksFlight = useRef<object | null>(null);
  const checksPollingDeadline = useRef(0);
  const checksPolls = useRef(0);
  const checksPass = useRef<ModelCheckPass | null>(null);
  const [recoveryAccounts, setRecoveryAccounts] = useState<ReadonlyArray<string>>([]);
  const runChecks = useCallback(
    async (accountId?: string, force = false, continuation = false) => {
      if (environmentId === null || checksFlight.current !== null || checksQuery.data === null)
        return;
      if (!continuation) {
        checksPass.current = createModelCheckPass(
          catalogQuery.data?.accounts ?? [],
          checksQuery.data.checks,
          Date.now(),
          accountId,
          force,
        );
        checksPollingDeadline.current = Date.now() + 20 * 60_000;
        checksPolls.current = 0;
      }
      const flight = {};
      checksFlight.current = flight;
      setChecksSubmitting(true);
      setChecksError(null);
      try {
        const result = await checkModels({
          environmentId,
          input: {
            force,
            ...(accountId ? { accountId: WorkjetGatewayAccountId.make(accountId) } : {}),
          },
        });
        if (checksFlight.current !== flight) return;
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
          setChecksError("Model checks could not finish. Check the provider connection and retry.");
        // Check all may adopt a legacy key origin and its verified live IDs.
        if (!continuation) catalogQuery.refresh();
        checksQuery.refresh();
      } finally {
        if (checksFlight.current === flight) {
          checksFlight.current = null;
          setChecksSubmitting(false);
        }
      }
    },
    [
      environmentId,
      checkModels,
      checksQuery.refresh,
      checksQuery.data,
      catalogQuery.data,
      catalogQuery.refresh,
    ],
  );
  const checksBusy =
    checksSubmitting || (checksError === null && (checksQuery.data?.pending.length ?? 0) > 0);
  useEffect(() => {
    if (
      environmentId === null ||
      statusQuery.data?.phase !== "ready" ||
      checksSubmitting ||
      checksFlight.current !== null ||
      checksQuery.data === null
    )
      return;
    const next = recoveryAccounts.find(
      (id) =>
        (catalogQuery.data?.accounts ?? []).some(
          (account) => account.id === id && account.enabled,
        ) && !checksQuery.data?.pending.some((pending) => pending.accountId === id),
    );
    if (!next) return;
    setRecoveryAccounts((previous) => previous.filter((id) => id !== next));
    // Re-authentication keeps the stable account ID and model list. Bypass
    // results from the old credential after its pending checks have ended.
    void runChecks(next, true);
  }, [
    environmentId,
    statusQuery.data?.phase,
    checksSubmitting,
    checksQuery.data,
    catalogQuery.data,
    recoveryAccounts,
    runChecks,
  ]);
  useEffect(() => {
    checksPollingDeadline.current = 0;
    checksPolls.current = 0;
    checksPass.current = null;
    setRecoveryAccounts([]);
    setChecksSubmitting(false);
    setChecksError(null);
    return () => {
      checksFlight.current = null;
    };
  }, [environmentId]);
  useEffect(() => {
    if (environmentId === null || checksSubmitting || checksError !== null || !checksQuery.data)
      return;
    const { pending, deferredCount } = checksQuery.data;
    if (pending.length === 0 && deferredCount === 0) return;
    if (checksQuery.error !== null) {
      setChecksError("Model check status could not be loaded. Retry the checks.");
      return;
    }
    const pass = checksPass.current;
    if (
      pending.length === 0 &&
      (pass === null ||
        remainingModelChecks(pass, catalogQuery.data?.accounts ?? [], checksQuery.data.checks) ===
          0)
    )
      return;
    if (checksPollingDeadline.current === 0)
      checksPollingDeadline.current = Date.now() + 20 * 60_000;
    if (Date.now() >= checksPollingDeadline.current || checksPolls.current >= 600) {
      setChecksError("Model checks timed out. Retry the checks.");
      return;
    }
    // Only this mounted page owns the timer. Completed observations persist
    // server-side; each continuation admits a bounded batch from this finite pass.
    const timer = setTimeout(() => {
      checksPolls.current += 1;
      if (pending.length > 0) checksQuery.refresh();
      else if (pass !== null) void runChecks(pass.accountId, pass.force, true);
    }, 2_000);
    return () => clearTimeout(timer);
  }, [
    environmentId,
    checksSubmitting,
    checksError,
    checksQuery.data,
    checksQuery.error,
    checksQuery.refresh,
    catalogQuery.data,
    runChecks,
  ]);

  const modelFingerprint = JSON.stringify(
    (catalogQuery.data?.accounts ?? []).map((account) => [
      account.id,
      account.enabled,
      account.modelIds,
    ]),
  );
  const autoCheckedFingerprint = useRef<string | null>(null);
  useEffect(() => {
    if (
      statusQuery.data?.phase !== "ready" ||
      catalogQuery.data === null ||
      checksQuery.data === null ||
      checksSubmitting ||
      checksFlight.current !== null
    )
      return;
    const key = `${environmentId}:${modelFingerprint}`;
    if (autoCheckedFingerprint.current === key) return;
    autoCheckedFingerprint.current = key;
    void runChecks();
  }, [
    environmentId,
    modelFingerprint,
    statusQuery.data?.phase,
    catalogQuery.data,
    checksQuery.data,
    checksSubmitting,
    runChecks,
  ]);

  const updateRouting = useAtomCommand(serverEnvironment.updateWorkjetGatewayRouting, {
    reportFailure: false,
  });
  const startGateway = useAtomCommand(serverEnvironment.startWorkjetGateway, {
    reportFailure: false,
  });
  const startGatewayOauth = useAtomCommand(serverEnvironment.startWorkjetGatewayOauth, {
    reportFailure: false,
  });
  const pollGatewayOauth = useAtomCommand(serverEnvironment.pollWorkjetGatewayOauth, {
    reportFailure: false,
  });
  const cancelGatewayOauth = useAtomCommand(serverEnvironment.cancelWorkjetGatewayOauth, {
    reportFailure: false,
  });
  const addApiKeyAccount = useAtomCommand(serverEnvironment.addWorkjetGatewayApiKeyAccount, {
    reportFailure: false,
  });
  const removeAccount = useAtomCommand(serverEnvironment.removeWorkjetGatewayAccount, {
    reportFailure: false,
  });
  const [login, setLogin] = useState<WorkjetGatewayLoginState>({ status: "idle" });
  const [loginAccountId, setLoginAccountId] = useState<string | null>(null);
  const [accountErrors, setAccountErrors] = useState<Readonly<Record<string, string>>>({});
  const [editedCatalog, setEditedCatalog] = useState<WorkjetGatewayCatalog | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  useEffect(() => {
    setEditedCatalog(null);
  }, [catalogQuery.data]);
  const [apiKey, setApiKey] = useState<WorkjetGatewayApiKeyState>({ status: "idle" });
  // Guards a second submit while one key is in flight; the value itself is
  // never held here.
  const apiKeyRef = useRef(false);
  const [isOperating, setIsOperating] = useState(false);
  const operationRef = useRef(false);
  // One live login at a time; the token lets an unmount or a cancel stop the
  // bounded poll loop without leaving a detached timer running.
  const loginRef = useRef<{ aborted: boolean } | null>(null);

  useEffect(
    () => () => {
      if (loginRef.current) loginRef.current.aborted = true;
    },
    [],
  );

  const [routing, setRouting] = useState<WorkjetGatewayRoutingState>({ status: "idle" });
  const routingRef = useRef(false);
  const quotaPollAttempts = useRef(0);
  useEffect(() => {
    if (
      !(healthQuery.data?.accounts ?? []).some((account) => account.quotaRefreshing) ||
      quotaPollAttempts.current >= 30
    )
      return;
    const timer = setTimeout(() => {
      quotaPollAttempts.current += 1;
      healthQuery.refresh();
    }, 2_000);
    return () => clearTimeout(timer);
  }, [healthQuery]);
  useEffect(() => {
    if (
      environmentId === null ||
      statusQuery.data?.phase !== "ready" ||
      healthQuery.data === null ||
      healthQuery.isPending
    )
      return;
    const now = Date.now();
    const deadlines = healthQuery.data.accounts
      .flatMap((account) => [
        account.cooldownUntilMs,
        ...account.quota.flatMap((window) => [window.resetsAtMs, window.observedAtMs + 300_000]),
      ])
      .filter((deadline): deadline is number => deadline !== null && deadline > now);
    // One owned timer while this page is mounted. Reset and freshness boundaries
    // refresh real readings; unmounting or a new response cancels the timer.
    const delay = Math.max(
      1_000,
      Math.min(300_000, ...deadlines.map((deadline) => deadline - now)),
    );
    const timer = setTimeout(() => {
      quotaPollAttempts.current = 0;
      healthQuery.refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [
    environmentId,
    healthQuery.data,
    healthQuery.isPending,
    healthQuery.refresh,
    statusQuery.data?.phase,
  ]);
  const clearAccountError = (accountId: string) =>
    setAccountErrors((previous) => {
      const next = { ...previous };
      delete next[accountId];
      return next;
    });

  const refresh = useCallback(() => {
    quotaPollAttempts.current = 0;
    statusQuery.refresh();
    catalogQuery.refresh();
    healthQuery.refresh();
    modelsQuery.refresh();
    checksQuery.refresh();
  }, [catalogQuery, healthQuery, modelsQuery, statusQuery, checksQuery]);

  /**
   * Persist the pool edit. The server rewrites the gateway configuration and
   * reloads the host, so the catalog only reflects the change after a fresh
   * read; the command's own refresh handles that.
   */
  const saveRouting = useCallback(
    (input: WorkjetGatewayUpdateRoutingInput) => {
      if (environmentId === null || routingRef.current) return;
      routingRef.current = true;
      setRouting({ status: "saving" });
      void (async () => {
        const result = await updateRouting({ environmentId, input });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            setRouting({
              status: "failed",
              message: workjetGatewayFailureDescription(squashAtomCommandFailure(result)),
            });
          }
          return;
        }
        setRouting({ status: "completed" });
        setEditedCatalog(result.value.catalog);
        refresh();
      })().finally(() => {
        routingRef.current = false;
      });
    },
    [environmentId, refresh, updateRouting],
  );

  const editAccounts = useCallback(
    async (
      accounts: ReadonlyArray<WorkjetGatewayAccountSummary>,
      patch: {
        readonly label?: string;
        readonly enabled?: boolean;
        readonly models?: ReadonlyArray<string>;
      },
    ): Promise<boolean> => {
      const strategy = (editedCatalog ?? catalogQuery.data)?.routingStrategy;
      if (
        environmentId === null ||
        routingRef.current ||
        accounts.length === 0 ||
        strategy === undefined
      )
        return false;
      routingRef.current = true;
      setRouting({ status: "saving" });
      for (const account of accounts) clearAccountError(account.id);
      try {
        const result = await updateRouting({
          environmentId,
          input: {
            strategy,
            accounts: accounts.map((account) => ({
              accountId: account.id,
              enabled: patch.enabled ?? account.enabled,
              priority: account.priority,
              weight: account.weight,
              ...(patch.label !== undefined ? { label: patch.label } : {}),
              ...(patch.models !== undefined ? { models: patch.models } : {}),
            })),
          },
        });
        if (result._tag === "Failure") {
          const message = isAtomCommandInterrupted(result)
            ? "Change interrupted. Save again."
            : workjetGatewayFailureDescription(squashAtomCommandFailure(result));
          setAccountErrors((previous) => ({
            ...previous,
            ...Object.fromEntries(accounts.map((account) => [account.id, message])),
          }));
          setRouting({ status: "failed", message });
          return false;
        }
        setEditedCatalog(result.value.catalog);
        setRouting({ status: "completed" });
        refresh();
        return true;
      } finally {
        routingRef.current = false;
      }
    },
    [environmentId, refresh, updateRouting, editedCatalog, catalogQuery.data],
  );

  const retry = useCallback(() => {
    if (environmentId === null || operationRef.current) return;
    operationRef.current = true;
    setIsOperating(true);
    void (async () => {
      const result = await startGateway({ environmentId, input: {} });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not start the provider gateway",
          description: workjetGatewayFailureDescription(squashAtomCommandFailure(result)),
        });
      }
    })().finally(() => {
      operationRef.current = false;
      setIsOperating(false);
      refresh();
    });
  }, [environmentId, refresh, startGateway]);

  const addAccount = useCallback(
    (provider: WorkjetGatewayOauthProvider, accountId?: string) => {
      if (environmentId === null || loginRef.current !== null) return;
      const token = { aborted: false };
      loginRef.current = token;
      setLoginAccountId(accountId ?? null);
      setLogin({ status: "starting", provider });
      const fail = (message: string) => {
        if (!token.aborted) setLogin({ status: "failed", provider, message });
      };
      void (async () => {
        // The server autostarts the gateway for this call, so the surface never
        // needs a start button ahead of it.
        const started = await startGatewayOauth({
          environmentId,
          input: {
            provider,
            ...(accountId ? { accountId: WorkjetGatewayAccountId.make(accountId) } : {}),
          },
        });
        if (started._tag === "Failure") {
          if (!isAtomCommandInterrupted(started)) {
            fail(workjetGatewayFailureDescription(squashAtomCommandFailure(started)));
          }
          return;
        }
        if (token.aborted) {
          void cancelGatewayOauth({ environmentId, input: { state: started.value.state } });
          return;
        }
        const session = started.value;
        setLogin({
          status: "pending",
          provider,
          state: session.state,
          authorizationUrl: session.authorizationUrl,
        });
        // The provider login belongs in the user's own browser: Workjet never
        // renders it and never handles the credentials.
        try {
          await ensureLocalApi().shell.openExternal(session.authorizationUrl);
        } catch {
          toastManager.add({
            type: "error",
            title: "Could not open the provider login",
            description: "Open the provider login in your browser to finish adding the account.",
          });
        }

        for (let attempt = 0; attempt < WORKJET_GATEWAY_OAUTH_POLL_MAX_ATTEMPTS; attempt += 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, WORKJET_GATEWAY_OAUTH_POLL_INTERVAL_MS),
          );
          if (token.aborted) return;
          const polled = await pollGatewayOauth({
            environmentId,
            input: { state: session.state },
          });
          if (token.aborted) return;
          if (polled._tag === "Failure") {
            if (!isAtomCommandInterrupted(polled)) {
              fail(workjetGatewayFailureDescription(squashAtomCommandFailure(polled)));
            }
            return;
          }
          if (polled.value.failed) {
            fail(workjetGatewayOauthSessionInvalidMessage());
            return;
          }
          if (!polled.value.pending) {
            setLogin({
              status: "completed",
              provider,
              accountIds: polled.value.completedAccountIds,
            });
            setChecksError(null);
            // The server force-checks successful logins, including unchanged tokens.
            checksPass.current = null;
            checksPollingDeadline.current = 0;
            checksPolls.current = 0;
            // The server persisted the account and reloaded the gateway, so the
            // new account only appears after a fresh catalog read.
            refresh();
            return;
          }
        }
        fail(workjetGatewayOauthSessionInvalidMessage());
      })().finally(() => {
        if (loginRef.current === token) loginRef.current = null;
      });
    },
    [cancelGatewayOauth, environmentId, pollGatewayOauth, refresh, startGatewayOauth],
  );

  /**
   * Send one API key to the server. The value is used exactly once, is never
   * stored in component state beyond the field it came from, and never reaches
   * a toast, a log, or the account list — a failure is reported with the
   * contract's own bounded copy.
   */
  const addApiKey = useCallback(
    async (
      provider: WorkjetGatewayApiKeyProvider,
      value: string,
      label = WORKJET_GATEWAY_PROVIDER_LABELS[provider],
      models?: ReadonlyArray<string>,
      accountId?: string,
    ): Promise<boolean> => {
      if (environmentId === null || apiKeyRef.current) return false;
      apiKeyRef.current = true;
      setApiKey({ status: "saving", provider });
      try {
        const result = await addApiKeyAccount({
          environmentId,
          input: {
            provider,
            label,
            apiKey: value,
            ...(models !== undefined ? { models } : {}),
            ...(accountId ? { accountId: WorkjetGatewayAccountId.make(accountId) } : {}),
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            setApiKey({
              status: "failed",
              provider,
              message: workjetGatewayFailureDescription(squashAtomCommandFailure(result)),
            });
          }
          return false;
        }
        setApiKey({ status: "completed", provider });
        if (accountId) {
          setChecksError(null);
          setRecoveryAccounts((previous) => [...new Set([...previous, accountId])]);
        }
        // The server persisted the account and reloaded the gateway, so the new
        // account only appears after a fresh catalog read.
        refresh();
        return true;
      } finally {
        apiKeyRef.current = false;
      }
    },
    [addApiKeyAccount, environmentId, refresh],
  );

  const cancelLogin = useCallback(() => {
    if (login.status === "idle" || login.status === "completed") return;
    if (loginRef.current) loginRef.current.aborted = true;
    loginRef.current = null;
    setLogin({ status: "idle" });
    setLoginAccountId(null);
    if (environmentId === null || login.status !== "pending") return;
    void cancelGatewayOauth({ environmentId, input: { state: login.state } });
  }, [cancelGatewayOauth, environmentId, login]);

  const removeRef = useRef(false);
  const removeAccountById = useCallback(
    async (accountId: string): Promise<boolean> => {
      if (environmentId === null || removeRef.current) return false;
      removeRef.current = true;
      setIsDeleting(true);
      clearAccountError(accountId);
      try {
        const result = await removeAccount({
          environmentId,
          input: { accountId: WorkjetGatewayAccountId.make(accountId) },
        });
        if (result._tag === "Failure") {
          setAccountErrors((previous) => ({
            ...previous,
            [accountId]: isAtomCommandInterrupted(result)
              ? "Removal interrupted. Try again."
              : workjetGatewayFailureDescription(squashAtomCommandFailure(result)),
          }));
          return false;
        }
        setEditedCatalog(null);
        refresh();
        return true;
      } finally {
        removeRef.current = false;
        setIsDeleting(false);
      }
    },
    [environmentId, refresh, removeAccount],
  );

  return {
    status: statusQuery.data,
    catalog: editedCatalog ?? catalogQuery.data,
    isInitialLoading: statusQuery.isPending && statusQuery.data === null,
    isRefreshing:
      statusQuery.isPending ||
      catalogQuery.isPending ||
      healthQuery.isPending ||
      modelsQuery.isPending,
    statusError: statusQuery.error,
    catalogError: catalogQuery.error,
    isOperating,
    login,
    onRefresh: refresh,
    onRetry: retry,
    onAddAccount: addAccount,
    onCancelLogin: cancelLogin,
    apiKey,
    onAddApiKey: addApiKey,
    onRemoveAccount: removeAccountById,
    onDeleteAccount: removeAccountById,
    onSaveApiKey: addApiKey,
    onRelogin: addAccount,
    onEditAccount: (account, patch) => editAccounts([account], patch),
    onEditModels: (accounts, models) => editAccounts(accounts, { models }),
    loginAccountId,
    accountErrors,
    modelChecks: checksQuery.data?.checks ?? [],
    pendingModelChecks: checksError === null ? (checksQuery.data?.pending ?? []) : [],
    deferredChecksCount:
      checksPass.current === null
        ? (checksQuery.data?.deferredCount ?? 0)
        : Math.max(
            0,
            remainingModelChecks(
              checksPass.current,
              catalogQuery.data?.accounts ?? [],
              checksQuery.data?.checks ?? [],
            ) - (checksQuery.data?.pending.length ?? 0),
          ),
    checksBusy,
    checksError: checksError ?? checksQuery.error,
    onCheckModels: (accountId) => {
      void runChecks(accountId, true);
    },
    accountHealth: Object.fromEntries(
      (healthQuery.data?.accounts ?? []).map((account) => [
        account.accountId,
        modelsAccountHealth(account, Date.now()),
      ]),
    ),
    mutationBusy:
      routing.status === "saving" ||
      apiKey.status === "saving" ||
      isOperating ||
      isDeleting ||
      login.status === "starting" ||
      login.status === "pending",
    pools: {
      catalog: catalogQuery.data,
      health: healthQuery.data,
      models: modelsQuery.data,
      healthError: healthQuery.error,
      modelsError: modelsQuery.error,
      // Rendered once per commit rather than on a timer: the surface refreshes
      // on every gateway action, and an age that ticks on its own would
      // re-render the whole settings panel for no new information.
      nowMs: Date.now(),
      canEdit: environmentId !== null && !isOperating && statusQuery.data !== null,
      routing,
      onSaveRouting: saveRouting,
    },
  };
}
