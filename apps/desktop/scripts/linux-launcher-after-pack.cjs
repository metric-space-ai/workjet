"use strict";
// electron-builder afterPack hook for Linux packages.
//
// Moves the Electron binary from "<executable>" to "<executable>-bin" and puts
// linux-launcher.sh in its place. Every Linux entry point (.desktop Exec,
// /usr/bin/<executable> via update-alternatives, AppImage AppRun) keeps
// pointing at "<executable>", so they all go through the launcher, which only
// drops the Chromium sandbox where Linux cannot provide one (see the script).
//
// Runs before electron-builder's fuse flipping: if electronFuses is ever
// configured, the fuses must target "<executable>-bin", not the launcher.
const NodeFS = require("node:fs");
const NodePath = require("node:path");

const LINUX_ELECTRON_BINARY_SUFFIX = "-bin";
const LAUNCHER_SOURCE_PATH = NodePath.join(__dirname, "linux-launcher.sh");

function installLinuxLauncher(appOutDir, executableName) {
  const launcherPath = NodePath.join(appOutDir, executableName);
  const electronPath = `${launcherPath}${LINUX_ELECTRON_BINARY_SUFFIX}`;
  if (NodeFS.existsSync(electronPath)) {
    throw new Error(`Linux launcher already installed: ${electronPath} exists`);
  }
  NodeFS.renameSync(launcherPath, electronPath);
  NodeFS.copyFileSync(LAUNCHER_SOURCE_PATH, launcherPath);
  NodeFS.chmodSync(launcherPath, 0o755);
  return { launcherPath, electronPath };
}

async function afterPack(context) {
  if (context.electronPlatformName !== "linux") {
    return;
  }
  installLinuxLauncher(context.appOutDir, context.packager.executableName);
}

module.exports = { afterPack, installLinuxLauncher, LINUX_ELECTRON_BINARY_SUFFIX };
