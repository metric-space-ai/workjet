import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  claimInlineExpand,
  InlineExpand,
  inlineExpandLabels,
  openInlineExpandCount,
  releaseInlineExpand,
} from "./inline-expand";
import { InlinePanel } from "./inline-panel";

describe("InlineExpand single-open registry", () => {
  afterEach(() => {
    releaseInlineExpand("a");
    releaseInlineExpand("b");
  });

  it("closes the previously open element when another opens", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    claimInlineExpand("a", closeA);
    claimInlineExpand("b", closeB);
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();
    expect(openInlineExpandCount()).toBe(1);
  });

  it("re-claiming the same element does not close it", () => {
    const closeA = vi.fn();
    claimInlineExpand("a", closeA);
    claimInlineExpand("a", closeA);
    expect(closeA).not.toHaveBeenCalled();
  });
});

describe("InlineExpand markup", () => {
  it("renders an animated open region with a collapse control", () => {
    const html = renderToStaticMarkup(
      <InlineExpand label="Name" open onOpenChange={() => undefined}>
        <input />
      </InlineExpand>,
    );
    expect(html).toContain('data-state="open"');
    expect(html).toContain("transition-[grid-template-rows,opacity]");
    expect(html).toContain('data-slot="inline-expand-collapse"');
    expect(html).toContain("Zuklappen");
    expect(html).toContain("<input");
  });

  it("renders nothing of the body while closed and marks the region inert", () => {
    const html = renderToStaticMarkup(
      <InlineExpand label="Name" open={false} onOpenChange={() => undefined}>
        <input />
      </InlineExpand>,
    );
    expect(html).toContain('data-state="closed"');
    expect(html).toContain("inert");
    expect(html).not.toContain("<input");
  });

  it("localizes the controls, German by default", () => {
    expect(inlineExpandLabels("de")).toEqual({ collapse: "Zuklappen", cancel: "Abbrechen" });
    expect(inlineExpandLabels("en")).toEqual({ collapse: "Collapse", cancel: "Cancel" });
  });
});

describe("InlinePanel", () => {
  const props = {
    triggerLabel: "Rechner hinzufügen",
    submitLabel: "Hinzufügen",
    onSubmit: () => undefined,
    onOpenChange: () => undefined,
  };

  it("shows only the trigger while closed", () => {
    const html = renderToStaticMarkup(
      <InlinePanel {...props} open={false}>
        <input />
      </InlinePanel>,
    );
    expect(html).toContain('data-slot="inline-panel-trigger"');
    expect(html).not.toContain('data-slot="inline-panel"');
  });

  it("opens in place inside an InlineExpand with cancel and collapse", () => {
    const html = renderToStaticMarkup(
      <InlinePanel {...props} open>
        <input />
      </InlinePanel>,
    );
    expect(html).not.toContain('data-slot="inline-panel-trigger"');
    expect(html).toContain('data-slot="inline-expand"');
    expect(html).toContain('data-slot="inline-panel"');
    expect(html).toContain("Abbrechen");
    expect(html).toContain('data-slot="inline-expand-collapse"');
  });
});
