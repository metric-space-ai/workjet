import { assert, describe, it } from "vite-plus/test";

import {
  DEVELOPMENT_MAC_ICON_PATH,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveLauncherDisplayName,
  resolveMacLauncherPaths,
} from "./electron-launcher.mjs";

describe("electron development launcher", () => {
  it("uses the Workjet display name and existing Dock artwork", () => {
    assert.equal(resolveLauncherDisplayName(true), "Workjet");
    assert.equal(resolveLauncherDisplayName(false), "Workjet");
    assert.match(DEVELOPMENT_MAC_ICON_PATH, /assets\/ctox\/ctox-app-icon\.png$/);
  });

  it("uses captured values only as fallbacks for a live runner environment", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
        T3CODE_PORT: "16566",
        T3CODE_HOME: "/tmp/t3",
      },
    });

    assert.include(
      script,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.notInclude(script, "\nexport VITE_DEV_SERVER_URL=");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --t3code-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/Workjet.app",
      "Workjet",
    );

    assert.equal(paths.launcherExecutableName, "Workjet Launcher");
    assert.equal(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/Workjet.app/Contents/MacOS/Workjet Launcher",
    );
    assert.equal(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/Workjet.app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {},
    });
    assert.include(
      script,
      "exec '/repo/apps/desktop/.electron-runtime/Workjet.app/Contents/MacOS/Electron'",
    );
    assert.notInclude(script, "node_modules/electron");
  });
});
