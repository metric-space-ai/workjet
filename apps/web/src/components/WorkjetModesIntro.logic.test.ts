import { describe, expect, it } from "vite-plus/test";

import { resolveWorkjetModesIntroOpen } from "./WorkjetModesIntro.logic";

describe("resolveWorkjetModesIntroOpen", () => {
  it("opens once on the desktop shell after settings hydrate", () => {
    expect(
      resolveWorkjetModesIntroOpen({ isElectron: true, settingsHydrated: true, seen: false }),
    ).toBe(true);
  });

  it("stays closed once the introduction was dismissed", () => {
    expect(
      resolveWorkjetModesIntroOpen({ isElectron: true, settingsHydrated: true, seen: true }),
    ).toBe(false);
  });

  it("waits for persisted settings so a seen flag is not overridden by the default", () => {
    expect(
      resolveWorkjetModesIntroOpen({ isElectron: true, settingsHydrated: false, seen: false }),
    ).toBe(false);
  });

  it("never opens in a browser, where the Ops mode is not available", () => {
    expect(
      resolveWorkjetModesIntroOpen({ isElectron: false, settingsHydrated: true, seen: false }),
    ).toBe(false);
  });
  it("does not interrupt an upgraded profile with existing projects or imported chats", () => {
    expect(
      resolveWorkjetModesIntroOpen({
        isElectron: true,
        settingsHydrated: true,
        seen: false,
        workspaceHydrated: true,
        hasExistingWork: true,
      }),
    ).toBe(false);
  });
  it("waits for workspace hydration before treating a profile as new", () => {
    expect(
      resolveWorkjetModesIntroOpen({
        isElectron: true,
        settingsHydrated: true,
        seen: false,
        workspaceHydrated: false,
        hasExistingWork: false,
      }),
    ).toBe(false);
  });
});
