import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import {
  resolveResourceMonitorStagePaths,
  resourceMonitorExecutableName,
  stageResourceMonitor,
} from "./stage-resource-monitor.mjs";

describe("desktop resource monitor staging", () => {
  it("uses the platform executable name", () => {
    assert.equal(resourceMonitorExecutableName("darwin"), "t3-resource-monitor");
    assert.equal(resourceMonitorExecutableName("linux"), "t3-resource-monitor");
    assert.equal(resourceMonitorExecutableName("win32"), "t3-resource-monitor.exe");
  });

  it("builds and stages the native monitor for direct desktop packs", () => {
    const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-monitor-stage-"));
    const paths = resolveResourceMonitorStagePaths({ repoRoot, platform: "darwin" });
    let receivedBuildInput;

    try {
      const stagedBinaryPath = stageResourceMonitor({
        repoRoot,
        platform: "darwin",
        build: (input) => {
          receivedBuildInput = input;
          NodeFS.mkdirSync(NodePath.dirname(paths.builtBinaryPath), { recursive: true });
          NodeFS.writeFileSync(paths.builtBinaryPath, "native-monitor");
        },
      });

      assert.deepEqual(receivedBuildInput, {
        repoRoot,
        manifestPath: paths.manifestPath,
      });
      assert.equal(stagedBinaryPath, paths.stagedBinaryPath);
      assert.equal(NodeFS.readFileSync(stagedBinaryPath, "utf8"), "native-monitor");
      assert.notEqual(NodeFS.statSync(stagedBinaryPath).mode & 0o111, 0);
    } finally {
      NodeFS.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails when cargo reports success without producing the binary", () => {
    const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-monitor-stage-"));
    const paths = resolveResourceMonitorStagePaths({ repoRoot, platform: "darwin" });

    try {
      assert.throws(
        () => stageResourceMonitor({ repoRoot, platform: "darwin", build: () => undefined }),
        new RegExp(`Resource monitor build did not produce ${paths.builtBinaryPath}`),
      );
    } finally {
      NodeFS.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
