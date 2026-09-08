import * as NodeModule from "node:module";

type NativeBindings = Pick<typeof import("ffi-rs"), "open" | "DataType"> & {
  load: (params: Parameters<typeof import("ffi-rs").load>[0]) => unknown;
};

/** Set before Electron's ready event, including Chromium cookie-key lookup.
 * Existing authorized keys remain usable. A locked or untrusted item returns
 * an error instead of opening a system password dialog. Never change its ACL.
 */
export function disableMacKeychainPrompts(
  platform: NodeJS.Platform,
  bindings: () => NativeBindings = () => NodeModule.createRequire(__filename)("ffi-rs"),
): void {
  if (platform !== "darwin") return;
  const ffi = bindings();
  ffi.open({
    library: "workjet-security",
    path: "/System/Library/Frameworks/Security.framework/Security",
  });
  const status = ffi.load({
    library: "workjet-security",
    funcName: "SecKeychainSetUserInteractionAllowed",
    retType: ffi.DataType.I32,
    paramsType: [ffi.DataType.U8],
    paramsValue: [0],
  });
  if (status !== 0) {
    throw new Error(`Could not disable macOS keychain prompts (status ${String(status)}).`);
  }
}
