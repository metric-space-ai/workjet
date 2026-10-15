import type { ReactNode } from "react";

/**
 * One ordered bar beneath every thread's full-width editor.
 *
 * Narrow composers (under 36rem, e.g. 420 px windows) keep the target chips on
 * ONE line: chips shrink and truncate their labels and drop the chevrons,
 * instead of stacking into five rows (UI-Vertrag §7, Audit B #6).
 */
export function ComposerBar(props: {
  readonly attachments: ReactNode;
  readonly worker: ReactNode;
  readonly manual?: ReactNode;
  readonly settings: ReactNode;
  readonly dictation: ReactNode;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div
      data-composer-bar="true"
      className="@container/composer-bar flex w-full min-w-0 items-center gap-1"
    >
      <div data-composer-bar-attachments="true" className="flex shrink-0 items-center">
        {props.attachments}
      </div>
      <div
        data-composer-bar-target="true"
        className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-hidden py-1 [&>*]:min-w-0 [&>*]:shrink [&_[data-composer-control-chevron]]:hidden @[36rem]/composer-bar:flex-wrap @[36rem]/composer-bar:overflow-visible @[36rem]/composer-bar:[&_[data-composer-control-chevron]]:block"
      >
        {props.worker}
        {props.manual}
        {props.status}
      </div>
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
