/**
 * Inline-Hinweise unter dem Kopf (drei Orte, keine Popups).
 *
 * Globale Rückfragen – Bestätigung, Deep Link, SSH-Passwort, Profilimport –
 * erscheinen nicht als Dialog, sondern als Zeile direkt unter dem Kopf, im
 * Fluss des Layouts: der Inhalt rückt nach unten, nichts wird überdeckt,
 * nichts sperrt die Seite.
 *
 * Die Hosts sind global (in `__root.tsx`) eingehängt und damit außerhalb des
 * Layouts. Sie rendern deshalb über ein Portal in den Hinweis-Slot. Gibt das
 * Layout einen eigenen Slot `[data-workjet-inline-notices]` vor, wird er
 * genutzt; sonst legt dieser Baustein ihn einmalig direkt vor
 * `[data-workjet-content]` an, also zwischen Kopf und Inhalt.
 */
import { CircleHelpIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

export const INLINE_NOTICE_SLOT_ATTRIBUTE = "data-workjet-inline-notices";
const INLINE_NOTICE_SLOT_CLASS = "flex shrink-0 flex-col empty:hidden";

/**
 * Liefert den Hinweis-Slot unter dem Kopf und legt ihn bei Bedarf an.
 * `null`, solange das Layout (Kopf und Inhalt) noch nicht steht.
 */
export function ensureInlineNoticeSlot(doc: Document): HTMLElement | null {
  const existing = doc.querySelector<HTMLElement>(`[${INLINE_NOTICE_SLOT_ATTRIBUTE}]`);
  if (existing) return existing;
  const content = doc.querySelector<HTMLElement>("[data-workjet-content]");
  const parent = content?.parentElement;
  if (!content || !parent) return null;
  const slot = doc.createElement("div");
  slot.setAttribute(INLINE_NOTICE_SLOT_ATTRIBUTE, "");
  slot.className = INLINE_NOTICE_SLOT_CLASS;
  parent.insertBefore(slot, content);
  return slot;
}

/**
 * Hält den Slot aktuell, solange ein Hinweis sichtbar ist. Der erste Wert wird
 * synchron ermittelt (kein Aufblitzen an falscher Stelle); der Beobachter läuft
 * nur, während der aufrufende Hinweis eingehängt ist, und greift, wenn das
 * Layout erst noch hydriert oder neu aufgebaut wird.
 */
function useInlineNoticeSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : ensureInlineNoticeSlot(document),
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    let current: HTMLElement | null = null;
    const sync = () => {
      if (current?.isConnected) return;
      const next = ensureInlineNoticeSlot(document);
      if (next === current) return;
      current = next;
      setSlot(next);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return slot;
}

/**
 * Rendert Kinder in den Hinweis-Slot unter dem Kopf. Ohne Layout (z. B. vor
 * der Hydrierung) bleibt der Hinweis an Ort und Stelle im Fluss.
 */
export function InlineNoticePortal({ children }: { readonly children: ReactNode }) {
  const slot = useInlineNoticeSlot();
  if (!slot) return <>{children}</>;
  return createPortal(children, slot);
}

/**
 * Esc bricht die offene Rückfrage ab. Läuft in der Capture-Phase und markiert
 * das Ereignis als behandelt, damit z. B. die Einstellungen nicht zusätzlich
 * zurücknavigieren.
 */
export function useEscapeToCancel(onCancel: () => void, enabled = true): void {
  const cancel = useEffectEvent(() => onCancel());

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}

/**
 * Äußere Zeile aller Inline-Hinweise: Icon, Inhalt, Aktionen. Eine Zeile,
 * volle Breite, Rand unten – sie gehört zum Kopf, nicht zum Inhalt.
 */
export function InlineNoticeRow({
  icon: Icon,
  tone = "neutral",
  label,
  children,
  actions,
  className,
  bodyClassName,
  ...markers
}: {
  readonly icon: LucideIcon;
  readonly tone?: "neutral" | "destructive";
  /** Zugänglicher Name der Zeile, z. B. die Frage. */
  readonly label: string;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <div
      {...markers}
      aria-label={label}
      aria-live="polite"
      className={cn(
        "flex min-h-11 w-full min-w-0 items-center gap-3 border-b border-border bg-card px-3 py-1.5 text-[13.5px] sm:px-5",
        tone === "destructive" && "bg-destructive/6",
        className,
      )}
      data-slot="inline-notice"
      role="group"
    >
      <Icon
        aria-hidden
        className={cn(
          "size-4 shrink-0",
          tone === "destructive" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <div className={cn("flex min-w-0 flex-1 items-center gap-2", bodyClassName)}>{children}</div>
      <div className="ms-auto flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

export interface InlineConfirmBarProps {
  /** Die Frage, eine Zeile, höchstens 12 Wörter. */
  readonly question: string;
  /** Optionales Ziel hinter der Frage, z. B. ein Link (Monospace, gekürzt). */
  readonly target?: string | null;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly variant?: "default" | "destructive";
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** Optionale zweite Aktion zwischen Bestätigen und Abbrechen. */
  readonly secondary?: { readonly label: string; readonly onClick: () => void } | null;
  /** Zusätzliche Klassen der Zeile, z. B. Rahmen, wenn sie im Inhalt steht. */
  readonly className?: string;
  /** Testmarker für die Teile (Zeile, Bestätigen, Zweitaktion, Abbrechen). */
  readonly markers?: {
    readonly row?: string;
    readonly target?: string;
    readonly confirm?: string;
    readonly secondary?: string;
    readonly cancel?: string;
  };
}

/**
 * Nicht-modale Bestätigung: Frage · [Bestätigen] [Abbrechen]. Esc bricht ab.
 * Diese Knopfreihenfolge gilt überall (global, Git, Pull Requests).
 * Der Fokus springt auf „Abbrechen“, wie zuvor im AlertDialog: ein
 * versehentliches Enter löst nichts Zerstörerisches aus.
 */
export function InlineConfirmBar({
  question,
  target,
  confirmLabel = "Bestätigen",
  cancelLabel = "Abbrechen",
  variant = "default",
  busy = false,
  onConfirm,
  onCancel,
  secondary = null,
  className,
  markers,
}: InlineConfirmBarProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEscapeToCancel(onCancel, !busy);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const rowMarker = markers?.row ? { [`data-${markers.row}`]: "" } : {};

  return (
    <InlineNoticeRow
      {...rowMarker}
      // Die Zeile bricht um statt zu kürzen: auf 420 px stehen Frage und Ziel
      // lesbar oben, die Knöpfe darunter.
      bodyClassName="min-w-[min(100%,18rem)] flex-wrap"
      className={cn("flex-wrap", className)}
      actions={
        <>
          <Button
            {...(markers?.confirm ? { [`data-${markers.confirm}`]: "" } : {})}
            disabled={busy}
            size="sm"
            type="button"
            variant={variant}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
          {secondary ? (
            <Button
              {...(markers?.secondary ? { [`data-${markers.secondary}`]: "" } : {})}
              disabled={busy}
              size="sm"
              type="button"
              variant="outline"
              onClick={secondary.onClick}
            >
              {secondary.label}
            </Button>
          ) : null}
          <Button
            {...(markers?.cancel ? { [`data-${markers.cancel}`]: "" } : {})}
            ref={cancelRef}
            disabled={busy}
            size="sm"
            type="button"
            variant="outline"
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
        </>
      }
      icon={variant === "destructive" ? TriangleAlertIcon : CircleHelpIcon}
      label={question}
      tone={variant === "destructive" ? "destructive" : "neutral"}
    >
      <span className="min-w-0 font-medium break-words">{question}</span>
      {target ? (
        <span
          {...(markers?.target ? { [`data-${markers.target}`]: "" } : {})}
          className="min-w-0 flex-1 break-words text-muted-foreground"
        >
          {target}
        </span>
      ) : null}
    </InlineNoticeRow>
  );
}
