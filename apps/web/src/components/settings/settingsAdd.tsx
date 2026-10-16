/**
 * Gemeinsame Bausteine der Einstellungsseiten (Audit C, 16.10.2026):
 *
 * - `SettingsAddButton`: das eine Hinzufügen-Muster wie unter „Modelle“.
 *   Primär „+ Hinzufügen“ im Abschnittskopf; bei mehreren Arten ein Menü,
 *   bei genau einer Art öffnet der Klick die Zeile direkt am Listenanfang.
 * - `SettingsLoadingRow`: ein dezentes Skelett statt „—“; nach 10 s
 *   die Zeile „Nicht erreichbar · Erneut“ (UI-Vertrag §1.3).
 */
import { PlusIcon } from "lucide-react";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { cn } from "~/lib/utils";

function settingsLang(): "de" | "en" {
  return typeof document !== "undefined" &&
    document.documentElement?.lang?.startsWith("en") === true
    ? "en"
    : "de";
}

export interface SettingsAddOption {
  readonly label: ReactNode;
  readonly onSelect: () => void;
  readonly icon?: ComponentType<{ className?: string }>;
  readonly disabled?: boolean;
  readonly action?: string;
  readonly key?: string;
}

export function SettingsAddButton({
  options,
  onClick,
  disabled = false,
  label = settingsLang() === "en" ? "Add" : "Hinzufügen",
  action,
}: {
  /** Mehrere Arten: Menü. Fehlt sie oder ist es genau eine: direkter Klick. */
  readonly options?: ReadonlyArray<SettingsAddOption>;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly action?: string;
}) {
  const enabled = (options ?? []).filter((option) => !option.disabled);
  const direct = onClick ?? (options?.length === 1 ? options[0]?.onSelect : undefined);
  if (direct !== undefined || options === undefined) {
    return (
      <Button
        size="sm"
        disabled={disabled || direct === undefined}
        data-workjet-action={action}
        onClick={direct}
      >
        <PlusIcon className="size-3.5" aria-hidden />
        {label}
      </Button>
    );
  }
  // Ohne wählbare Art gibt es nichts hinzuzufügen: kein toter Knopf.
  if (enabled.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" disabled={disabled} data-workjet-action={action} />}>
        <PlusIcon className="size-3.5" aria-hidden />
        {label}
      </MenuTrigger>
      <MenuPopup align="end">
        {enabled.map((option, index) => {
          const Icon = option.icon;
          return (
            <MenuItem
              key={option.key ?? index}
              data-workjet-action={option.action}
              onClick={option.onSelect}
            >
              {Icon ? <Icon className="size-4" /> : null}
              {option.label}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

export const SETTINGS_LOADING_TIMEOUT_MS = 10_000;

/**
 * Platzhalter, solange eine Liste lädt oder still wiederholt wird. Nach
 * `timeoutMs` endet das Laden sichtbar mit genau einer Aktion.
 */
export function SettingsLoadingRow({
  onRetry,
  timeoutMs = SETTINGS_LOADING_TIMEOUT_MS,
  className,
  label = "Lädt",
}: {
  readonly onRetry: () => void;
  readonly timeoutMs?: number;
  readonly className?: string;
  readonly label?: string;
}) {
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [timeoutMs, attempt]);
  if (slow) {
    return (
      <div
        role="status"
        className={cn(
          "flex min-h-9 items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground sm:px-4",
          className,
        )}
        data-slot="settings-loading-failed"
      >
        <span>{settingsLang() === "en" ? "Unreachable" : "Nicht erreichbar"}</span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setAttempt((value) => value + 1);
            onRetry();
          }}
        >
          {settingsLang() === "en" ? "Retry" : "Erneut"}
        </Button>
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy
      className={cn("flex min-h-9 items-center gap-3 px-3 py-1.5 sm:px-4", className)}
      data-slot="settings-loading"
    >
      <Skeleton className="size-2 shrink-0 rounded-full" />
      <Skeleton className="h-3 w-40 max-w-[50%]" />
    </div>
  );
}
