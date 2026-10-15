"use client";

/**
 * Zeile (UI-Vertrag §1.2): die eine Listenzeile für Instanzen, Rechner,
 * Lumas, Projekte, PRs, Konten und Modelle.
 *
 * Aufbau: Statuspunkt, Name (darunter höchstens eine kurze Meta-Zeile),
 * Chips, Aktiv-Schalter, Papierkorb mit eingebauter Bestätigung, ⋯-Menü
 * für Seltenes (Bearbeiten, Reparieren, Neu prüfen). Ein Objekt hat genau
 * eine Zeile. Die Bestätigung steht inline in der Zeile, nie als Dialog
 * (drei Orte: Dev, Ops, Einstellungen; keine Popups). Unter 640 px rutscht
 * sie unter die Zeile, damit alle Knöpfe ganz sichtbar bleiben.
 */
import { WORKJET_STATUS_DOT_CLASS } from "../../workjetStatus";
import { ChevronDownIcon, EllipsisVerticalIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export type RowStatus = "ok" | "busy" | "error" | "off";

/** Row dots use the central status colors (#566). */
const ROW_STATUS_DOT_CLASS: Record<RowStatus, string> = {
  ok: WORKJET_STATUS_DOT_CLASS.ok,
  busy: WORKJET_STATUS_DOT_CLASS.waiting,
  error: WORKJET_STATUS_DOT_CLASS.blocked,
  off: WORKJET_STATUS_DOT_CLASS.missing,
};

export interface RowMenuAction {
  readonly label: string;
  readonly onSelect: () => void;
  readonly destructive?: boolean;
}

function RowStatusDot({ status, label }: { status: RowStatus; label?: string | undefined }) {
  return (
    <span
      role="img"
      aria-label={label ?? status}
      className={cn("size-2 shrink-0 rounded-full", ROW_STATUS_DOT_CLASS[status])}
      data-slot="row-status"
    />
  );
}

export interface RowDeleteOption {
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
}

export interface RowProps {
  readonly name: ReactNode;
  /** Höchstens eine kurze Meta-Zeile unter dem Namen, z. B. die Adresse. */
  readonly meta?: ReactNode;
  readonly status?: RowStatus;
  readonly statusLabel?: string;
  /** Chips zwischen Name und Schalter. */
  readonly chips?: ReactNode;
  /** Aktiv-Schalter; ohne `onActiveChange` kein Schalter. */
  readonly active?: boolean;
  readonly activeLabel?: string;
  readonly onActiveChange?: (active: boolean) => void;
  readonly activeDisabled?: boolean;
  /** Löschwege zur Wahl; ersetzen den einen Bestätigen-Knopf. */
  readonly deleteOptions?: readonly RowDeleteOption[];
  /** Papierkorb; die Bestätigung ist eingebaut. */
  readonly onDelete?: () => void;
  readonly deleteLabel?: string;
  readonly deleteConfirmTitle?: string;
  /** Löschen läuft sofort; der Aufrufer zeigt Rückgängig statt einer Bestätigung (#637). */
  readonly undoableDelete?: boolean;
  /** Seltene Aktionen hinter dem ⋯-Menü. */
  readonly menuActions?: ReadonlyArray<RowMenuAction>;
  readonly menuLabel?: string;
  /**
   * Klick auf Name/Meta klappt die Zeile zum Bearbeiten auf (InlineExpand
   * darunter). Ersetzt „⋯ → Bearbeiten“.
   */
  readonly onToggleExpanded?: () => void;
  readonly expanded?: boolean;
  readonly className?: string;
}

function Row({
  name,
  meta,
  status,
  statusLabel,
  chips,
  active,
  activeLabel = "Aktiv",
  onActiveChange,
  activeDisabled,
  onDelete,
  deleteOptions,
  deleteLabel = "Löschen",
  deleteConfirmTitle,
  undoableDelete = false,
  menuActions,
  menuLabel = "Weitere Aktionen",
  onToggleExpanded,
  expanded = false,
  className,
}: RowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const canDelete = onDelete !== undefined || (deleteOptions?.length ?? 0) > 0;
  const showActions = onActiveChange !== undefined || canDelete || menuActions?.length;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[13.5px] sm:flex-nowrap",
        className,
      )}
      data-slot="row"
    >
      {status !== undefined ? <RowStatusDot status={status} label={statusLabel} /> : null}
      {onToggleExpanded ? (
        <button
          aria-expanded={expanded}
          className="group/row-open -my-1 flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
          data-slot="row-open"
          type="button"
          onClick={onToggleExpanded}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium" data-slot="row-name">
              {name}
            </span>
            {meta ? (
              <span className="truncate text-muted-foreground text-xs" data-slot="row-meta">
                {meta}
              </span>
            ) : null}
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              expanded
                ? "rotate-180"
                : "opacity-0 group-hover/row-open:opacity-100 group-focus-visible/row-open:opacity-100",
            )}
          />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium" data-slot="row-name">
            {name}
          </span>
          {meta ? (
            <span className="truncate text-muted-foreground text-xs" data-slot="row-meta">
              {meta}
            </span>
          ) : null}
        </div>
      )}
      {chips ? (
        <div className="flex shrink-0 items-center gap-1.5" data-slot="row-chips">
          {chips}
        </div>
      ) : null}
      {canDelete && confirmingDelete ? (
        <div
          className="order-last flex w-full flex-wrap items-center justify-end gap-1.5 sm:order-none sm:w-auto sm:flex-nowrap"
          data-slot="row-confirm"
          role="group"
        >
          <span className="min-w-0 text-xs text-muted-foreground">
            {deleteConfirmTitle ?? `${deleteLabel}?`}
          </span>
          {deleteOptions?.length ? (
            deleteOptions.map((option) => (
              <Button
                key={option.label}
                size="xs"
                variant="destructive"
                disabled={option.disabled}
                onClick={() => {
                  setConfirmingDelete(false);
                  option.onSelect();
                }}
              >
                {option.label}
              </Button>
            ))
          ) : (
            <Button
              size="xs"
              variant="destructive"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete?.();
              }}
            >
              {deleteLabel}
            </Button>
          )}
          <Button size="xs" variant="outline" onClick={() => setConfirmingDelete(false)}>
            Abbrechen
          </Button>
        </div>
      ) : null}
      {showActions ? (
        <div className="flex shrink-0 items-center gap-1" data-slot="row-actions">
          {onActiveChange !== undefined ? (
            <Switch
              aria-label={activeLabel}
              checked={active ?? false}
              disabled={activeDisabled}
              onCheckedChange={(checked) => onActiveChange(checked === true)}
            />
          ) : null}
          {canDelete && !confirmingDelete ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={deleteLabel}
                    size="xs"
                    // Icon plus word: a secondary action, so `outline` (Vertrag §2:
                    // `ghost` only for bare icon buttons with a tooltip).
                    variant="outline"
                    onClick={() => {
                      // Undoable deletes run at once; the caller offers „Rückgängig“.
                      if (undoableDelete && onDelete) onDelete();
                      else setConfirmingDelete(true);
                    }}
                  />
                }
              >
                <Trash2Icon />
                {/* Icons explain themselves: the word is always visible, also on touch. */}
                <span>{deleteLabel}</span>
              </TooltipTrigger>
              <TooltipPopup>{deleteLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          {menuActions?.length ? (
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={<MenuTrigger render={<Button size="icon-sm" variant="ghost" />} />}
                >
                  <EllipsisVerticalIcon />
                  <span className="sr-only">{menuLabel}</span>
                </TooltipTrigger>
                <TooltipPopup>{menuLabel}</TooltipPopup>
              </Tooltip>
              <MenuPopup>
                {menuActions.map((action) => (
                  <MenuItem key={action.label} onClick={action.onSelect}>
                    {action.label}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { Row, RowStatusDot };
