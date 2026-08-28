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
  it("uses the shared catalog-versus-pattern explanation", () => {
    expect(findTooltipText(WorkjetGatewayModelCountsHelp())).toBe(
      WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION,
    );
    expect(WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION).toContain("do not need to match");
    expect(WORKJET_GATEWAY_MODEL_COUNTS_EXPLANATION).toContain(
      "neither is live availability or capacity",
    );
  });

  it("distinguishes catalog models from account patterns in singular and plural", () => {
    expect(formatWorkjetGatewayCatalogModelCount(1)).toBe("1 catalog model");
    expect(formatWorkjetGatewayCatalogModelCount(2)).toBe("2 catalog models");
    expect(formatWorkjetGatewayAccountPatternCount(1)).toBe("1 account pattern");
    expect(formatWorkjetGatewayAccountPatternCount(2)).toBe("2 account patterns");
  });
});
