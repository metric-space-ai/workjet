import type { ReactNode } from "react";

/**
 * Die rechte Leiste bei schmaler Breite: inline statt modalem Sheet. Sie nimmt
 * die volle Breite der Zeile ein und schiebt den Chat beiseite; geschlossen
 * wird sie über die Schalter in ihrer Kopfzeile. Kein Overlay, kein Fokus-Fang.
 */
export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  /** Kept for callers; closing happens through the panel's own controls. */
  onClose: () => void;
}) {
  if (!props.open) return null;
  return (
    <aside
      className="flex h-full min-h-0 w-full min-w-0 shrink-0 flex-col overflow-hidden border-border border-l bg-background"
      data-right-panel-narrow-inline="true"
    >
      {props.children}
    </aside>
  );
}
