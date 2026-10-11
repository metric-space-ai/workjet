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

export function formatVersionChipLabel(
  appVersion: string,
  hostVersion: string | null,
  instanceLabel: string | null,
): string {
  const parts = [`Workjet ${appVersion}`, `Host ${hostVersion ?? "—"}`];
  if (instanceLabel) {
    parts.push(instanceLabel);
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
        "no-drag inline-flex h-6 max-w-56 shrink-0 cursor-pointer items-center truncate rounded-md border border-transparent px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      data-slot="version-chip"
      title={label}
      onClick={openDetails}
    >
      {label}
    </button>
  );
}
