import { InfoIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION =
  "Gateway catalog models are models listed by the gateway. Account model patterns are stored routing patterns on one account. The totals measure different things, do not need to match, and neither is live availability or capacity.";

export function formatWorkjetGatewayCatalogModelCount(count: number): string {
  return `${count} catalog ${count === 1 ? "model" : "models"}`;
}

export function formatWorkjetGatewayAccountPatternCount(count: number): string {
  return `${count} account ${count === 1 ? "pattern" : "patterns"}`;
}

export function WorkjetGatewayModelCountsHelp() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:text-foreground"
            aria-label="Explain gateway model counts"
          >
            <InfoIcon className="size-3" />
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-72 whitespace-normal leading-relaxed">
        {WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION}
      </TooltipPopup>
    </Tooltip>
  );
}
