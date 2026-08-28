import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDirectory = NodePath.resolve(scriptDirectory, "..");
const defaultRepoRoot = NodePath.resolve(desktopDirectory, "..", "..");

export function resourceMonitorExecutableName(platform) {
  return platform === "win32" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
}

export function resolveResourceMonitorStagePaths({ repoRoot, platform }) {
  const executableName = resourceMonitorExecutableName(platform);
  return {
    manifestPath: NodePath.join(repoRoot, "native", "resource-monitor", "Cargo.toml"),
    builtBinaryPath: NodePath.join(
      repoRoot,
      "native",
      "resource-monitor",
      "target",
      "release",
      executableName,
    ),
    stagedDirectory: NodePath.join(
      repoRoot,
      "apps",
      "desktop",
      "prod-resources",
      "resource-monitor",
    ),
    stagedBinaryPath: NodePath.join(
      repoRoot,
      "apps",
      "desktop",
      "prod-resources",
      "resource-monitor",
      executableName,
    ),
  };
}

function buildResourceMonitor({ repoRoot, manifestPath }) {
  const result = NodeChildProcess.spawnSync(
    "cargo",
    ["build", "--locked", "--release", "--manifest-path", manifestPath],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error(`Resource monitor build failed with exit code ${result.status ?? "unknown"}.`);
  }
}

export function stageResourceMonitor({
  repoRoot = defaultRepoRoot,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build script host target.
  platform = NodeOS.platform(),
  build = buildResourceMonitor,
} = {}) {
  const paths = resolveResourceMonitorStagePaths({ repoRoot, platform });
  build({ repoRoot, manifestPath: paths.manifestPath });

  if (!NodeFS.existsSync(paths.builtBinaryPath)) {
    throw new Error(`Resource monitor build did not produce ${paths.builtBinaryPath}.`);
  }

  NodeFS.rmSync(paths.stagedDirectory, { recursive: true, force: true });
  NodeFS.mkdirSync(paths.stagedDirectory, { recursive: true });
  NodeFS.copyFileSync(paths.builtBinaryPath, paths.stagedBinaryPath);
  if (platform !== "win32") {
    NodeFS.chmodSync(paths.stagedBinaryPath, 0o755);
  }

  return paths.stagedBinaryPath;
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build script entrypoint.
if (import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const stagedBinaryPath = stageResourceMonitor();
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build script output.
  process.stdout.write(`[desktop] Staged resource monitor at ${stagedBinaryPath}\n`);
}
