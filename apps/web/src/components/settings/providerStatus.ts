import type { ServerProvider, ServerProviderVersionAdvisory } from "@workjet/contracts";

import { getRelativeTimeState } from "../../timestampFormat";
import { WORKJET_STATUS_DOT_CLASS, workjetStatusFromProvider } from "../../workjetStatus";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: { dot: WORKJET_STATUS_DOT_CLASS[workjetStatusFromProvider("disabled")] },
  error: { dot: WORKJET_STATUS_DOT_CLASS[workjetStatusFromProvider("error")] },
  ready: { dot: WORKJET_STATUS_DOT_CLASS[workjetStatusFromProvider("ready")] },
  warning: { dot: WORKJET_STATUS_DOT_CLASS[workjetStatusFromProvider("warning")] },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return { headline: "Wird geprüft", detail: null };
  }
  if (!provider.enabled) {
    return { headline: "Deaktiviert", detail: provider.message ?? null };
  }
  if (!provider.installed) {
    return { headline: "Nicht gefunden", detail: provider.message ?? "Nicht im PATH" };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Angemeldet · ${authLabel}` : "Angemeldet",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return { headline: "Nicht angemeldet", detail: provider.message ?? null };
  }
  if (provider.status === "warning") {
    return { headline: "Prüfen", detail: provider.message ?? null };
  }
  if (provider.status === "error") {
    return { headline: "Nicht verfügbar", detail: provider.message ?? null };
  }
  return { headline: "Verfügbar", detail: provider.message ?? null };
}

/**
 * Runtime-only status for the Harnesses surface.
 *
 * A harness is a CLI runtime: the questions it answers are "is it installed",
 * "which version", "is it enabled". Whether an LLM account behind it is signed
 * in is a different question with its own page.
 *
 * This is deliberately built from closed runtime facts and NEVER from
 * `provider.message`. The server's message is where the auth prose lives —
 * "Authenticated as …", "authentication could not be verified", "5 upstream
 * providers connected through OpenCode" — so passing it through is exactly how
 * login state leaked onto the harness list in the first place.
 */
export function getProviderRuntimeSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return { headline: "Wird geprüft", detail: null };
  }
  if (!provider.enabled) {
    return { headline: "Deaktiviert", detail: null };
  }
  if (!provider.installed) {
    return { headline: "Nicht installiert", detail: "Nicht im PATH" };
  }
  return { headline: "Installiert", detail: null };
}

/**
 * Age of the health check that produced a provider's claim. Rendered next to
 * the claim itself because "Angemeldet" without a timestamp is read as a
 * live fact, and a cached one outlives an expired CLI login.
 */
export function providerCheckedAgeLabel(checkedAt: string | null | undefined): string {
  const state = getRelativeTimeState(checkedAt ?? null);
  if (state.status === "missing") return "nie geprüft";
  if (state.status === "invalid") return "Prüfzeit unbekannt";
  return state.suffix ? `geprüft vor ${state.value}` : "gerade geprüft";
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
): {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  // One German status line (UI-Vertrag §2). The server's advisory prose is
  // an explanation, not a status, so it is not shown.
  const versionLabel = getProviderVersionLabel(advisory.latestVersion);

  return {
    detail: versionLabel ? `Update verfügbar · ${versionLabel}` : "Update verfügbar",
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
  };
}
