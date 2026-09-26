// @effect-diagnostics nodeBuiltinImport:off - Import a trusted, shipped archive without npm or an Electron dependency.
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
export const BUNDLED_RUNTIME_RECEIPT = ".bundled-runtime-sha256";

/** The digest must come from the trusted Desktop release, never from an untrusted download. */
export interface BundledRuntimeSource {
  readonly archivePath: string;
  readonly sha256: string;
}

export function bundledRuntimeNodePath(entryPath: string): string {
  return path.resolve(path.dirname(entryPath), "../runtime/node/bin/node");
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
  const archive = path.join(input.stagingDir, ".bundle.tgz");
  // Hash and extract our private copy so replacement of the source path cannot
  // switch the bytes between verification and extraction.
  await fs.copyFile(input.source.archivePath, archive);
  await fs.chmod(archive, 0o600);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
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
  const unpacked = path.join(input.stagingDir, ".unpacked");
  await fs.mkdir(unpacked, { mode: 0o700 });
  await runFile("tar", ["-xzf", archive, "-C", unpacked], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const packageDir = path.join(unpacked, "package");
  // @effect-diagnostics-next-line preferSchemaOverJson:off - Validate the fixed shipped package manifest before publishing.
  const manifest: unknown = JSON.parse(
    await fs.readFile(path.join(packageDir, "package.json"), "utf8"),
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
    const file = path.join(packageDir, relative);
    const canonical = await fs.realpath(file);
    if (
      !canonical.startsWith(`${await fs.realpath(packageDir)}${path.sep}`) ||
      !(await fs.lstat(file)).isFile()
    ) {
      throw new Error(`Bundled runtime requires a regular packaged file: ${relative}`);
    }
  }
  await fs.mkdir(path.join(input.stagingDir, "node_modules"));
  await fs.rename(packageDir, path.join(input.stagingDir, "node_modules", "workjet"));
  await fs.rm(unpacked, { recursive: true });
  await fs.unlink(archive);
  await fs.writeFile(
    path.join(input.stagingDir, BUNDLED_RUNTIME_RECEIPT),
    `${input.source.sha256}\n`,
    { mode: 0o600, flag: "wx" },
  );
}
