import type { WorkjetGatewayAccountHealth } from "@workjet/contracts";
import type { ModelsAccountHealth } from "./WorkjetModelsProviders";

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5 Stunden",
  seven_day: "7 Tage",
  seven_day_opus: "Opus · 7 Tage",
  seven_day_sonnet: "Sonnet · 7 Tage",
  primary_window: "Kurzzeitlimit",
  secondary_window: "Langzeitlimit",
};

export function modelsAccountHealth(account: WorkjetGatewayAccountHealth, now: number): ModelsAccountHealth {
  const generationStatus = account.generationHttpStatus;
  const exhaustedWindows = account.quota.filter((window) => window.remainingPercent === 0 && !["seven_day_opus", "seven_day_sonnet"].includes(window.name) && (window.resetsAtMs !== null ? window.resetsAtMs > now : now - window.observedAtMs < 300_000));
  const exhausted = exhaustedWindows.length > 0;
  const blocked = account.cooldownUntilMs !== null && account.cooldownUntilMs > now;
  const status: ModelsAccountHealth["status"] = account.disabled ? "disabled" : account.authentication === "rejected" ? "auth-required" : (generationStatus === 429 && blocked) || exhausted ? "cooldown" : blocked || (!account.usable && generationStatus !== null && generationStatus >= 400) ? "unavailable" : account.authentication === "authenticated" ? "ready" : "unknown";
  const message = status === "auth-required" ? "Anmeldung abgelaufen oder Zugangsdaten abgelehnt." : status === "unavailable" ? generationStatus === 402 ? "Abo oder Guthaben prüfen." : generationStatus === 403 ? "Der Anbieter verweigert den Zugriff. Account und Abo prüfen." : account.errorCode?.includes("model") ? "Modell nicht verfügbar. Modellnamen oben prüfen." : "Anbieter vorübergehend nicht verfügbar. Erneut prüfen." : null;
  return {
    status,
    message,
    retryAtMs: account.cooldownUntilMs ?? exhaustedWindows.reduce<number | null>((reset, window) => window.resetsAtMs !== null ? Math.max(reset ?? 0, window.resetsAtMs) : reset, null),
    windows: account.quota.map((window) => ({
      label: WINDOW_LABELS[window.name] ?? window.name.replaceAll("_", " "),
      remainingPercent: (now - window.observedAtMs > 300_000 && !(window.remainingPercent === 0 && window.resetsAtMs !== null && window.resetsAtMs > now)) || (window.resetsAtMs !== null && window.resetsAtMs <= now) ? null : window.remainingPercent,
      resetsAtMs: window.resetsAtMs,
    })),
    observedAtMs: account.quota.length ? Math.min(...account.quota.map((window) => window.observedAtMs)) : null,
    quotaSupported: account.quotaSupported,
    quotaRefreshing: account.quotaRefreshing,
    quotaError: account.quotaError,
  };
}
