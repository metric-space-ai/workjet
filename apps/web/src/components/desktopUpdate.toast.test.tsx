import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@workjet/contracts";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.addToast },
}));

import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";

type DownloadedToast = {
  readonly type?: string;
  readonly title?: string;
  readonly description?: unknown;
  readonly actionProps?: { readonly children?: string; readonly onClick?: () => void };
};

function getToast(): DownloadedToast | undefined {
  return testState.addToast.mock.calls[0]?.[0] as DownloadedToast | undefined;
}

function downloadedState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "downloaded",
    channel: "latest",
    currentVersion: "0.0.29",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.30",
    downloadedVersion: "0.0.30",
    releaseNotes: [],
    downloadPercent: 100,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: true,
    ...overrides,
  };
}

describe("showDesktopUpdateDownloadedToast", () => {
  beforeEach(() => {
    testState.addToast.mockReset();
  });

  it("shows one German line with at most one action and no explanatory sentence", () => {
    showDesktopUpdateDownloadedToast({ openExternal: vi.fn() }, downloadedState());
    const toast = getToast();
    expect(toast?.title).toBe("Update 0.0.30 geladen");
    expect(toast?.description).toBeUndefined();
    expect(toast?.actionProps?.children).toBe("Versionshinweise");
  });

  it("opens the downloaded version's release notes", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);

    showDesktopUpdateDownloadedToast({ openExternal }, downloadedState());
    getToast()?.actionProps?.onClick?.();
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/metric-space-ai/workjet/releases/tag/v0.0.30",
      );
    });
    expect(testState.addToast).toHaveBeenCalledTimes(1);
  });

  it("falls back to the version the download was started for", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);

    // The `update-downloaded` event can land after the download RPC resolves.
    showDesktopUpdateDownloadedToast(
      { openExternal },
      downloadedState({ downloadedVersion: null }),
    );
    getToast()?.actionProps?.onClick?.();

    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/metric-space-ai/workjet/releases/tag/v0.0.30",
      );
    });
  });

  it("omits the action when the updater reports no version at all", () => {
    showDesktopUpdateDownloadedToast(
      { openExternal: vi.fn() },
      downloadedState({ availableVersion: null, downloadedVersion: null }),
    );

    expect(getToast()?.title).toBe("Update geladen");
    expect(getToast()?.actionProps).toBeUndefined();
  });

  it.each([
    ["returns false", vi.fn().mockResolvedValue(false)],
    ["rejects", vi.fn().mockRejectedValue(new Error("open failed"))],
  ])("shows an error when opening release notes %s", async (_description, openExternal) => {
    showDesktopUpdateDownloadedToast({ openExternal }, downloadedState());
    getToast()?.actionProps?.onClick?.();

    await vi.waitFor(() => {
      expect(testState.addToast).toHaveBeenLastCalledWith({
        type: "error",
        title: "Versionshinweise nicht geöffnet",
      });
    });
  });
});
