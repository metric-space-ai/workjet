// @effect-diagnostics nodeBuiltinImport:off - Import a trusted, shipped archive without npm or an Electron dependency.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const runFile = NodeUtil.promisify(NodeChildProcess.execFile);
export const BUNDLED_RUNTIME_RECEIPT = ".bundled-runtime-sha256";

/** The digest must come from the trusted Desktop release, never from an untrusted download. */
export interface BundledRuntimeSource {
  readonly archivePath: string;
  readonly sha256: string;
}

export function bundledRuntimeNodePath(entryPath: string): string {
  return NodePath.resolve(NodePath.dirname(entryPath), "../runtime/node/bin/node");
}

/** Called only inside the shared pinned-install lock, with a newly owned staging directory. */
export async function stageBundledRuntime(input: {
  readonly source: BundledRuntimeSource;
  readonly stagingDir: string;
  readonly version: string;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.source.sha256)) {
    throw new Error("A trusted SHA-256 is required for the bundled runtime.");
  }
  const archive = NodePath.join(input.stagingDir, ".bundle.tgz");
  // Hash and extract our private copy so replacement of the source path cannot
  // switch the bytes between verification and extraction.
  await NodeFSP.copyFile(input.source.archivePath, archive);
  await NodeFSP.chmod(archive, 0o600);
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== input.source.sha256) {
    throw new Error("Bundled runtime archive checksum mismatch.");
  }
  const { stdout } = await runFile("tar", ["-tzf", archive], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const members = stdout.trim().split("\n");
  if (
    members.length === 0 ||
    members.some((name) => !name.startsWith("package/") || name.split("/").includes(".."))
  ) {
    throw new Error("Bundled runtime archive has an unexpected package layout.");
  }
  const unpacked = NodePath.join(input.stagingDir, ".unpacked");
  await NodeFSP.mkdir(unpacked, { mode: 0o700 });
  await runFile("tar", ["-xzf", archive, "-C", unpacked], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const packageDir = NodePath.join(unpacked, "package");
  const manifest: unknown = JSON.parse(
    await NodeFSP.readFile(NodePath.join(packageDir, "package.json"), "utf8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    manifest.version !== input.version
  ) {
    throw new Error("Bundled runtime package version does not match the service version.");
  }
  for (const relative of [
    "dist/bin.mjs",
    "dist/service-launcher.mjs",
    "runtime/node/bin/node",
    "runtime/node/LICENSE",
    "runtime/node/workjet-runtime.json",
  ]) {
    const file = NodePath.join(packageDir, relative);
    const canonical = await NodeFSP.realpath(file);
    if (
      !canonical.startsWith(`${await NodeFSP.realpath(packageDir)}${NodePath.sep}`) ||
      !(await NodeFSP.lstat(file)).isFile()
    ) {
      throw new Error(`Bundled runtime requires a regular packaged file: ${relative}`);
    }
  }
  await NodeFSP.mkdir(NodePath.join(input.stagingDir, "node_modules"));
  await NodeFSP.rename(packageDir, NodePath.join(input.stagingDir, "node_modules", "workjet"));
  await NodeFSP.rm(unpacked, { recursive: true });
  await NodeFSP.unlink(archive);
  await NodeFSP.writeFile(
    NodePath.join(input.stagingDir, BUNDLED_RUNTIME_RECEIPT),
    `${input.source.sha256}\n`,
    { mode: 0o600, flag: "wx" },
  );
}
