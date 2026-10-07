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
    assert.equal(resourceMonitorExecutableName("darwin"), "workjet-resource-monitor");
    assert.equal(resourceMonitorExecutableName("linux"), "workjet-resource-monitor");
    assert.equal(resourceMonitorExecutableName("win32"), "workjet-resource-monitor.exe");
  });

  it("builds and stages the native monitor for direct desktop packs", () => {
    const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-monitor-stage-"));
    const paths = resolveResourceMonitorStagePaths({ repoRoot, platform: "darwin" });
    let receivedBuildInput;

    try {
      const stagedBinaryPath = stageResourceMonitor({
        repoRoot,
        platform: "darwin",
        targetDirectory: paths.targetDirectory,
        build: (input) => {
          receivedBuildInput = input;
          NodeFS.mkdirSync(NodePath.dirname(paths.builtBinaryPath), { recursive: true });
          NodeFS.writeFileSync(paths.builtBinaryPath, "native-monitor");
        },
      });

      assert.deepEqual(receivedBuildInput, {
        repoRoot,
        manifestPath: paths.manifestPath,
        targetDirectory: paths.targetDirectory,
      });
      assert.equal(stagedBinaryPath, paths.stagedBinaryPath);
      assert.equal(NodeFS.readFileSync(stagedBinaryPath, "utf8"), "native-monitor");
      assert.notEqual(NodeFS.statSync(stagedBinaryPath).mode & 0o111, 0);
    } finally {
      NodeFS.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails when cargo reports success without producing the binary", () => {
    const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-monitor-stage-"));
    const paths = resolveResourceMonitorStagePaths({ repoRoot, platform: "darwin" });

    try {
      assert.throws(
        () =>
          stageResourceMonitor({
            repoRoot,
            platform: "darwin",
            targetDirectory: paths.targetDirectory,
            build: () => undefined,
          }),
        new RegExp(`Resource monitor build did not produce ${paths.builtBinaryPath}`),
      );
    } finally {
      NodeFS.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
  it("stages from the configured Cargo cache rather than the default target directory", () => {
    const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-monitor-cache-"));
    const targetDirectory = NodePath.join(repoRoot, "external-cache", "monitor");
    const paths = resolveResourceMonitorStagePaths({
      repoRoot,
      platform: "linux",
      targetDirectory,
    });
    try {
      const staged = stageResourceMonitor({
        repoRoot,
        platform: "linux",
        targetDirectory,
        build: (input) => {
          assert.equal(input.targetDirectory, targetDirectory);
          NodeFS.mkdirSync(NodePath.join(input.targetDirectory, "release"), { recursive: true });
          NodeFS.writeFileSync(paths.builtBinaryPath, "cached-monitor");
        },
      });
      assert.equal(NodeFS.readFileSync(staged, "utf8"), "cached-monitor");
      assert.equal(
        NodeFS.existsSync(NodePath.join(repoRoot, "native", "resource-monitor", "target")),
        false,
      );
    } finally {
      NodeFS.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
