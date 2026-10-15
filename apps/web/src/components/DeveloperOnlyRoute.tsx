import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";

const selectDeveloperMode = (settings: { readonly developerMode: boolean }) =>
  settings.developerMode;

/**
 * Coding tools (PR page, diff, terminal, branch strip, git actions) are
 * Workjet's coding-agent heritage and only exist in developer mode (#557).
 * A direct visit without developer mode lands on the start page.
 */
export function DeveloperOnlyRoute({ children }: { readonly children: ReactNode }) {
  const hydrated = useClientSettingsHydrated();
  const developerMode = useClientSettings(selectDeveloperMode);
  // Persisted settings arrive within one tick; redirecting on the default
  // would bounce developers who open the page directly.
  if (!hydrated) return null;
  if (!developerMode) return <Navigate to="/" replace />;
  return children;
}
