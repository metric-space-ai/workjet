// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the shipped CSS blur rule with the privacy selector lists.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  PRIVACY_REVEAL_SELECTORS,
  PRIVACY_SENSITIVE_SELECTORS,
  isPrivacyModeShortcut,
  privacyModeLabels,
} from "./privacyMode";

const key = (overrides: Partial<KeyboardEvent>) =>
  ({
    key: "B",
    code: "KeyB",
    shiftKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...overrides,
  }) as KeyboardEvent;

describe("privacy mode", () => {
  it("toggles with Cmd+Shift+B on macOS and Ctrl+Shift+B elsewhere", () => {
    expect(isPrivacyModeShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isPrivacyModeShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isPrivacyModeShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isPrivacyModeShortcut(key({ metaKey: true, shiftKey: false }), true)).toBe(false);
    expect(isPrivacyModeShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });

  it("labels the toggle in German and English", () => {
    expect(privacyModeLabels("de").enable).toBe("Privacy-Modus einschalten");
    expect(privacyModeLabels("en").disable).toBe("Turn off privacy mode");
  });

  it("keeps the CSS blur rule in sync with the TypeScript selector lists", () => {
    const css = NodeFS.readFileSync(new URL("./index.css", import.meta.url), "utf8").replace(
      /\s+/g,
      " ",
    );
    const rule = css.slice(css.indexOf(':root[data-privacy-mode="on"]'));
    for (const selector of [...PRIVACY_SENSITIVE_SELECTORS, ...PRIVACY_REVEAL_SELECTORS])
      expect(rule).toContain(selector);
    expect(rule).toContain("filter: blur(6px)");
    expect(rule).not.toContain(":hover");
  });
});
