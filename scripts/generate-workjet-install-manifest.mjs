#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

export const WORKJET_INSTALL_MANIFEST_SCHEMA = "workjet.desktop-install-manifest.v1";

export const WORKJET_DESKTOP_INSTALL_IDENTITY = Object.freeze({
  appId: "dev.workjet.desktop",
  deepLinkSchemes: ["workjet"],
  macosInstallPath: "/Applications/Workjet.app",
  updateCompatibleAppIds: ["dev.workjet.desktop"],
  replacesByInstallPath: {
    appId: "dev.workjet.menubar",
    updateCompatible: false,
    mustBeStoppedBeforeInstall: true,
  },
  profileMigration: {
    mode: "offline-copy-on-first-launch",
    sourceUserDataDirName: "CTOX Desktop App",
    targetUserDataDirName: "Workjet",
    sourceIsRuntimeFallback: false,
  },
});

const TARGETS = [
  ["macos", "arm64", ".dmg"],
  ["macos", "x64", ".dmg"],
  ["linux", "arm64", ".AppImage"],
  ["linux", "x64", ".AppImage"],
  ["windows", "x64", ".exe"],
];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [key, inline] = token.split("=", 2);
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    values.set(key, value);
  }
  return values;
}

async function sha256(filePath) {
  return NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(filePath))
    .digest("hex");
}

function findUniqueArtifact(files, version, arch, suffix) {
  const prefix = `Workjet-${version}-${arch}`;
  const matches = files.filter((name) => name.startsWith(prefix) && name.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${prefix}*${suffix} artifact, found ${matches.length}`);
  }
  return matches[0];
}

export async function generateWorkjetInstallManifest({
  assetsDir,
  tag,
  version,
  repository,
  output,
}) {
  if (!assetsDir || !tag || !version || !repository || !output) {
    throw new Error("assetsDir, tag, version, repository and output are required");
  }
  const files = await NodeFSP.readdir(assetsDir);
  const releaseBase = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
  const artifacts = [];
  for (const [platform, arch, suffix] of TARGETS) {
    const filename = findUniqueArtifact(files, version, arch, suffix);
    const filePath = NodePath.join(assetsDir, filename);
    const stat = await import("node:fs/promises").then(({ stat }) => stat(filePath));
    artifacts.push({
      platform,
      arch,
      filename,
      url: `${releaseBase}/${encodeURIComponent(filename)}`,
      size: stat.size,
      sha256: await sha256(filePath),
      installKind: platform === "macos" ? "dmg" : platform === "linux" ? "appimage" : "nsis",
      graphicalSessionRequired: true,
    });
  }
  const manifest = {
    schema: WORKJET_INSTALL_MANIFEST_SCHEMA,
    version: 1,
    release: tag,
    appVersion: version,
    channel: tag.includes("nightly") ? "nightly" : "stable",
    repository,
    productName: "Workjet",
    identity: WORKJET_DESKTOP_INSTALL_IDENTITY,
    artifacts,
  };
  await NodeFSP.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (
  NodeProcess.argv[1] &&
  NodePath.resolve(NodeProcess.argv[1]) === NodePath.resolve(new URL(import.meta.url).pathname)
) {
  const args = parseArgs(NodeProcess.argv.slice(2));
  await generateWorkjetInstallManifest({
    assetsDir: args.get("--assets-dir"),
    tag: args.get("--tag"),
    version: args.get("--version"),
    repository: args.get("--repository"),
    output: args.get("--output"),
  });
}
