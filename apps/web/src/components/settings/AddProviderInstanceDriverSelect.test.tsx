import type { ReactElement } from "react";
import { ProviderDriverKind } from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import {
  AddProviderInstanceDriverSelect,
  COMING_SOON_DRIVER_OPTIONS,
} from "./AddProviderInstanceDriverSelect";
import { DRIVER_OPTIONS } from "./providerDriverMeta";

type Element = ReactElement<Record<string, unknown>>;

function collectItems(tree: unknown): Element[] {
  const items: Element[] = [];
  visitElements(tree, (element) => {
    if (typeof element.props["value"] === "string" && "hideIndicator" in element.props) {
      items.push(element);
    }
    return false;
  });
  return items;
}

function render(onDriverChange = vi.fn()) {
  return AddProviderInstanceDriverSelect({
    driver: ProviderDriverKind.make("codex"),
    onDriverChange,
  }) as Element;
}

describe("AddProviderInstanceDriverSelect (single-level add panel)", () => {
  it("offers only shipped harnesses; upcoming ones are not choices (#617)", () => {
    const items = collectItems(render());

    expect(items).toHaveLength(DRIVER_OPTIONS.length);
    expect(items.some((item) => item.props["disabled"] === true)).toBe(false);
    expect(COMING_SOON_DRIVER_OPTIONS.length).toBeGreaterThan(0);
  });

  it("offers only the given (not yet installed) harnesses", () => {
    const items = collectItems(
      AddProviderInstanceDriverSelect({
        driver: DRIVER_OPTIONS[1]!.value,
        onDriverChange: vi.fn(),
        options: DRIVER_OPTIONS.slice(1),
      }) as Element,
    );
    expect(items).toHaveLength(DRIVER_OPTIONS.length - 1);
  });

  it("switches the harness for a shipped driver", () => {
    const onDriverChange = vi.fn();
    const select = render(onDriverChange);
    const onValueChange = select.props["onValueChange"] as (value: unknown) => void;

    onValueChange("claudeAgent");

    expect(onDriverChange).toHaveBeenCalledWith("claudeAgent");
  });

  it("ignores values that are not shipped drivers", () => {
    const onDriverChange = vi.fn();
    const select = render(onDriverChange);
    const onValueChange = select.props["onValueChange"] as (value: unknown) => void;

    onValueChange("gemini");
    onValueChange(null);

    expect(onDriverChange).not.toHaveBeenCalled();
  });

  it("labels the selection in German without wizard steps", () => {
    const select = render();
    const trigger = visitElements(select, (element) => element.props["aria-label"] === "Harness");
    expect(trigger).not.toBeNull();
    const stepButton = visitElements(select, (element) => element.props["aria-current"] === "step");
    expect(stepButton).toBeNull();
  });
});
