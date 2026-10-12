import { describe, expect, it } from "vite-plus/test";

import { formatVersionChipLabel } from "./VersionChip";

describe("formatVersionChipLabel", () => {
  it("shows the full version line with the instance build as a short SHA", () => {
    expect(formatVersionChipLabel("0.0.85", "0.1.3", "welsch", "5a8db7e28c0f513eb")).toBe(
      "Workjet 0.0.85 · Host 0.1.3 · welsch 5a8db7e",
    );
  });

  it("leaves out unknown parts instead of showing dashes", () => {
    expect(formatVersionChipLabel("0.0.85", null, "welsch")).toBe("Workjet 0.0.85 · welsch");
    expect(formatVersionChipLabel("0.0.85", "0.1.3", null)).toBe("Workjet 0.0.85 · Host 0.1.3");
  });
});
