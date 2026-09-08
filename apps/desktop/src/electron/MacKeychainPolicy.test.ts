import { describe, expect, it, vi } from "vite-plus/test";
import { DataType } from "ffi-rs";
import { disableMacKeychainPrompts } from "./MacKeychainPolicy.ts";

describe("macOS keychain interaction policy", () => {
  it("disables interaction without reading a secret or changing item permissions", () => {
    const open = vi.fn();
    const load = vi.fn(() => 0);
    disableMacKeychainPrompts("darwin", () => ({ open, load, DataType }));
    expect(open).toHaveBeenCalledWith({
      library: "workjet-security",
      path: "/System/Library/Frameworks/Security.framework/Security",
    });
    expect(load).toHaveBeenCalledExactlyOnceWith({
      library: "workjet-security",
      funcName: "SecKeychainSetUserInteractionAllowed",
      retType: DataType.I32,
      paramsType: [DataType.U8],
      paramsValue: [0],
    });
  });
  it("does not load a native binding on other operating systems", () => {
    const bindings = vi.fn();
    disableMacKeychainPrompts("linux", bindings);
    disableMacKeychainPrompts("win32", bindings);
    expect(bindings).not.toHaveBeenCalled();
  });
  it("refuses to proceed if the system cannot enforce the no-dialog policy", () => {
    expect(() =>
      disableMacKeychainPrompts("darwin", () => ({
        open: vi.fn(),
        load: vi.fn(() => -50),
        DataType,
      })),
    ).toThrow("status -50");
  });
});
