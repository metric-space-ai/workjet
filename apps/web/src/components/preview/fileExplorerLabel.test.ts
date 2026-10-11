import { describe, expect, it } from "vite-plus/test";

import { revealInFileExplorerLabel } from "./fileExplorerLabel";

describe("revealInFileExplorerLabel", () => {
  it.each([
    ["MacIntel", "Im Finder zeigen"],
    ["Win32", "Im Explorer zeigen"],
    ["Linux x86_64", "In Dateien zeigen"],
  ])("maps %s to %s", (platform, expected) => {
    expect(revealInFileExplorerLabel(platform)).toBe(expected);
  });
});
