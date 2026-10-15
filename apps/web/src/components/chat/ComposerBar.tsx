import type { ReactNode } from "react";

/** One ordered bar beneath every thread's full-width editor. */
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
    <div data-composer-bar="true" className="flex w-full min-w-0 items-center gap-1">
      <div data-composer-bar-attachments="true" className="flex shrink-0 items-center">
        {props.attachments}
      </div>
      <div
        data-composer-bar-target="true"
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1"
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
