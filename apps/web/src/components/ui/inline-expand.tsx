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
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

const COLLAPSE_FALLBACK_MS = 260;

import { cn } from "~/lib/utils";

type CloseHandler = () => void;

const openRegistry = new Map<string, CloseHandler>();

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

/** Test helper: number of currently open elements. */
export function openInlineExpandCount(): number {
  return openRegistry.size;
}

export function inlineExpandLabels(language: "de" | "en" = uiLanguage()) {
  return language === "en"
    ? { collapse: "Collapse", cancel: "Cancel" }
    : { collapse: "Zuklappen", cancel: "Abbrechen" };
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
  const id = useId();
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
            <button
              aria-label={labels.collapse}
              className="absolute end-1.5 top-1.5 z-10 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              data-slot="inline-expand-collapse"
              title={`${labels.collapse} (Esc)`}
              type="button"
              onClick={() => onOpenChange(false)}
            >
              <ChevronUpIcon className="size-4" />
            </button>
          )}
          {open ? children : present ? lastChildrenRef.current : null}
        </div>
      </div>
    </div>
  );
}
