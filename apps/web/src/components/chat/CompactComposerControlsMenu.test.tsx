import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { WorkjetRoleControl } from "./WorkjetRoleControl";

type InspectableElement = ReactElement<
  Readonly<Record<string, unknown>> & { readonly children?: ReactNode }
>;

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement(node)) return textContent((node as InspectableElement).props.children);
  return "";
}

function containsNode(tree: ReactNode, needle: ReactNode): boolean {
  if (tree === needle) return true;
  if (Array.isArray(tree)) return tree.some((child) => containsNode(child, needle));
  if (!isValidElement(tree)) return false;
  return containsNode((tree as InspectableElement).props.children, needle);
}

/** `memo` wraps the component; `.type` is the function it memoizes. */
const renderMenu = (props: Parameters<typeof CompactComposerControlsMenu>[0]): InspectableElement =>
  (
    CompactComposerControlsMenu as unknown as { type: (p: typeof props) => InspectableElement }
  ).type(props);

const baseProps = {
  interactionMode: "default",
  showInteractionModeToggle: true,
  onToggleInteractionMode: () => undefined,
} as const;

describe("CompactComposerControlsMenu", () => {
  /**
   * The compact footer folds every control except the model picker and the
   * primary actions into this menu. The Workjet role has to survive that fold
   * alongside the provider's Plan/Build ("Mode") group, not instead of it.
   */
  it("carries the Workjet role group and the provider Mode group together", () => {
    const roleContent = (
      <WorkjetRoleControl
        compact
        role="orchestrator"
        busy={false}
        onRoleChange={() => undefined}
        onOpenSettings={() => undefined}
      />
    );
    const menu = renderMenu({
      ...baseProps,
      workjetRoleMenuContent: roleContent,
    });

    expect(containsNode(menu, roleContent)).toBe(true);
    const text = textContent(menu);
    expect(text).toContain("Mode");
    expect(text).toContain("Plan");
    expect(text).toContain("Chat");
    // Permission is ALWAYS full (operator rule): no Access group exists.
    expect(text).not.toContain("Access");
  });

  /**
   * Below the breakpoint the Worker and Computer choices must still exist —
   * the compact menu carries them in its own slot, before everything else.
   */
  it("carries the worker menu slot so Worker and Computer exist when compact", () => {
    const workerContent = <span data-test-worker-menu="true">worker</span>;
    const menu = renderMenu({
      ...baseProps,
      workerMenuContent: workerContent,
    });

    expect(containsNode(menu, workerContent)).toBe(true);
  });

  it("omits the role group when the thread has no server configuration", () => {
    const menu = renderMenu(baseProps);
    const text = textContent(menu);

    expect(text).toContain("Mode");
    // Permission is ALWAYS full (operator rule): no Access group exists.
    expect(text).not.toContain("Access");
    expect(text).not.toContain("Orchestrator");
  });
});
