"use client";

/**
 * InlineExpand: the one way an element opens for in-place editing.
 *
 * - Opens inside the element itself; no dialog, sheet, popover or route jump.
 * - Height animates (grid-rows 0fr → 1fr), so nothing below jumps.
 * - Only one InlineExpand is open at a time: opening one closes the others.
 * - Always an obvious way back: a chevron "Zuklappen" control and Esc.
 */
import { ChevronUpIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

const COLLAPSE_FALLBACK_MS = 260;

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

type CloseHandler = () => void;

const openRegistry = new Map<string, CloseHandler>();
let inlineExpandSequence = 0;

/** Marks `id` as the open element and closes every other open one. */
export function claimInlineExpand(id: string, close: CloseHandler): void {
  for (const [otherId, otherClose] of openRegistry) {
    if (otherId !== id) {
      openRegistry.delete(otherId);
      otherClose();
    }
  }
  openRegistry.set(id, close);
}

export function releaseInlineExpand(id: string): void {
  openRegistry.delete(id);
}

/** Closes the open element, if any. Returns whether something was closed. */
export function closeOpenInlineExpand(): boolean {
  let closed = false;
  for (const [id, close] of openRegistry) {
    openRegistry.delete(id);
    close();
    closed = true;
  }
  return closed;
}

/** Test helper: number of currently open elements. */
export function openInlineExpandCount(): number {
  return openRegistry.size;
}

export function inlineExpandLabels(language: "de" | "en" = uiLanguage()) {
  return language === "en"
    ? { collapse: "Collapse", cancel: "Cancel", save: "Save", saving: "Saving …" }
    : { collapse: "Zuklappen", cancel: "Abbrechen", save: "Speichern", saving: "Speichert …" };
}

function uiLanguage(): "de" | "en" {
  const lang = typeof document === "undefined" ? "de" : document.documentElement.lang;
  return lang.toLowerCase().startsWith("en") ? "en" : "de";
}

/**
 * Registers an open/close pair with the single-open registry and wires Esc.
 * Use it directly when a component renders its own expanded body.
 */
export function useSingleInlineExpand(
  open: boolean,
  onOpenChange: (open: boolean) => void,
): string {
  // Counter instead of useId: works in hook-mocking unit tests too.
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) idRef.current = `inline-expand-${++inlineExpandSequence}`;
  const id = idRef.current;
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  useEffect(() => {
    if (!open) return;
    claimInlineExpand(id, () => closeRef.current(false));
    return () => releaseInlineExpand(id);
  }, [id, open]);
  return id;
}

export interface InlineExpandProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Accessible name of the expanded region, e.g. the element's title. */
  readonly label: string;
  readonly children: ReactNode;
  /** Hide the built-in collapse chevron when the body has its own close row. */
  readonly hideCollapseControl?: boolean;
  /** Navigation disclosure (not an editor): skip the single-open rule. */
  readonly independent?: boolean;
  readonly className?: string;
}

export function InlineExpand({
  open,
  onOpenChange,
  label,
  children,
  hideCollapseControl,
  independent = false,
  className,
}: InlineExpandProps) {
  const id = useSingleInlineExpand(open && !independent, onOpenChange);
  const regionRef = useRef<HTMLDivElement>(null);
  const labels = inlineExpandLabels();
  // Keep the body mounted while it collapses so the height animates down
  // instead of the content vanishing first.
  const [present, setPresent] = useState(open);
  // Callers often stop passing the body once closed; keep the last body so
  // the collapse still animates with real content.
  const lastChildrenRef = useRef<ReactNode>(null);
  if (open) lastChildrenRef.current = children;
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timeoutId = window.setTimeout(() => setPresent(false), COLLAPSE_FALLBACK_MS);
    return () => window.clearTimeout(timeoutId);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const region = regionRef.current;
    const first = region?.querySelector<HTMLElement>(
      "input:not([type=hidden]),textarea,select,[contenteditable=true]",
    );
    first?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div
      aria-hidden={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      data-slot="inline-expand"
      data-state={open ? "open" : "closed"}
      inert={!open}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) setPresent(false);
      }}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          ref={regionRef}
          aria-label={label}
          className={cn("relative", className)}
          id={id}
          role="region"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(false);
          }}
        >
          {hideCollapseControl ? null : (
            // In the flow, never over the content (Audit A-06/D-01): an icon button with
            // tooltip in its own slim row above the body.
            <div className="-mb-1 flex justify-end">
              <Button
                aria-label={labels.collapse}
                data-slot="inline-expand-collapse"
                size="icon-xs"
                title={`${labels.collapse} (Esc)`}
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                <ChevronUpIcon aria-hidden className="size-4" />
              </Button>
            </div>
          )}
          {open ? children : present ? lastChildrenRef.current : null}
        </div>
      </div>
    </div>
  );
}
