import { SlidersHorizontalIcon } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";

/** Unter 36rem (z. B. 420-px-Fenster) fasst ein Sammel-Chip die Zielchips zusammen. */
export const COMPOSER_BAR_NARROW_PX = 576;

export interface ComposerBarProps {
  readonly attachments: ReactNode;
  readonly worker: ReactNode;
  readonly manual?: ReactNode;
  readonly settings: ReactNode;
  readonly dictation: ReactNode;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  /** Kurzname des Ziels für den Sammel-Chip (z. B. Preset-Name); sonst „Ziel“. */
  readonly targetSummary?: string | null | undefined;
}

/**
 * One ordered bar beneath every thread's full-width editor.
 *
 * Narrow composers (under 36rem, e.g. 420 px windows) stay ONE line: Preset,
 * Harness, Modell, Rechner und Kontext gehen in EINEN Sammel-Chip (UI-Vertrag
 * §7, Audit B #6). Er klappt die Chips inline unter der Leiste auf, nicht als
 * Popover (Wächter „drei Orte“: keine Popups). Die Steuerungen bleiben dabei
 * gemountet, damit ihr Zustand (z. B. Routenstatus) nicht verloren geht.
 */
export function ComposerBar(props: ComposerBarProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setNarrow(element.getBoundingClientRect().width < COMPOSER_BAR_NARROW_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <ComposerBarLayout {...props} narrow={narrow} barRef={ref} />;
}

export function ComposerBarLayout(
  props: ComposerBarProps & {
    readonly narrow: boolean;
    readonly barRef?: React.Ref<HTMLDivElement>;
    /** Nur für Fixture und Tests: aufgeklappt starten. */
    readonly initiallyExpanded?: boolean;
  },
) {
  const [expanded, setExpanded] = useState(props.initiallyExpanded ?? false);
  const targetsId = useId();
  const targets = (
    <>
      {props.worker}
      {props.manual}
      {props.status}
    </>
  );
  const bar = (
    <div
      data-composer-bar="true"
      data-composer-bar-narrow={props.narrow ? "true" : undefined}
      className="flex w-full min-w-0 items-center gap-1"
    >
      <div data-composer-bar-attachments="true" className="flex shrink-0 items-center">
        {props.attachments}
      </div>
      {props.narrow ? (
        <div data-composer-bar-target="true" className="flex min-w-0 flex-1 items-center">
          <ComposerControl
            type="button"
            aria-label="Ziel wählen"
            aria-expanded={expanded}
            aria-controls={targetsId}
            data-composer-bar-collapsed="true"
            className={cn("min-w-0 max-w-full", expanded && "bg-accent text-foreground")}
            onClick={() => setExpanded((current) => !current)}
          >
            <ComposerControlIcon icon={SlidersHorizontalIcon} />
            <span className="min-w-0 truncate">{props.targetSummary || "Ziel"}</span>
            <ComposerControlChevron />
          </ComposerControl>
        </div>
      ) : (
        <div
          data-composer-bar-target="true"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1"
        >
          {targets}
        </div>
      )}
      <div data-composer-bar-settings="true" className="flex shrink-0 items-center">
        {props.settings}
      </div>
      <div data-composer-bar-dictation="true" className="flex shrink-0 items-center">
        {props.dictation}
      </div>
      {props.actions}
    </div>
  );
  // The wrapper is stable across narrow/wide, so the width observer keeps its element.
  return (
    <div ref={props.barRef} className="flex w-full min-w-0 flex-col gap-1">
      {bar}
      {props.narrow ? (
        // Inline am Klickort; zugeklappt bleiben die Steuerungen gemountet, aber verborgen.
        <div
          id={targetsId}
          data-composer-bar-collapsed-targets="true"
          hidden={!expanded}
          className="flex min-w-0 flex-wrap items-center gap-1 [&>*]:min-w-0"
        >
          {targets}
        </div>
      ) : null}
    </div>
  );
}
