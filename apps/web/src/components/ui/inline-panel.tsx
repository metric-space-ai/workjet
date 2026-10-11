"use client";

/**
 * Inline-Panel (UI-Vertrag, drei Orte): Hinzufügen und Bearbeiten passieren
 * direkt auf der Seite, nie in einem Dialog, Sheet oder Popover.
 *
 * Aufbau: ein Auslöser-Button („+ Rechner hinzufügen“). Ein Klick klappt
 * darunter ein Formular auf: optional ein Segment für die Optionen, die
 * Felder und ein Fuß mit „Abbrechen“ und der Primäraktion. Kein Untertitel,
 * keine Erklärsätze; höchstens eine Fehler- oder Statuszeile.
 */
import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export interface InlinePanelProps {
  /** Beschriftung des Auslösers, z. B. „Rechner hinzufügen“. */
  readonly triggerLabel: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Optionales Segment direkt oben im Panel (z. B. Local | SSH | Tailscale). */
  readonly segment?: ReactNode;
  readonly children: ReactNode;
  /** Primäraktion im Fuß. */
  readonly submitLabel: string;
  readonly onSubmit: () => void;
  readonly submitDisabled?: boolean;
  readonly busy?: boolean;
  /** Eine Fehler- oder Statuszeile, höchstens 12 Wörter. */
  readonly status?: ReactNode;
  readonly statusTone?: "neutral" | "error";
  readonly className?: string;
}

function InlinePanel({
  triggerLabel,
  open,
  onOpenChange,
  segment,
  children,
  submitLabel,
  onSubmit,
  submitDisabled,
  busy,
  status,
  statusTone = "neutral",
  className,
}: InlinePanelProps) {
  if (!open) {
    return (
      <Button
        className={cn("self-start", className)}
        data-slot="inline-panel-trigger"
        size="sm"
        variant="outline"
        onClick={() => onOpenChange(true)}
      >
        <PlusIcon />
        {triggerLabel}
      </Button>
    );
  }
  return (
    <form
      aria-label={triggerLabel}
      className={cn("flex flex-col gap-3 rounded-lg border bg-card/40 p-3", className)}
      data-slot="inline-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitDisabled && !busy) onSubmit();
      }}
    >
      <div className="font-medium text-[13.5px]">{triggerLabel}</div>
      {segment ? <div data-slot="inline-panel-segment">{segment}</div> : null}
      <div className="flex flex-col gap-3" data-slot="inline-panel-body">
        {children}
      </div>
      {status ? (
        <div
          className={cn(
            "text-xs",
            statusTone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          data-slot="inline-panel-status"
          role={statusTone === "error" ? "alert" : "status"}
        >
          {status}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2" data-slot="inline-panel-footer">
        <Button size="sm" type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Abbrechen
        </Button>
        <Button disabled={submitDisabled || busy} size="sm" type="submit">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export { InlinePanel };
