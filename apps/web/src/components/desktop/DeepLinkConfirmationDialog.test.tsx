import type { DesktopPendingDeepLink } from "@t3tools/contracts";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { DeepLinkConfirmationPrompt } from "./DeepLinkConfirmationDialog";

const link: DesktopPendingDeepLink = {
  linkId: "deep-link-1",
  scheme: "ctox-desktop",
  canonicalUrl: "t3code://app/threads/abc?tab=diff",
  path: "/threads/abc",
  search: "?tab=diff",
  hash: "",
};

type ClickableProps = Record<string, unknown> & { readonly onClick?: () => void };

function findByMarker(node: ReactNode, marker: string): ClickableProps | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = (child as ReactElement<ClickableProps>).props;
    if (props[marker] !== undefined) return props;
    const found = findByMarker(props["children"] as ReactNode, marker);
    if (found) return found;
  }
  return null;
}

function collectText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (!isValidElement(child)) return "";
      return collectText((child as ReactElement<ClickableProps>).props["children"] as ReactNode);
    })
    .join(" ");
}

describe("DeepLinkConfirmationPrompt", () => {
  // The dialog body renders through a portal, so static markup is empty here;
  // the element tree is the observable surface in this environment.
  it("shows the canonical target the confirmation applies to", () => {
    const element = DeepLinkConfirmationPrompt({
      link,
      onConfirm: () => undefined,
      onDismiss: () => undefined,
    });

    const target = findByMarker(element, "data-deep-link-target");
    expect(target).not.toBeNull();
    expect(collectText(target?.["children"] as ReactNode)).toContain(
      "t3code://app/threads/abc?tab=diff",
    );
    expect(collectText(element)).toContain("ctox-desktop");
  });

  it("navigates through the supplied callback only when the user confirms", () => {
    const navigated: string[] = [];
    const dismissed: string[] = [];
    const element = DeepLinkConfirmationPrompt({
      link,
      onConfirm: () => navigated.push(link.canonicalUrl),
      onDismiss: () => dismissed.push(link.linkId),
    });

    const dismiss = findByMarker(element, "data-deep-link-dismiss");
    expect(dismiss).not.toBeNull();
    dismiss?.onClick?.();
    expect(navigated).toEqual([]);
    expect(dismissed).toEqual([link.linkId]);

    const confirm = findByMarker(element, "data-deep-link-confirm");
    expect(confirm).not.toBeNull();
    confirm?.onClick?.();
    expect(navigated).toEqual([link.canonicalUrl]);
  });
});
