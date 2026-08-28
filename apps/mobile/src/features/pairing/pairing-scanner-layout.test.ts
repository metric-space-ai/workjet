import { describe, expect, it } from "vite-plus/test";

import { pairingScannerSize } from "./pairing-scanner-layout";

describe("Workjet pairing scanner layout", () => {
  it.each([
    [375, 812, 335],
    [812, 375, 160],
    [768, 1024, 360],
    [1024, 768, 322],
    [900, 1200, 360],
    [1200, 900, 360],
  ])("keeps the scanner compact at %sx%s", (width, height, expected) => {
    expect(pairingScannerSize({ width, height })).toBe(expected);
  });

  it("never expands into a full-width tablet camera surface", () => {
    expect(pairingScannerSize({ width: 1366, height: 1024 })).toBe(360);
  });
});
