import { describe, expect, it } from "vite-plus/test";

import {
  checkForAppUpdateOnLaunch,
  isAppUpdateCheckAvailable,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
} from "./app-updates";

describe("binary-only app updates", () => {
  it("does not expose or activate an OTA update path", async () => {
    expect(isAppUpdateCheckAvailable()).toBe(false);
    expect(registerHiddenUpdateTap(4)).toEqual({ nextCount: 5, shouldCheck: false });
    await expect(runAppUpdateCheck()).resolves.toBeUndefined();
    await expect(checkForAppUpdateOnLaunch()).resolves.toBeUndefined();
  });
});
