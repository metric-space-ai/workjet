import type { WorkjetGatewayAccountHealth } from "@workjet/contracts";
import type { ModelsAccountHealth } from "./WorkjetModelsProviders";

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5 hours",
  seven_day: "7 days",
  seven_day_opus: "Opus · 7 days",
  seven_day_sonnet: "Sonnet · 7 days",
  primary_window: "Short-term limit",
  secondary_window: "Long-term limit",
  general_interval: "Short-term limit",
  general_weekly: "7 days",
};

function quotaWindowLabel(name: string, index: number, count: number): string {
  if (/^TOKENS_LIMIT_\d+$/u.test(name))
    return count === 1 ? "Usage limit" : `Usage limit ${index + 1}`;
  const modelWindow = /^(MiniMax-M.+)_(interval|weekly)$/u.exec(name);
  if (modelWindow)
    return `${modelWindow[1]} · ${modelWindow[2] === "weekly" ? "7 days" : "Short-term limit"}`;
  return WINDOW_LABELS[name] ?? name.replaceAll("_", " ");
}

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
  const exhaustedWindows = account.quota.filter(
    (window) =>
      !window.notInPlan &&
      !window.unlimited &&
      !window.toolOnly &&
      window.modelPattern === null &&
      window.remainingPercent === 0 &&
      !["seven_day_opus", "seven_day_sonnet"].includes(window.name) &&
      (window.resetsAtMs !== null ? window.resetsAtMs > now : now - window.observedAtMs < 300_000),
  );
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
        ? exhausted || generationStatus === 429
          ? "Limit reached. Available accounts handle new requests."
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
  const visibleWindows = account.quota.filter((window) => !window.toolOnly);
  return {
    status,
    message,
    balance,
    retryAtMs: blocked ? Math.max(account.cooldownUntilMs ?? 0, quotaRetry ?? 0) : quotaRetry,
    windows: visibleWindows.map((window, index) => ({
      label: quotaWindowLabel(window.name, index, visibleWindows.length),
      notInPlan: window.notInPlan && now - window.observedAtMs < 300_000,
      unlimited: window.unlimited && now - window.observedAtMs < 300_000,
      remainingPercent:
        (now - window.observedAtMs > 300_000 &&
          !(
            !window.notInPlan &&
            !window.unlimited &&
            window.remainingPercent === 0 &&
            window.resetsAtMs !== null &&
            window.resetsAtMs > now
          )) ||
        (window.resetsAtMs !== null && window.resetsAtMs <= now)
          ? null
          : window.remainingPercent,
      resetsAtMs: window.resetsAtMs !== null && window.resetsAtMs > now ? window.resetsAtMs : null,
    })),
    observedAtMs: account.quota.length
      ? Math.min(...account.quota.map((window) => window.observedAtMs))
      : null,
    quotaSupported: account.quotaSupported,
    quotaRefreshing: account.quotaRefreshing,
    quotaError: account.quotaError,
  };
}
