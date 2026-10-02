import type { WorkjetGatewayAccountHealth } from "@workjet/contracts";
import type { ModelsAccountHealth } from "./WorkjetModelsProviders";

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5 hours",
  seven_day: "7 days",
  seven_day_opus: "Opus · 7 days",
  seven_day_sonnet: "Sonnet · 7 days",
  primary_window: "Short-term limit",
  secondary_window: "Long-term limit",
};

export function modelsAccountHealth(
  account: WorkjetGatewayAccountHealth,
  now: number,
): ModelsAccountHealth {
  const generationStatus = account.generationHttpStatus;
  const exhaustedWindows = account.quota.filter(
    (window) =>
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
    : account.authentication === "rejected"
      ? "auth-required"
      : (generationStatus === 429 && blocked) || exhausted
        ? "cooldown"
        : blocked || (!account.usable && generationStatus !== null && generationStatus >= 400)
          ? "unavailable"
          : account.authentication === "authenticated"
            ? "ready"
            : "unknown";
  const message =
    status === "auth-required"
      ? "Sign-in expired or credentials rejected."
      : status === "unavailable"
        ? generationStatus === 402
          ? "Check your subscription or balance."
          : generationStatus === 403
            ? "The provider denied access. Check this account and subscription."
            : account.errorCode?.includes("model")
              ? "Model unavailable. Check the model names above."
              : "Provider temporarily unavailable. Try checking again."
        : null;
  return {
    status,
    message,
    retryAtMs: blocked ? Math.max(account.cooldownUntilMs ?? 0, quotaRetry ?? 0) : quotaRetry,
    windows: account.quota.map((window) => ({
      label: WINDOW_LABELS[window.name] ?? window.name.replaceAll("_", " "),
      unlimited: window.unlimited && now - window.observedAtMs < 300_000,
      remainingPercent:
        (now - window.observedAtMs > 300_000 &&
          !(
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
