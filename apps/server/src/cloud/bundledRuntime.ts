// @effect-diagnostics nodeBuiltinImport:off - Import a trusted, shipped archive without npm or an Electron dependency.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";

const runFile = NodeUtil.promisify(NodeChildProcess.execFile);
export const BUNDLED_RUNTIME_RECEIPT = ".bundled-runtime-sha256";
const ARCHIVE_LIST_TIMEOUT_MS = 30_000;
export const BUNDLED_RUNTIME_EXTRACTION_TIMEOUT_MS = 180_000;

export class BundledRuntimeArchiveError extends Error {
  readonly operation: "list" | "extract";
  readonly timeoutMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killed: boolean;

  constructor(operation: "list" | "extract", timeoutMs: number, failure: unknown) {
    const error = typeof failure === "object" && failure !== null ? failure : {};
    const code = "code" in error ? error.code : null;
    const signal = "signal" in error ? error.signal : null;
    const killed = "killed" in error && error.killed === true;
    const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
    const safeSignal =
      typeof signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : null;
    super(
      `Bundled runtime archive ${operation} failed (limit ${timeoutMs} ms, exit ${exitCode ?? "unknown"}, signal ${safeSignal ?? "none"}, terminated ${killed}).`,
    );
    this.name = "BundledRuntimeArchiveError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    this.exitCode = exitCode;
    this.signal = safeSignal;
    this.killed = killed;
  }
}

async function runArchive(
  operation: "list" | "extract",
  args: readonly string[],
  timeout: number,
  maxBuffer: number,
) {
  try {
    return await runFile("tar", args, { timeout, maxBuffer });
  } catch (failure) {
    // Keep command arguments, archive contents and stderr out of user-facing errors.
    throw new BundledRuntimeArchiveError(operation, timeout, failure);
  }
}

/** The digest must come from the trusted Desktop release, never from an untrusted download. */
export interface BundledRuntimeSource {
  readonly archivePath: string;
  readonly sha256: string;
}

export function bundledRuntimeNodePath(entryPath: string): string {
  return NodePath.resolve(NodePath.dirname(entryPath), "../runtime/node/bin/node");
}

const BundledNodeIdentity = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
  platform: Schema.Literals(["darwin", "linux", "win32"]),
  arch: Schema.Literals(["arm64", "x64"]),
});

const decodeBundledNodeIdentity = Schema.decodeUnknownSync(
  Schema.fromJsonString(BundledNodeIdentity),
);

export async function bundledNodeIdentity(entryPath: string) {
  return decodeBundledNodeIdentity(
    await NodeFSP.readFile(
      NodePath.resolve(
        NodePath.dirname(bundledRuntimeNodePath(entryPath)),
        "../workjet-runtime.json",
      ),
      "utf8",
    ),
  );
}

export function stableBundledRuntimeNodePath(baseDir: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid bundled Node version.");
  return NodePath.join(baseDir, "runtime", "node", version.split(".")[0]!, "bin", "node");
}

async function nodeDigest(file: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Caller holds profile administration ownership and has verified the bundled runtime. */
export async function ensureStableBundledRuntimeNode(baseDir: string, entryPath: string) {
  const identity = await bundledNodeIdentity(entryPath);
  const nodePath = stableBundledRuntimeNodePath(baseDir, identity.version);
  const destination = NodePath.resolve(NodePath.dirname(nodePath), "..");
  const receiptName = ".stable-node-sha256";
  const validate = async () => {
    if (!(await NodeFSP.lstat(destination)).isDirectory())
      throw new Error("Preserve the existing stable Node directory; it must not be a link.");
    const installed = decodeBundledNodeIdentity(
      await NodeFSP.readFile(NodePath.join(destination, "workjet-runtime.json"), "utf8"),
    );
    const executable = await NodeFSP.lstat(nodePath);
    const receipt = (
      await NodeFSP.readFile(NodePath.join(destination, receiptName), "utf8")
    ).trim();
    if (
      installed.version.split(".")[0] !== identity.version.split(".")[0] ||
      installed.platform !== identity.platform ||
      installed.arch !== identity.arch ||
      !executable.isFile() ||
      executable.size === 0 ||
      (executable.mode & 0o111) === 0 ||
      !/^[a-f0-9]{64}$/.test(receipt) ||
      (await nodeDigest(nodePath)) !== receipt
    )
      throw new Error("Stable Node identity or checksum mismatch; preserve the existing runtime.");
  };
  try {
    await NodeFSP.lstat(destination);
    await validate();
    return nodePath;
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    )
      throw error;
    // An incomplete existing directory is not ours to repair or replace.
    try {
      await NodeFSP.lstat(destination);
      throw new Error("Preserve the incomplete stable Node runtime.", { cause: error });
    } catch (missing) {
      if (
        !(
          typeof missing === "object" &&
          missing !== null &&
          "code" in missing &&
          missing.code === "ENOENT"
        )
      )
        throw missing;
    }
  }
  const parent = NodePath.dirname(destination);
  await NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = await NodeFSP.mkdtemp(NodePath.join(parent, ".node-stage-"));
  try {
    const source = NodePath.resolve(NodePath.dirname(bundledRuntimeNodePath(entryPath)), "..");
    await NodeFSP.cp(source, stage, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    const stagedNode = NodePath.join(stage, "bin", "node");
    const executable = await NodeFSP.lstat(stagedNode);
    if (!executable.isFile() || executable.size === 0 || (executable.mode & 0o111) === 0)
      throw new Error("Bundled Node must be a regular executable.");
    await NodeFSP.writeFile(
      NodePath.join(stage, receiptName),
      `${await nodeDigest(stagedNode)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await NodeFSP.rename(stage, destination);
    await validate();
    return nodePath;
  } finally {
    await NodeFSP.rm(stage, { recursive: true, force: true });
  }
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
  const { stdout } = await runArchive(
    "list",
    ["-tzf", archive],
    ARCHIVE_LIST_TIMEOUT_MS,
    4 * 1024 * 1024,
  );
  const members = stdout.trim().split("\n");
  if (
    members.length === 0 ||
    members.some((name) => !name.startsWith("package/") || name.split("/").includes(".."))
  ) {
    throw new Error("Bundled runtime archive has an unexpected package layout.");
  }
  const unpacked = NodePath.join(input.stagingDir, ".unpacked");
  await NodeFSP.mkdir(unpacked, { mode: 0o700 });
  await runArchive(
    "extract",
    ["-xzf", archive, "-C", unpacked],
    BUNDLED_RUNTIME_EXTRACTION_TIMEOUT_MS,
    1024 * 1024,
  );
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
