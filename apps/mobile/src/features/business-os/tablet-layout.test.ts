import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const panel = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "components/BusinessOsSettingsPanel.tsx"),
  "utf8",
);

describe("Business OS tablet layout", () => {
  it.each([
    { width: 768, height: 1024, ratio: "3:4" },
    { width: 1024, height: 768, ratio: "4:3" },
  ])("uses the bounded two-column layout at $ratio", ({ width }) => {
    expect(width).toBeGreaterThanOrEqual(720);
    expect(panel).toContain("width >= 720");
    expect(panel).toContain('tabletLayout && "flex-row items-start"');
    expect(panel).toContain("max-w-[920px]");
  });
});
