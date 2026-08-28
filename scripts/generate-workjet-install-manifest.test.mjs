import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { generateWorkjetInstallManifest } from "./generate-workjet-install-manifest.mjs";

NodeTest.test("generates the complete signed-release target matrix", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-install-manifest-"));
  try {
    for (const name of [
      "Workjet-1.2.3-arm64.dmg",
      "Workjet-1.2.3-x64.dmg",
      "Workjet-1.2.3-arm64.AppImage",
      "Workjet-1.2.3-x64.AppImage",
      "Workjet-1.2.3-x64.exe",
    ])
      await NodeFSP.writeFile(NodePath.join(root, name), name);
    const output = NodePath.join(root, "manifest.json");
    const manifest = await generateWorkjetInstallManifest({
      assetsDir: root,
      tag: "v1.2.3",
      version: "1.2.3",
      repository: "metric-space-ai/workjet",
      output,
    });
    NodeAssert.equal(manifest.productName, "Workjet");
    NodeAssert.equal(manifest.artifacts.length, 5);
    NodeAssert.deepEqual(
      manifest.artifacts.map(({ platform, arch }) => `${platform}/${arch}`),
      ["macos/arm64", "macos/x64", "linux/arm64", "linux/x64", "windows/x64"],
    );
    NodeAssert.ok(manifest.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
