"use client";

/**
 * Inline-Panel (UI-Vertrag, drei Orte): Hinzufügen und Bearbeiten passieren
 * direkt auf der Seite, nie in einem Dialog, Sheet oder Popover.
 *
 * Aufbau: ein Auslöser-Button („+ Rechner hinzufügen“). Ein Klick klappt
 * darunter ein Formular animiert auf (InlineExpand): optional ein Segment,
 * die Felder und ein Fuß mit „Abbrechen“ und der Primäraktion. Esc und der
 * Pfeil oben rechts klappen wieder zu; es ist immer nur ein Panel offen.
 */
import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { InlineExpand, inlineExpandLabels } from "~/components/ui/inline-expand";
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
  /** Opened from elsewhere (e.g. a menu item): no own trigger button. */
  readonly hideTrigger?: boolean;
  /** Footer „Abbrechen“ is the only way back: no extra „Zuklappen“ chevron. */
  readonly hideCollapseControl?: boolean;
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
  hideTrigger = false,
  hideCollapseControl = false,
}: InlinePanelProps) {
  return (
    <>
      {open || hideTrigger ? null : (
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
      )}
      <InlineExpand
        label={triggerLabel}
        open={open}
        onOpenChange={onOpenChange}
        hideCollapseControl={hideCollapseControl}
      >
        <form
          aria-label={triggerLabel}
          className={cn("flex flex-col gap-3 rounded-lg border bg-card/40 p-3", className)}
          data-slot="inline-panel"
          onSubmit={(event) => {
            event.preventDefault();
            if (!submitDisabled && !busy) onSubmit();
          }}
        >
          {/* With a source picker the tiles say what this is; no heading repeating the button (#583). */}
          {segment ? (
            <div className="pe-7" data-slot="inline-panel-segment">
              {segment}
            </div>
          ) : (
            <div className="pe-7 font-medium text-[13.5px]">{triggerLabel}</div>
          )}
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
          <InlineSaveFooter
            submitLabel={submitLabel}
            submitDisabled={Boolean(submitDisabled || busy)}
            onCancel={() => onOpenChange(false)}
          />
        </form>
      </InlineExpand>
    </>
  );
}

/**
 * Save contract for composite entities (UI rule 3, #562): bottom right,
 * exactly „Abbrechen“ then „Speichern“. Simple values autosave instead.
 */
function InlineSaveFooter({
  onCancel,
  onSave,
  saving = false,
  submitDisabled = false,
  cancelDisabled = false,
  submitLabel,
  className,
}: {
  readonly onCancel: () => void;
  /** Without onSave the button submits the surrounding form. */
  readonly onSave?: () => void;
  readonly saving?: boolean;
  readonly submitDisabled?: boolean;
  readonly cancelDisabled?: boolean;
  /** Only for create flows (e.g. „Hinzufügen“); editing always says „Speichern“. */
  readonly submitLabel?: string;
  readonly className?: string;
}) {
  const labels = inlineExpandLabels();
  return (
    <div
      className={cn("flex items-center justify-end gap-2", className)}
      data-slot="inline-panel-footer"
    >
      <Button
        size="sm"
        type="button"
        variant="outline"
        disabled={cancelDisabled}
        onClick={onCancel}
      >
        {labels.cancel}
      </Button>
      <Button
        disabled={submitDisabled || saving}
        size="sm"
        type={onSave ? "button" : "submit"}
        onClick={onSave}
      >
        {saving ? labels.saving : (submitLabel ?? labels.save)}
      </Button>
    </div>
  );
}

export { InlinePanel, InlineSaveFooter };
