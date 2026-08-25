import { describe, expect, it } from "vite-plus/test";

import { STANDARD_THEME_CARDS } from "./ThemePreviewCircles";

describe("STANDARD_THEME_CARDS", () => {
  it("uses the Workjet product name for the built-in application theme", () => {
    expect(STANDARD_THEME_CARDS).toEqual([
      expect.objectContaining({
        id: "default",
        label: "Workjet",
      }),
    ]);
  });
});
