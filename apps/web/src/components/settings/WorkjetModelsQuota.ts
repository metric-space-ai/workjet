import type { WorkjetGatewayQuotaWindow, WorkjetNativeProviderAccount } from "@workjet/contracts";

export const MODELS_QUOTA_FRESH_FOR_MS = 300_000;
const DAY_SECONDS = 86_400;

/** Kimi Code and SuperGrok window names (workjet #755), with German labels. */
const NAMED_WINDOW_SECONDS: Readonly<Record<string, number>> = {
  limit_5h: 5 * 3600,
  limit_7d: 7 * DAY_SECONDS,
  limit_month_total: 30 * DAY_SECONDS,
  weekly: 7 * DAY_SECONDS,
  monthly: 30 * DAY_SECONDS,
};
const NAMED_WINDOW_LABELS: Readonly<Record<string, string>> = {
  limit_5h: "5 Std.",
  limit_7d: "7 Tage",
  limit_month_total: "Monat",
  weekly: "Woche",
  monthly: "Monat",
};

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
        (provider === "zai" && field === "percentage") ||
        // Kimi Code (limit_5h, limit_7d, limit_month_total) and SuperGrok (weekly, monthly)
        // report the consumed share 0..100 since workjet #755.
        ((provider === "kimi" || provider === "xai") && field === "used_percent");
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
        } else if (provider === "kimi" || provider === "xai") {
          seconds = NAMED_WINDOW_SECONDS[window.name] ?? null;
        }
      }
      const namedLabel =
        provider === "kimi" || provider === "xai" ? NAMED_WINDOW_LABELS[window.name] : undefined;
      const label =
        namedLabel ??
        (seconds === 7 * DAY_SECONDS
          ? "7 Tage"
          : seconds !== null && seconds >= 28 * DAY_SECONDS && seconds <= 31 * DAY_SECONDS
            ? "30 Tage"
            : seconds !== null && seconds > 0 && seconds < 7 * DAY_SECONDS
              ? "Kurzfristig"
              : provider === "codex" && window.name === "primary_window"
                ? "Kurzfristig"
                : "unbekannt");
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

type NativeReportedQuota = Extract<
  NonNullable<WorkjetNativeProviderAccount["reportedQuota"]>,
  { state: "reported" }
>;

/** Reset instants of a reported native quota, for both the window and the period form. */
export function nativeQuotaResets(quota: NativeReportedQuota): number[] {
  return "windows" in quota ? quota.windows.map((window) => window.resetAtMs) : [quota.resetAtMs];
}

/**
 * Adapt a native reported quota to the same qualified gateway evidence: the Claude
 * utilization windows, and the gateway-reported weekly/monthly period (ctox#872, Grok),
 * which renders like the local Kimi/Grok bars ("Woche", "Monat").
 */
export function normalizeNativeModelsQuota(
  provider: string,
  quota: WorkjetNativeProviderAccount["reportedQuota"],
  now: number,
) {
  if (quota?.state !== "reported") return [];
  if (!("windows" in quota))
    return normalizeModelsQuota(
      provider,
      [
        {
          name: quota.period,
          remainingPercent: null,
          observedAtMs: quota.observedAtMs,
          resetsAtMs: quota.resetAtMs,
          modelPattern: null,
          notInPlan: false,
          unlimited: false,
          toolOnly: false,
          boostPermille: null,
          source: {
            field: "used_percent",
            value: quota.used_percent,
            windowSeconds: null,
            status: null,
          },
        },
      ],
      now,
    );
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

/**
 * The instance's Grok quota as its provider registry reports it (Audit C 2):
 * a reading, else a read failure; "unknown" and older registries without the
 * field yield nothing.
 */
export function instanceXaiQuota(
  registry: { readonly accounts: ReadonlyArray<WorkjetNativeProviderAccount> } | undefined | null,
): WorkjetNativeProviderAccount["reportedQuota"] {
  const xai = registry?.accounts.filter((account) => account.provider === "xai") ?? [];
  return (
    xai.find((account) => account.reportedQuota?.state === "reported")?.reportedQuota ??
    xai.find((account) => account.reportedQuota?.state === "unavailable")?.reportedQuota
  );
}
