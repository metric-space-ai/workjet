import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { WorkjetCapabilityMenu } from "./WorkjetCapabilityMenu";

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
   * Role and capabilities share one settings surface in compact mode too.
   */
  it("carries Orchestrator inside thread settings beside the provider Mode group", () => {
    const settingsContent = (
      <WorkjetCapabilityMenu
        compact
        greppyEnabled
        busy={false}
        onGreppyEnabledChange={() => undefined}
        workjetRole="orchestrator"
        onWorkjetRoleChange={() => undefined}
      />
    );
    const menu = renderMenu({
      ...baseProps,
      workjetMenuContent: settingsContent,
    });

    expect(containsNode(menu, settingsContent)).toBe(true);
    const text = textContent(menu);
    expect(text).toContain("Mode");
    expect(text).toContain("Plan");
    // "Build" matches the wide toggle now — same state, same word (K-A4).
    expect(text).toContain("Build");
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

  it("keeps System Prompt before Tools in the compact overflow menu", () => {
    const contextWindowContent = <span data-test-context-window-menu="true">Context</span>;
    const systemPromptContent = <span data-test-system-prompt-menu="true">System prompt</span>;
    const toolsContent = <span data-test-tools-menu="true">Tools</span>;
    const menu = renderMenu({
      ...baseProps,
      contextWindowMenuContent: contextWindowContent,
      systemPromptMenuContent: systemPromptContent,
      workjetMenuContent: toolsContent,
    });

    expect(containsNode(menu, contextWindowContent)).toBe(true);
    expect(containsNode(menu, systemPromptContent)).toBe(true);
    expect(containsNode(menu, toolsContent)).toBe(true);
    expect(textContent(menu).indexOf("Context")).toBeLessThan(
      textContent(menu).indexOf("System prompt"),
    );
    expect(textContent(menu).indexOf("System prompt")).toBeLessThan(
      textContent(menu).indexOf("Tools"),
    );
  });

  it("omits thread settings when the thread has no server configuration", () => {
    const menu = renderMenu(baseProps);
    const text = textContent(menu);

    expect(text).toContain("Mode");
    // Permission is ALWAYS full (operator rule): no Access group exists.
    expect(text).not.toContain("Access");
    expect(text).not.toContain("Orchestrator");
  });
});
