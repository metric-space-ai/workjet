import { describe, expect, it } from "vite-plus/test";

import { resolveWorkjetProductMode } from "./workjetProductMode";

describe("resolveWorkjetProductMode", () => {
  it.each(["code", "ctox"] as const)("resolves Electron mode %s", (configuredMode) => {
    expect(resolveWorkjetProductMode({ configuredMode, isElectron: true })).toBe(configuredMode);
  });

  it("keeps every non-Electron surface in Code mode", () => {
    expect(resolveWorkjetProductMode({ configuredMode: "ctox", isElectron: false })).toBe("code");
  });

  it.each([undefined, null, "guest", "CTOX", 1, {}])(
    "fails closed for malformed externally seeded mode %s",
    (configuredMode) => {
      expect(resolveWorkjetProductMode({ configuredMode, isElectron: true })).toBe("code");
      expect(resolveWorkjetProductMode({ configuredMode, isElectron: false })).toBe("code");
    },
  );
});
