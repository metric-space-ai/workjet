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
      ? "Anmeldedaten abgelehnt (HTTP 401)."
      : status === "cooldown"
        ? exhausted
          ? "Kontingent erschöpft"
          : generationStatus === 403
            ? "Pausiert nach Zugriffsverweigerung (HTTP 403)."
            : `Pausiert nach Fehler${generationStatus === null ? "" : ` (HTTP ${generationStatus})`}.`
        : status === "unavailable"
          ? balanceExhausted
            ? "Guthaben aufgebraucht."
            : generationStatus === 402
              ? "Abo oder Guthaben prüfen."
              : generationStatus === 403
                ? "Zugriff verweigert. Konto und Abo prüfen."
                : account.errorCode?.includes("model")
                  ? "Modell nicht verfügbar."
                  : "Letzte Anfrage fehlgeschlagen."
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
