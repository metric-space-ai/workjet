import { DEFAULT_WORKJET_THREAD_CONFIG, type WorkjetThreadConfig } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { ThreadRightPanelState } from "./rightPanelStore";
import {
  visibleWorkjetRightPanelState,
  workjetBrowserSurfaceEnabled,
} from "./workjetSurfaceVisibility";

const enabled: WorkjetThreadConfig = {
  ...DEFAULT_WORKJET_THREAD_CONFIG,
  enabledCapabilityIds: ["web-stack-browser"],
};
const disabled: WorkjetThreadConfig = { ...enabled, enabledCapabilityIds: [] };

const panel: ThreadRightPanelState = {
  isOpen: true,
  activeSurfaceId: "browser:private",
  surfaces: [
    { id: "browser:private", kind: "preview", resourceId: "private" },
    { id: "files", kind: "files" },
  ],
};

describe("Workjet browser capability", () => {
  it("uses the current draft's configuration before thread creation", () => {
    expect(
      workjetBrowserSurfaceEnabled({
        isServerThread: false,
        serverConfig: null,
        draftConfig: enabled,
      }),
    ).toBe(true);
    expect(
      workjetBrowserSurfaceEnabled({
        isServerThread: false,
        serverConfig: enabled,
        draftConfig: disabled,
      }),
    ).toBe(false);
  });

  it("does not let a stale composer draft override the server thread", () => {
    expect(
      workjetBrowserSurfaceEnabled({
        isServerThread: true,
        serverConfig: disabled,
        draftConfig: enabled,
      }),
    ).toBe(false);
    expect(
      workjetBrowserSurfaceEnabled({
        isServerThread: true,
        serverConfig: enabled,
        draftConfig: disabled,
      }),
    ).toBe(true);
    expect(
      workjetBrowserSurfaceEnabled({
        isServerThread: true,
        serverConfig: null,
        draftConfig: enabled,
      }),
    ).toBe(false);
  });

  it("uses safe defaults for absent drafts and rejects a restored child-worker role", () => {
    expect(
      workjetBrowserSurfaceEnabled({
        isServerThread: false,
        serverConfig: null,
        draftConfig: null,
      }),
    ).toBe(false);
    expect(
      workjetBrowserSurfaceEnabled({
        isServerThread: false,
        serverConfig: null,
        draftConfig: { ...enabled, role: "worker" },
      }),
    ).toBe(false);
  });
});

describe("Workjet right panel visibility", () => {
  it("hides stored Browser tabs and selects a visible fallback without mutating history", () => {
    const filtered = visibleWorkjetRightPanelState(panel, false);
    expect(filtered.surfaces).toEqual([{ id: "files", kind: "files" }]);
    expect(filtered.activeSurfaceId).toBe("files");
    expect(filtered.isOpen).toBe(true);
    expect(panel.activeSurfaceId).toBe("browser:private");
    expect(panel.surfaces).toHaveLength(2);
    expect(visibleWorkjetRightPanelState(panel, true)).toBe(panel);
  });

  it("shows the launcher when the only stored tab is disabled", () => {
    const filtered = visibleWorkjetRightPanelState(
      { ...panel, surfaces: [panel.surfaces[0]!] },
      false,
    );
    expect(filtered.activeSurfaceId).toBeNull();
    expect(filtered.surfaces).toEqual([]);
  });

  it("keeps deliberate launcher selection and closed panels intact", () => {
    const launcher = visibleWorkjetRightPanelState({ ...panel, activeSurfaceId: null }, false);
    expect(launcher.activeSurfaceId).toBeNull();
    expect(visibleWorkjetRightPanelState({ ...panel, isOpen: false }, false).isOpen).toBe(false);
  });

  it("does not remove other work surfaces", () => {
    const filesOnly: ThreadRightPanelState = {
      ...panel,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
    };
    expect(visibleWorkjetRightPanelState(filesOnly, false)).toBe(filesOnly);
  });
});
