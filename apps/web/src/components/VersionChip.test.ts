import { describe, expect, it } from "vite-plus/test";

import { formatVersionChipLabel } from "./VersionChip";

describe("formatVersionChipLabel", () => {
  it("shows the full version line with the instance build as a short SHA", () => {
    expect(formatVersionChipLabel("0.0.85", "0.1.3", "welsch", "5a8db7e28c0f513eb")).toBe(
      "Workjet 0.0.85 · Host 0.1.3 · welsch 5a8db7e",
    );
  });

  it("shows a dash for missing values", () => {
    expect(formatVersionChipLabel("0.0.85", null, "welsch")).toBe(
      "Workjet 0.0.85 · Host — · welsch —",
    );
    expect(formatVersionChipLabel("0.0.85", "0.1.3", null)).toBe("Workjet 0.0.85 · Host 0.1.3");
  });
});
