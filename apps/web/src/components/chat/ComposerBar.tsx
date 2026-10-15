import { SlidersHorizontalIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
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
 * Harness, Modell, Rechner und Kontext gehen in EINEN Sammel-Chip, der als
 * Menü aufgeht (UI-Vertrag §7, Audit B #6). Die Steuerungen bleiben dabei
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
  },
) {
  const targets = (
    <>
      {props.worker}
      {props.manual}
      {props.status}
    </>
  );
  return (
    <div
      ref={props.barRef}
      data-composer-bar="true"
      data-composer-bar-narrow={props.narrow ? "true" : undefined}
      className="flex w-full min-w-0 items-center gap-1"
    >
      <div data-composer-bar-attachments="true" className="flex shrink-0 items-center">
        {props.attachments}
      </div>
      {props.narrow ? (
        <div data-composer-bar-target="true" className="flex min-w-0 flex-1 items-center">
          <Popover>
            <PopoverTrigger
              render={
                <ComposerControl
                  type="button"
                  aria-label="Ziel wählen"
                  data-composer-bar-collapsed="true"
                  className="min-w-0 max-w-full data-popup-open:bg-accent"
                />
              }
            >
              <ComposerControlIcon icon={SlidersHorizontalIcon} />
              <span className="min-w-0 truncate">{props.targetSummary || "Ziel"}</span>
              <ComposerControlChevron />
            </PopoverTrigger>
            <PopoverPopup
              keepMounted
              side="top"
              align="start"
              className="max-w-[calc(100vw-2rem)]"
              viewportClassName="py-2 [--viewport-inline-padding:--spacing(2)]"
            >
              <div
                data-composer-bar-collapsed-targets="true"
                className="flex min-w-0 flex-col items-stretch gap-1 [&>*]:min-w-0 [&>*]:justify-start"
              >
                {targets}
              </div>
            </PopoverPopup>
          </Popover>
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
}
