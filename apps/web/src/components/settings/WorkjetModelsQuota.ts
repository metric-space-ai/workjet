import type { WorkjetGatewayQuotaWindow, WorkjetNativeProviderAccount } from "@workjet/contracts";

export const MODELS_QUOTA_FRESH_FOR_MS = 300_000;
const DAY_SECONDS = 86_400;

/** Normalize provider evidence once, before both health and limit presentation use it. */
export function normalizeModelsQuota(
  provider: string,
  quota: ReadonlyArray<WorkjetGatewayQuotaWindow>,
  now: number,
) {
  return quota
    .filter((window) => !window.toolOnly)
    .map((window, index) => {
      const source = window.source;
      const field = source?.field;
      const used =
        (provider === "claude" && field === "utilization") ||
        (provider === "codex" && field === "used_percent") ||
        (provider === "zai" && field === "percentage");
      const direct =
        provider === "minimax" &&
        (field === "current_interval_remaining_percent" ||
          field === "current_weekly_remaining_percent");
      // The pinned v0.1.2 parser already emits REST for these four providers.
      // Never invert this legacy field again, or infer direction from HTTP/cooldown.
      const legacyKnown = ["claude", "codex", "zai", "minimax"].includes(provider);
      let remaining = source
        ? used
          ? source.value === null
            ? null
            : 100 - source.value
          : direct
            ? source.value
            : null
        : legacyKnown
          ? window.remainingPercent
          : null;
      // MiniMax's documented status 2 means exhausted, even if a percent contradicts it.
      if (provider === "minimax" && direct && source?.status === 2) remaining = 0;
      if (remaining !== null && (!Number.isFinite(remaining) || remaining < 0)) remaining = null;
      // Undo the pinned host's separate weekly boost scaling, keeping 100% = unused.
      if (
        !source &&
        provider === "minimax" &&
        remaining !== null &&
        window.boostPermille !== null
      ) {
        remaining = window.boostPermille > 0 ? (remaining * 1000) / window.boostPermille : null;
      }
      if (remaining !== null && remaining > 100) remaining = null;

      let seconds = source?.windowSeconds ?? null;
      // Qualified Z.ai response pairs; unknown encodings never use reset proximity.
      if (seconds === null && provider === "zai" && source) {
        if (source.unit === 3 && source.number === 5) seconds = 5 * 3600;
        else if (source.unit === 6 && source.number === 1) seconds = 7 * DAY_SECONDS;
        else if (source.unit === 5 && source.number === 1) seconds = 30 * DAY_SECONDS;
      }
      if (seconds === null) {
        if (provider === "claude") {
          if (window.name === "five_hour") seconds = 5 * 3600;
          else if (["seven_day", "seven_day_opus", "seven_day_sonnet"].includes(window.name))
            seconds = 7 * DAY_SECONDS;
        } else if (provider === "minimax") {
          if (window.name.endsWith("_interval")) seconds = 5 * 3600;
          else if (window.name.endsWith("_weekly")) seconds = 7 * DAY_SECONDS;
        }
      }
      const label =
        seconds === 7 * DAY_SECONDS
          ? "7 Tage"
          : seconds !== null && seconds >= 28 * DAY_SECONDS && seconds <= 31 * DAY_SECONDS
            ? "30 Tage"
            : seconds !== null && seconds > 0 && seconds < 7 * DAY_SECONDS
              ? "Kurzfristig"
              : provider === "codex" && window.name === "primary_window"
                ? "Kurzfristig"
                : "unbekannt";
      const fresh =
        now >= window.observedAtMs && now - window.observedAtMs < MODELS_QUOTA_FRESH_FOR_MS;
      const resetPending = window.resetsAtMs !== null && window.resetsAtMs > now;
      const expired = window.resetsAtMs !== null && window.resetsAtMs <= now;
      const notInPlan = window.notInPlan && fresh;
      const unlimited = window.unlimited && fresh;
      const current =
        !expired && (fresh || (remaining === 0 && resetPending && now >= window.observedAtMs));
      const reason =
        (source && !used && !direct) || (!source && !legacyKnown)
          ? "Richtung des Anbieterwerts ist nicht belegt."
          : expired
            ? "Das gemeldete Fenster ist abgelaufen; ein neuer Restwert fehlt."
            : !current
              ? "Kein aktueller Anbieterwert verfügbar."
              : remaining === null
                ? "Anbieter meldet keinen eindeutigen Restwert."
                : null;
      const remainingPercent =
        current && !notInPlan && !unlimited && reason === null ? remaining : null;
      const scope =
        window.modelPattern ??
        (window.name === "seven_day_opus"
          ? "Opus"
          : window.name === "seven_day_sonnet"
            ? "Sonnet"
            : null);
      const duration =
        seconds === null
          ? "Dauer vom Host nicht übermittelt."
          : seconds % DAY_SECONDS === 0
            ? `${seconds / DAY_SECONDS} Tage`
            : seconds % 3600 === 0
              ? `${seconds / 3600} h`
              : `${seconds / 60} min`;
      return {
        id: `${window.name}:${index}`,
        label,
        tooltip: [
          duration,
          label === "unbekannt" ? "Fensterdauer nicht eindeutig zuordenbar." : null,
          scope,
          reason,
          remainingPercent === null
            ? null
            : "Verbleibender Anteil · 100 % unbenutzt, 0 % erschöpft",
        ]
          .filter(Boolean)
          .join(" · "),
        unknownReason: reason,
        notInPlan,
        unlimited,
        remainingPercent,
        resetsAtMs: resetPending ? window.resetsAtMs : null,
        accountWide: scope === null,
        exhausted: remainingPercent === 0,
        tone:
          remainingPercent !== null && remainingPercent <= 5
            ? "red"
            : remainingPercent !== null && remainingPercent <= 20
              ? "yellow"
              : "green",
      } as const;
    });
}

/** Adapt the native Claude utilization receipt to the same qualified gateway evidence. */
export function normalizeNativeModelsQuota(
  provider: string,
  quota: WorkjetNativeProviderAccount["reportedQuota"],
  now: number,
) {
  if (quota?.state !== "reported") return [];
  return normalizeModelsQuota(
    provider,
    quota.windows.map((window) => ({
      name: window.kind,
      remainingPercent: null,
      observedAtMs: quota.observedAtMs,
      resetsAtMs: window.resetAtMs,
      modelPattern: null,
      notInPlan: false,
      unlimited: false,
      toolOnly: false,
      boostPermille: null,
      source: {
        field: "utilization",
        value: window.utilization === null ? null : window.utilization * 100,
        windowSeconds: window.kind === "five_hour" ? 18_000 : 604_800,
        status: null,
      },
    })),
    now,
  );
}
