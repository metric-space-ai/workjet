#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const assetsDir = process.argv[2] || "release-assets";
const files = await NodeFSP.readdir(assetsDir);
const manifestName = "workjet-desktop-install-manifest-v1.json";
if (!files.includes(manifestName)) throw new Error("Workjet install manifest is missing.");

const manifest = JSON.parse(await NodeFSP.readFile(NodePath.join(assetsDir, manifestName), "utf8"));
if (manifest.schema !== "workjet.desktop-install-manifest.v1") {
  throw new Error("Unexpected Workjet install manifest schema.");
}
if (!["stable", "nightly"].includes(manifest.channel)) {
  throw new Error("Release channel must be stable or nightly.");
}

const expected = new Set(["macos/arm64", "macos/x64", "windows/x64", "linux/x64", "linux/arm64"]);
for (const artifact of manifest.artifacts || []) {
  expected.delete(`${artifact.platform}/${artifact.arch}`);
  if (!artifact.filename || !files.includes(artifact.filename)) {
    throw new Error(`Installer is missing: ${artifact.filename || "unnamed"}`);
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256 || "")) {
    throw new Error(`Invalid checksum for ${artifact.filename}`);
  }
  const artifactPath = NodePath.join(assetsDir, artifact.filename);
  const bytes = await NodeFSP.readFile(artifactPath);
  const actualHash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== artifact.sha256) {
    throw new Error(`Checksum mismatch for ${artifact.filename}`);
  }
  const artifactStat = await NodeFSP.stat(artifactPath);
  if (artifactStat.size !== artifact.size) {
    throw new Error(`Size mismatch for ${artifact.filename}`);
  }
  if (
    !String(artifact.url || "").includes("github.com/metric-space-ai/workjet/releases/download/")
  ) {
    throw new Error(`Invalid release URL for ${artifact.filename}`);
  }
}
if (expected.size) throw new Error(`Missing release targets: ${[...expected].join(", ")}`);
if (!files.some((file) => /\.(?:yml|yaml)$/i.test(file))) {
  throw new Error("Updater metadata is missing.");
}

console.log(
  `Verified Workjet release surface: ${manifest.artifacts.length} installers, byte hashes, sizes, manifest and updater metadata.`,
);
