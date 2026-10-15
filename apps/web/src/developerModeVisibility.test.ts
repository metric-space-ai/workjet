import { describe, expect, it } from "vite-plus/test";

import type { ThreadRightPanelState } from "./rightPanelStore";
import {
  isCodingRightPanelKind,
  isCodingToolCommand,
  visibleDeveloperRightPanelState,
} from "./developerModeVisibility";

const panel: ThreadRightPanelState = {
  isOpen: true,
  activeSurfaceId: "diff",
  surfaces: [
    { id: "diff", kind: "diff" },
    { id: "files", kind: "files" },
    { id: "agents", kind: "agents" },
  ],
};

describe("coding tools without developer mode (#557)", () => {
  it("hides terminal, diff and pull request surfaces and keeps the rest", () => {
    const visible = visibleDeveloperRightPanelState(panel, false);
    expect(visible.surfaces.map((surface) => surface.kind)).toEqual(["files", "agents"]);
    expect(visible.activeSurfaceId).toBe("files");
    expect(visible.isOpen).toBe(true);
  });

  it("returns the stored state unchanged in developer mode", () => {
    expect(visibleDeveloperRightPanelState(panel, true)).toBe(panel);
    const plain = { ...panel, surfaces: [{ id: "files" as const, kind: "files" as const }] };
    expect(visibleDeveloperRightPanelState(plain, false)).toBe(plain);
  });

  it("classifies surfaces and shortcuts", () => {
    expect(isCodingRightPanelKind("terminal")).toBe(true);
    expect(isCodingRightPanelKind("diff")).toBe(true);
    expect(isCodingRightPanelKind("pull-request")).toBe(true);
    expect(isCodingRightPanelKind("files")).toBe(false);
    expect(isCodingRightPanelKind("preview")).toBe(false);
    expect(isCodingToolCommand("terminal.toggle")).toBe(true);
    expect(isCodingToolCommand("terminal.new")).toBe(true);
    expect(isCodingToolCommand("diff.toggle")).toBe(true);
    expect(isCodingToolCommand("rightPanel.toggle")).toBe(false);
    expect(isCodingToolCommand("modelPicker.toggle")).toBe(false);
  });
});
