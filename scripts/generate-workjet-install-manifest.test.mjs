import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateWorkjetInstallManifest } from "./generate-workjet-install-manifest.mjs";

test("generates the complete signed-release target matrix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workjet-install-manifest-"));
  try {
    for (const name of [
      "Workjet-1.2.3-arm64.dmg",
      "Workjet-1.2.3-x64.dmg",
      "Workjet-1.2.3-arm64.AppImage",
      "Workjet-1.2.3-x64.AppImage",
      "Workjet-1.2.3-x64.exe",
    ])
      await writeFile(path.join(root, name), name);
    const output = path.join(root, "manifest.json");
    const manifest = await generateWorkjetInstallManifest({
      assetsDir: root,
      tag: "v1.2.3",
      version: "1.2.3",
      repository: "metric-space-ai/workjet",
      output,
    });
    assert.equal(manifest.productName, "Workjet");
    assert.equal(manifest.artifacts.length, 5);
    assert.deepEqual(
      manifest.artifacts.map(({ platform, arch }) => `${platform}/${arch}`),
      ["macos/arm64", "macos/x64", "linux/arm64", "linux/x64", "windows/x64"],
    );
    assert.ok(manifest.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
