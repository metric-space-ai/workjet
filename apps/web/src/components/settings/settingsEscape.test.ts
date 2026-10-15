import { describe, expect, it } from "vite-plus/test";
import { collapseExpandedSettingsRow } from "./settingsEscape";

function fakeToggle(insideExcluded = false) {
  const toggle = {
    clicks: 0,
    closest: () => (insideExcluded ? {} : null),
    click() {
      toggle.clicks += 1;
    },
  };
  return toggle;
}

function fakeRoot(toggles: ReturnType<typeof fakeToggle>[]) {
  return { querySelectorAll: () => toggles } as unknown as ParentNode;
}

describe("collapseExpandedSettingsRow", () => {
  it("collapses the last expanded row so Esc does not leave Einstellungen", () => {
    const first = fakeToggle();
    const last = fakeToggle();
    expect(collapseExpandedSettingsRow(fakeRoot([first, last]))).toBe(true);
    expect(last.clicks).toBe(1);
    expect(first.clicks).toBe(0);
  });

  it("reports nothing open when only sidebar or menu toggles are expanded", () => {
    const sidebar = fakeToggle(true);
    expect(collapseExpandedSettingsRow(fakeRoot([sidebar]))).toBe(false);
    expect(sidebar.clicks).toBe(0);
    expect(collapseExpandedSettingsRow(fakeRoot([]))).toBe(false);
  });
});
