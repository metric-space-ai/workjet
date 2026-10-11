import { InfoIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Tooltip only, at most 12 words (UI-Vertrag §2). */
export const WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION =
  "Katalogmodelle und Kontomuster zählen Verschiedenes; keins zeigt Live-Verfügbarkeit.";

export function formatWorkjetGatewayCatalogModelCount(count: number): string {
  return `${count} ${count === 1 ? "Katalogmodell" : "Katalogmodelle"}`;
}

export function formatWorkjetGatewayAccountPatternCount(count: number): string {
  return `${count} Kontomuster`;
}

export function WorkjetGatewayModelCountsHelp() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="icon-xs" variant="ghost" aria-label="Zählweise der Modelle" />}
      >
        <InfoIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION}</TooltipPopup>
    </Tooltip>
  );
}
