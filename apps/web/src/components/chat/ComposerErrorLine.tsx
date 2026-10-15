import type { ReactNode } from "react";
import { Button } from "../ui/button";
import type { ComposerErrorLine as ComposerErrorLineValue } from "./composerErrorLineLogic";

/** Eine Zeile, genau eine Aktion; Rohtext erscheint nie im Chat (UI-Vertrag §2). */
export function ComposerErrorLine(props: {
  readonly line: ComposerErrorLineValue;
  readonly onAction: (() => void) | null;
  readonly disabled?: boolean;
  readonly busyLabel?: string | null;
  /** Ersetzt die Aktion, z. B. durch eine Auswahl. */
  readonly control?: ReactNode;
}) {
  const { line } = props;
  return (
    <div
      role="status"
      data-supervisor-connection-status="true"
      data-composer-error-kind={line.kind}
      className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground"
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">{line.text}</span>
      {props.control ??
        (props.onAction ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={props.disabled}
            onClick={props.onAction}
          >
            {props.busyLabel ?? line.actionLabel}
          </Button>
        ) : null)}
    </div>
  );
}
