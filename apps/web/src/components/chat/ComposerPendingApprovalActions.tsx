import { type ApprovalRequestId, type ProviderApprovalDecision } from "@workjet/contracts";
import { EllipsisIcon } from "lucide-react";
import { memo } from "react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

/**
 * Freigabe im Composer (UI-Vertrag §2): nur `default`/`outline`, ehrliche
 * Beschriftung („Für diese Sitzung erlauben“ sendet `acceptForSession`),
 * das seltene Abbrechen des Zugs liegt im ⋯-Menü.
 */
export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      <Menu>
        <MenuTrigger
          disabled={isResponding}
          render={
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Weitere Aktionen"
              title="Weitere Aktionen"
            />
          }
        >
          <EllipsisIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" side="top">
          <MenuItem onClick={() => void onRespondToApproval(requestId, "cancel")}>
            Abbrechen
          </MenuItem>
        </MenuPopup>
      </Menu>
      <Button
        size="sm"
        variant="outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Ablehnen
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        Für diese Sitzung erlauben
      </Button>
      <Button
        size="sm"
        variant="default"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        Einmal erlauben
      </Button>
    </>
  );
});
