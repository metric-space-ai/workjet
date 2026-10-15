import type { DesktopSupportBundleResult } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  describeSupportBundleRedaction,
  formatSupportBundleSize,
  INITIAL_SUPPORT_BUNDLE_STATE,
  SupportBundleSectionView,
} from "./SupportBundleSection";

const RESULT: DesktopSupportBundleResult = {
  filePath:
    "/Users/alice/Library/Application Support/.workjet/userdata/support-bundles/bundle.json",
  byteLength: 20_480,
  fieldCount: 142,
  redactedFieldCount: 7,
  omittedFieldCount: 3,
  generatedAtIso: "2026-08-20T10:00:00.000Z",
};

const renderView = (props: Partial<Parameters<typeof SupportBundleSectionView>[0]> = {}): string =>
  renderToStaticMarkup(
    <SupportBundleSectionView
      state={INITIAL_SUPPORT_BUNDLE_STATE}
      isAvailable
      isPathCopied={false}
      onCreate={() => {}}
      onCopyPath={() => {}}
      {...props}
    />,
  );

describe("support bundle section", () => {
  it("formats sizes and the redaction receipt", () => {
    expect(formatSupportBundleSize(512)).toBe("512 B");
    expect(formatSupportBundleSize(20_480)).toBe("20 KB");
    expect(formatSupportBundleSize(2_097_152)).toBe("2,0 MB");
    expect(describeSupportBundleRedaction(RESULT)).toBe(
      "20 KB · 142 Felder · 7 geschwärzt · 3 ausgelassen",
    );
  });

  it("offers the action as title plus button, without paragraphs", () => {
    const markup = renderView();
    expect(markup).toContain("Hilfepaket");
    expect(markup).not.toContain("Datei bleibt auf diesem Rechner");
    expect(markup).toContain("Erstellen");
    expect(markup).not.toMatch(/<p[\s>]/);
  });

  it("shows the exact path and the redaction counts after a run", () => {
    const markup = renderView({
      state: { status: "created", result: RESULT, errorMessage: null },
    });
    expect(markup).toContain(RESULT.filePath);
    expect(markup).toContain("7 geschwärzt");
    expect(markup).toContain("Pfad kopieren");
  });

  it("hides the whole section off the desktop instead of a dead button", () => {
    expect(renderView({ isAvailable: false })).toBe("");
  });

  it("surfaces a failure instead of pretending a bundle exists", () => {
    const markup = renderView({
      state: { status: "failed", result: null, errorMessage: "state directory is read-only" },
    });
    expect(markup).toContain("state directory is read-only");
    expect(markup).not.toContain("support-bundles/");
  });

  // The section must never grow a send affordance. Adding one would need a
  // bridge method that deliberately does not exist; this guards the copy too.
  it("offers no way to upload, send, or share the bundle", () => {
    for (const markup of [
      renderView(),
      renderView({ state: { status: "created", result: RESULT, errorMessage: null } }),
    ]) {
      const actionable = markup.toLowerCase();
      expect(actionable).not.toContain(">upload");
      expect(actionable).not.toContain(">send");
      expect(actionable).not.toContain(">share");
      expect(actionable).not.toContain('aria-label="send');
      expect(actionable).not.toContain('aria-label="upload');
    }
  });
});
