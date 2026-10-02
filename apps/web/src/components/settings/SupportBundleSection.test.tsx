import type { DesktopSupportBundleResult } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  describeSupportBundleRedaction,
  formatSupportBundleSize,
  INITIAL_SUPPORT_BUNDLE_STATE,
  SUPPORT_BUNDLE_UNAVAILABLE_MESSAGE,
  SupportBundleSectionView,
} from "./SupportBundleSection";

const RESULT: DesktopSupportBundleResult = {
  filePath: "/Users/alice/Library/Application Support/.t3/userdata/support-bundles/bundle.json",
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
    expect(formatSupportBundleSize(2_097_152)).toBe("2.0 MB");
    expect(describeSupportBundleRedaction(RESULT)).toBe(
      "20 KB · 142 fields collected · 7 redacted · 3 omitted",
    );
  });

  it("offers the action and promises no upload", () => {
    const markup = renderView();
    expect(markup).toContain("Create support bundle");
    expect(markup).toContain("Nothing is uploaded");
    expect(markup).toContain("read it before you send it");
  });

  it("shows the exact path and the redaction counts after a run", () => {
    const markup = renderView({
      state: { status: "created", result: RESULT, errorMessage: null },
    });
    expect(markup).toContain(RESULT.filePath);
    expect(markup).toContain("7 redacted");
    expect(markup).toContain("Copy bundle path");
  });

  it("explains itself instead of offering a dead button off the desktop", () => {
    const markup = renderView({ isAvailable: false });
    expect(markup).toContain(SUPPORT_BUNDLE_UNAVAILABLE_MESSAGE);
    expect(markup).toContain("disabled");
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
