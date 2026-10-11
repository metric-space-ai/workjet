import type { WorkjetGatewayAccountHealth } from "@workjet/contracts";
import type { ModelsAccountHealth } from "./WorkjetModelsProviders";
import { normalizeModelsQuota } from "./WorkjetModelsQuota";

export function modelsAccountHealth(
  account: WorkjetGatewayAccountHealth,
  now: number,
): ModelsAccountHealth {
  const generationStatus = account.generationHttpStatus;
  const balance =
    account.balance === null
      ? null
      : {
          availableBalance: account.balance.availableBalance,
          currency: account.balance.currency,
          observedAtMs: account.balance.observedAtMs,
          fresh:
            now >= account.balance.observedAtMs && now - account.balance.observedAtMs < 300_000,
        };
  const balanceExhausted = balance !== null && balance.fresh && balance.availableBalance <= 0;
  const windows = normalizeModelsQuota(account.provider, account.quota, now);
  const exhaustedWindows = windows.filter((window) => window.accountWide && window.exhausted);
  const exhausted = exhaustedWindows.length > 0;
  const blocked = account.cooldownUntilMs !== null && account.cooldownUntilMs > now;
  const quotaRetry = exhaustedWindows.reduce<number | null>(
    (reset, window) =>
      window.resetsAtMs !== null ? Math.max(reset ?? 0, window.resetsAtMs) : reset,
    null,
  );
  const status: ModelsAccountHealth["status"] = account.disabled
    ? "disabled"
    : account.authentication === "rejected" && generationStatus === 401
      ? "auth-required"
      : blocked || exhausted
        ? "cooldown"
        : balanceExhausted ||
            (!account.usable && generationStatus !== null && generationStatus >= 400)
          ? "unavailable"
          : account.authentication === "authenticated"
            ? "ready"
            : "unknown";
  const message =
    status === "auth-required"
      ? "This account's credentials were rejected (HTTP 401)."
      : status === "cooldown"
        ? exhausted
          ? "Quota exhausted in the highlighted window. Available accounts handle new requests."
          : generationStatus === 403
            ? "This account is cooling down after an access denial (HTTP 403)."
            : `This account is cooling down after its last failed request${generationStatus === null ? "" : ` (HTTP ${generationStatus})`}.`
        : status === "unavailable"
          ? balanceExhausted
            ? "Available API balance is exhausted. Add funds or check voucher validity."
            : generationStatus === 402
              ? "Check your subscription or balance."
              : generationStatus === 403
                ? "The provider denied access. Check this account and subscription."
                : account.errorCode?.includes("model")
                  ? "Model unavailable. Check the model names above."
                  : "This account's last request failed. Re-check its models."
          : null;
  return {
    status,
    message,
    balance,
    retryAtMs: blocked ? Math.max(account.cooldownUntilMs ?? 0, quotaRetry ?? 0) : quotaRetry,
    windows,
    observedAtMs: account.quota.length
      ? Math.min(...account.quota.map((window) => window.observedAtMs))
      : null,
    quotaSupported: account.quotaSupported,
    quotaRefreshing: account.quotaRefreshing,
    quotaError: account.quotaError,
  };
}
