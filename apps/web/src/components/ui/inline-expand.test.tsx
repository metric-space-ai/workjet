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
    expect(inlineExpandLabels("de")).toEqual({
      collapse: "Zuklappen",
      cancel: "Abbrechen",
      save: "Speichern",
      saving: "Speichert …",
    });
    expect(inlineExpandLabels("en")).toEqual({
      collapse: "Collapse",
      cancel: "Cancel",
      save: "Save",
      saving: "Saving …",
    });
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

describe("Row click-to-edit", () => {
  it("makes name and meta a toggle with a chevron instead of a ⋯ → Bearbeiten entry", async () => {
    const { Row } = await import("./row");
    const closed = renderToStaticMarkup(
      <Row name="gpu4" meta="SSH" onToggleExpanded={() => undefined} />,
    );
    expect(closed).toContain('data-slot="row-open"');
    expect(closed).toContain('aria-expanded="false"');
    const open = renderToStaticMarkup(
      <Row name="gpu4" meta="SSH" expanded onToggleExpanded={() => undefined} />,
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("rotate-180");
  });

  it("stays a plain row without a toggle", async () => {
    const { Row } = await import("./row");
    expect(renderToStaticMarkup(<Row name="gpu4" />)).not.toContain("row-open");
  });
});

describe("InlineExpand independent", () => {
  it("does not join the single-open registry", () => {
    const before = openInlineExpandCount();
    renderToStaticMarkup(
      <InlineExpand independent label="Apps" open onOpenChange={() => undefined}>
        <span />
      </InlineExpand>,
    );
    expect(openInlineExpandCount()).toBe(before);
  });
});

describe("InlineExpand collapse control (Audit A-06 / D01)", () => {
  it("sits in its own row before the body instead of floating over it", () => {
    const html = renderToStaticMarkup(
      <InlineExpand label="Reparieren" open onOpenChange={() => undefined}>
        <label>
          Port
          <input />
        </label>
        <button type="button">Prüfen</button>
      </InlineExpand>,
    );
    const control = html.indexOf('data-slot="inline-expand-collapse"');
    expect(control).toBeGreaterThan(-1);
    // Before the first field: no overlap with labels or the first action.
    expect(control).toBeLessThan(html.indexOf("Port"));
    expect(control).toBeLessThan(html.indexOf("Prüfen"));
    // No absolutely positioned control; an icon button with tooltip, no text-xs label.
    const tag = html.slice(html.lastIndexOf("<button", control), html.indexOf(">", control));
    // Only pseudo-element helpers of ui/button may be absolute, never the control itself.
    expect(tag).not.toMatch(/[\s"]absolute[\s"]/);
    expect(tag).not.toContain("top-1.5");
    expect(tag).toContain('title="Zuklappen (Esc)"');
    expect(html).not.toMatch(/<span>Zuklappen<\/span>/);
  });
});
