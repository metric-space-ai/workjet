import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  WorkjetGatewayApiKeyProvider,
  WorkjetGatewayOauthProvider,
} from "@t3tools/contracts";
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
): WorkjetGatewaySectionState {
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
  const [login, setLogin] = useState<WorkjetGatewayLoginState>({ status: "idle" });
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

  const refresh = useCallback(() => {
    statusQuery.refresh();
    catalogQuery.refresh();
  }, [catalogQuery, statusQuery]);

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
    (provider: WorkjetGatewayOauthProvider) => {
      if (environmentId === null || loginRef.current !== null) return;
      const token = { aborted: false };
      loginRef.current = token;
      setLogin({ status: "starting", provider });
      const fail = (message: string) => {
        if (!token.aborted) setLogin({ status: "failed", provider, message });
      };
      void (async () => {
        // The server autostarts the gateway for this call, so the surface never
        // needs a start button ahead of it.
        const started = await startGatewayOauth({ environmentId, input: { provider } });
        if (started._tag === "Failure") {
          if (!isAtomCommandInterrupted(started)) {
            fail(workjetGatewayFailureDescription(squashAtomCommandFailure(started)));
          }
          return;
        }
        if (token.aborted) return;
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
    [environmentId, pollGatewayOauth, refresh, startGatewayOauth],
  );

  /**
   * Send one API key to the server. The value is used exactly once, is never
   * stored in component state beyond the field it came from, and never reaches
   * a toast, a log, or the account list — a failure is reported with the
   * contract's own bounded copy.
   */
  const addApiKey = useCallback(
    (provider: WorkjetGatewayApiKeyProvider, value: string) => {
      if (environmentId === null || apiKeyRef.current) return;
      const label = WORKJET_GATEWAY_PROVIDER_LABELS[provider];
      apiKeyRef.current = true;
      setApiKey({ status: "saving", provider });
      void (async () => {
        const result = await addApiKeyAccount({
          environmentId,
          input: { provider, label, apiKey: value },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            setApiKey({
              status: "failed",
              provider,
              message: workjetGatewayFailureDescription(squashAtomCommandFailure(result)),
            });
          }
          return;
        }
        setApiKey({ status: "completed", provider });
        // The server persisted the account and reloaded the gateway, so the new
        // account only appears after a fresh catalog read.
        refresh();
      })().finally(() => {
        apiKeyRef.current = false;
      });
    },
    [addApiKeyAccount, environmentId, refresh],
  );

  const cancelLogin = useCallback(() => {
    if (login.status !== "pending") return;
    if (loginRef.current) loginRef.current.aborted = true;
    loginRef.current = null;
    setLogin({ status: "idle" });
    if (environmentId === null) return;
    void cancelGatewayOauth({ environmentId, input: { state: login.state } });
  }, [cancelGatewayOauth, environmentId, login]);

  return {
    status: statusQuery.data,
    catalog: catalogQuery.data,
    isInitialLoading: statusQuery.isPending && statusQuery.data === null,
    isRefreshing: statusQuery.isPending || catalogQuery.isPending,
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
  };
}
