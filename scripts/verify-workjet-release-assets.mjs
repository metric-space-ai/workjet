#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { selectReleaseTargets } from "./lib/workjet-release-targets.mjs";

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

const targetFlag = process.argv.indexOf("--targets");
const selection = targetFlag < 0 ? undefined : process.argv[targetFlag + 1];
if (targetFlag >= 0 && !selection) throw new Error("--targets requires a value");
const targets = selectReleaseTargets(selection);
const expected = new Set(targets.map(([platform, arch]) => `${platform}/${arch}`));
const seen = new Set();
for (const artifact of manifest.artifacts || []) {
  const name = `${artifact.platform}/${artifact.arch}`;
  if (!expected.has(name) || seen.has(name))
    throw new Error(`Unexpected or duplicate target: ${name}`);
  seen.add(name);
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
const missing = [...expected].filter((name) => !seen.has(name));
if (missing.length) throw new Error(`Missing release targets: ${missing.join(", ")}`);
// The scoped public draft ships both macOS formats and both Linux formats.
// A primary installer alone must not satisfy this requested release surface.
if (selection !== undefined) {
  for (const [platform, arch] of targets) {
    const suffix = platform === "macos" ? ".zip" : platform === "linux" ? ".deb" : undefined;
    if (!suffix) continue;
    const prefix = `Workjet-${manifest.appVersion}-${arch}`;
    const matching = files.filter((file) => file.startsWith(prefix) && file.endsWith(suffix));
    if (matching.length !== 1) throw new Error(`Expected one ${prefix}*${suffix}`);
    if ((await NodeFSP.stat(NodePath.join(assetsDir, matching[0]))).size === 0) {
      throw new Error(`Empty release asset: ${matching[0]}`);
    }
  }
}
if (!files.some((file) => /\.(?:yml|yaml)$/i.test(file))) {
  throw new Error("Updater metadata is missing.");
}

console.log(
  `Verified Workjet release surface: ${manifest.artifacts.length} installers, byte hashes, sizes, manifest and updater metadata.`,
);
