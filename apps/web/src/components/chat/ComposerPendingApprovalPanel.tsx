import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    approval.requestKind === "command"
      ? "Freigabe für Befehl"
      : approval.requestKind === "file-read"
        ? "Freigabe zum Lesen"
        : "Freigabe für Dateiänderung";
  const detailLabel =
    approval.requestKind === "command"
      ? "Befehl"
      : approval.requestKind === "file-read"
        ? "Datei"
        : "Dateiänderung";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">Freigabe offen</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.detail ? (
        <div className="mt-3 rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">{detailLabel}</p>
          <pre
            aria-label={detailLabel}
            className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground"
            data-approval-detail="complete"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
