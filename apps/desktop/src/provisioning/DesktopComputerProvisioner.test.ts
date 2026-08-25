import { describe, expect, it } from "vite-plus/test";

import { testing } from "./DesktopComputerProvisioner.ts";

describe("DesktopComputerProvisioner helpers", () => {
  it("normalizes only the supported release platforms and architectures", () => {
    expect(testing.normalizePlatform("Darwin")).toBe("macos");
    expect(testing.normalizePlatform("linux")).toBe("linux");
    expect(testing.normalizePlatform("windows")).toBe("windows");
    expect(testing.normalizePlatform("freebsd")).toBeNull();
    expect(testing.normalizeArchitecture("aarch64")).toBe("arm64");
    expect(testing.normalizeArchitecture("AMD64")).toBe("x64");
    expect(testing.normalizeArchitecture("i686")).toBeNull();
  });

  it("parses bounded preflight key/value output without treating later equals as separators", () => {
    const values = testing.parseKeyValueOutput(
      "platform=Linux\narch=x86_64\nworkjet_version=1.2.3=stable\ninvalid\n",
    );
    expect(Object.fromEntries(values)).toEqual({
      platform: "Linux",
      arch: "x86_64",
      workjet_version: "1.2.3=stable",
    });
  });
});
