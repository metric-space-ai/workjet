/**
 * Versionsanzeige (UI-Vertrag §6): ein einziger ruhiger Chip mit Workjet-,
 * Host- und Instanz-Version. Klick öffnet die Details (Einstellungen ›
 * Diagnose). Ein Harness-Update ist ein Punkt am Chip; der Chip öffnet dann
 * ein Menü mit „Details“ und dem Update als Eintrag (Audit A-63).
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon, InfoIcon, XIcon } from "lucide-react";
import { useCallback } from "react";

import { APP_VERSION } from "../branding";
import { primaryServerConfigAtom } from "../state/server";
import { cn } from "../lib/utils";
import { useProviderUpdateHint, type ProviderUpdateHint } from "./ProviderUpdateLaunchNotification";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";

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
  // Unbekannte Teile entfallen, statt als „—“ in der Zeile zu stehen.
  const parts = [`Workjet ${appVersion}`];
  if (hostVersion) parts.push(`Host ${hostVersion}`);
  if (instanceLabel) {
    const build = shortBuild(instanceBuild);
    parts.push(build ? `${instanceLabel} ${build}` : instanceLabel);
  }
  return parts.join(" · ");
}

const CHIP_CLASS =
  "no-drag inline-flex min-h-6 max-w-full min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2 text-left text-[11px] break-words text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground sm:whitespace-nowrap";

export function VersionChip({ className }: { readonly className?: string }) {
  const navigate = useNavigate();
  const environment = useAtomValue(primaryServerConfigAtom)?.environment ?? null;
  const label = formatVersionChipLabel(
    APP_VERSION,
    environment?.serverVersion ?? null,
    environment?.label ?? null,
  );
  const update = useProviderUpdateHint();
  const openDetails = useCallback(() => {
    void navigate({ to: "/settings/diagnostics" });
  }, [navigate]);

  return (
    <VersionChipView
      label={label}
      update={update}
      onOpenDetails={openDetails}
      {...(className !== undefined ? { className } : {})}
    />
  );
}

/** Reine Darstellung des Versions-Chips, auch für Fixture und Tests. */
export function VersionChipView({
  label,
  update,
  onOpenDetails,
  className,
}: {
  readonly label: string;
  readonly update: ProviderUpdateHint | null;
  readonly onOpenDetails: () => void;
  readonly className?: string;
}) {
  if (update === null) {
    return (
      <button
        type="button"
        aria-label={`${label} – Details öffnen`}
        className={cn(CHIP_CLASS, className)}
        data-slot="version-chip"
        onClick={onOpenDetails}
      >
        {label}
      </button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${label} – ${update.title}`}
        className={cn(CHIP_CLASS, className)}
        data-slot="version-chip"
        data-workjet-provider-update=""
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info-foreground" />
        {label}
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        <MenuItem onClick={update.onOpen}>
          <DownloadIcon />
          {update.title}
        </MenuItem>
        <MenuItem onClick={onOpenDetails}>
          <InfoIcon />
          Details
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={update.onDismiss}>
          <XIcon />
          Hinweis ausblenden
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
