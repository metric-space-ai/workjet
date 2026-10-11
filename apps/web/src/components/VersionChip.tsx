/**
 * Versionsanzeige (UI-Vertrag §6): ein ruhiger Chip mit Workjet-, Host- und
 * Instanz-Version. Klick öffnet die Details (Einstellungen › Diagnose).
 * Ein Update-Hinweis ist ein Chip daneben, kein Toast mit Absatz.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { APP_VERSION } from "../branding";
import { primaryServerConfigAtom } from "../state/server";
import { cn } from "../lib/utils";

/** Kurz-SHA eines Builds: die ersten sieben Zeichen eines Commit-Hashes. */
function shortBuild(build: string | null): string | null {
  const trimmed = build?.trim() ?? "";
  if (trimmed.length === 0) return null;
  return /^[0-9a-f]{8,}$/iu.test(trimmed) ? trimmed.slice(0, 7) : trimmed;
}

/**
 * Die vollständige Versionszeile (UI-Vertrag §6):
 * „Workjet 0.0.85 · Host 0.1.3 · <Instanz> <Build-Kurz-SHA>“.
 * Fehlende Werte zeigen „—“.
 */
export function formatVersionChipLabel(
  appVersion: string,
  hostVersion: string | null,
  instanceLabel: string | null,
  instanceBuild: string | null = null,
): string {
  const parts = [`Workjet ${appVersion}`, `Host ${hostVersion ?? "—"}`];
  if (instanceLabel) {
    parts.push(`${instanceLabel} ${shortBuild(instanceBuild) ?? "—"}`);
  }
  return parts.join(" · ");
}

export function VersionChip({ className }: { readonly className?: string }) {
  const navigate = useNavigate();
  const environment = useAtomValue(primaryServerConfigAtom)?.environment ?? null;
  const label = formatVersionChipLabel(
    APP_VERSION,
    environment?.serverVersion ?? null,
    environment?.label ?? null,
  );

  const openDetails = useCallback(() => {
    void navigate({ to: "/settings/diagnostics" });
  }, [navigate]);

  return (
    <button
      type="button"
      aria-label={`${label} – Details öffnen`}
      className={cn(
        "no-drag inline-flex min-h-6 max-w-full min-w-0 shrink-0 cursor-pointer items-center rounded-md border border-transparent px-2 text-left text-[11px] break-words text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:whitespace-nowrap",
        className,
      )}
      data-slot="version-chip"
      onClick={openDetails}
    >
      {label}
    </button>
  );
}
