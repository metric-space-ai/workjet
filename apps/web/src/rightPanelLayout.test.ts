import { describe, expect, it } from "vite-plus/test";

import {
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
  RIGHT_PANEL_SHEET_CLASS_NAME,
} from "./rightPanelLayout";

describe("right panel responsive layout", () => {
  it("uses a full-width sheet at the same breakpoint that disables the inline panel", () => {
    expect(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).toBe("(max-width: 980px)");
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toContain("max-[980px]:w-full");
    expect(RIGHT_PANEL_SHEET_CLASS_NAME).toContain("max-[980px]:max-w-none");
  });
});
