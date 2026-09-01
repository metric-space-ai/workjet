import { describe, expect, it } from "vitest";

import { resolveDesktopProfileHome } from "./DesktopTestProfile.ts";

describe("resolveDesktopProfileHome", () => {
  it("uses an isolated profile root for an unpackaged UI test launch", () => {
    expect(
      resolveDesktopProfileHome({
        argv: ["electron", "main.cjs", "--workjet-ui-test-profile-root=/tmp/workjet-ui-profile"],
        defaultHomeDirectory: "/Users/operator",
        isPackaged: false,
      }),
    ).toBe("/tmp/workjet-ui-profile");
  });

  it("ignores the test switch in packaged builds", () => {
    expect(
      resolveDesktopProfileHome({
        argv: ["Workjet", "--workjet-ui-test-profile-root=/tmp/workjet-ui-profile"],
        defaultHomeDirectory: "/Users/operator",
        isPackaged: true,
      }),
    ).toBe("/Users/operator");
  });

  it("rejects relative test profile roots", () => {
    expect(() =>
      resolveDesktopProfileHome({
        argv: ["electron", "main.cjs", "--workjet-ui-test-profile-root=relative-profile"],
        defaultHomeDirectory: "/Users/operator",
        isPackaged: false,
      }),
    ).toThrow("must be an absolute path");
  });
});
