import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { TooltipPopup } from "../ui/tooltip";
import {
  formatWorkjetGatewayAccountPatternCount,
  formatWorkjetGatewayCatalogModelCount,
  WorkjetGatewayModelCountsHelp,
  WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION,
} from "./WorkjetGatewayModelCountsHelp";

type InspectableElement = ReactElement<
  Readonly<Record<string, unknown>> & { readonly children?: ReactNode }
>;

function findTooltipText(node: ReactNode): string | undefined {
  if (Array.isArray(node)) {
    return node.map(findTooltipText).find((text) => text !== undefined);
  }
  if (!isValidElement(node)) return undefined;

  const element = node as InspectableElement;
  if (element.type === TooltipPopup) {
    return String(element.props.children);
  }
  return findTooltipText(element.props.children);
}

describe("WorkjetGatewayModelCountsHelp", () => {
  it("uses one short tooltip for the catalog-versus-pattern distinction", () => {
    expect(findTooltipText(WorkjetGatewayModelCountsHelp())).toBe(
      WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION,
    );
    expect(WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION).toContain("Live-Verfügbarkeit");
  });

  it("distinguishes catalog models from account patterns in singular and plural", () => {
    expect(formatWorkjetGatewayCatalogModelCount(1)).toBe("1 Katalogmodell");
    expect(formatWorkjetGatewayCatalogModelCount(2)).toBe("2 Katalogmodelle");
    expect(formatWorkjetGatewayAccountPatternCount(1)).toBe("1 Kontomuster");
    expect(formatWorkjetGatewayAccountPatternCount(2)).toBe("2 Kontomuster");
  });
});
