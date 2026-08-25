import { describe, expect, it } from "vite-plus/test";

import { resolveWorkjetMode, workjetModeLabel } from "./workjet-mode";

describe("Workjet mode", () => {
  it("keeps Coding as the safe default for existing installations", () => {
    expect(resolveWorkjetMode(undefined)).toBe("code");
    expect(resolveWorkjetMode("unknown")).toBe("code");
  });

  it("restores the persisted Business OS choice", () => {
    expect(resolveWorkjetMode("business_os")).toBe("business_os");
    expect(workjetModeLabel("business_os")).toBe("Business OS");
  });
});
