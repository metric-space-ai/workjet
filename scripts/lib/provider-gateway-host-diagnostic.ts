// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - Explicit local packaging filesystem and Git provenance boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  decodeProviderGatewayHostDiagnostic,
  PROVIDER_GATEWAY_DIAGNOSTIC_FILE,
  PROVIDER_GATEWAY_DIAGNOSTIC_MAX_BYTES,
  PROVIDER_GATEWAY_DIAGNOSTIC_EXECUTABLE_MAX_BYTES,
  type ProviderGatewayHostDiagnostic,
} from "@workjet/shared/providerGatewayHostDiagnostic";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const nativePaths = ["native/provider-gateway-workjet-host", "native/provider-gateway"];
export async function captureDiagnosticNativeSource(repoRoot: string) {
  const git = async (...args: string[]) =>
    (await execFile("git", args, { cwd: repoRoot, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await git("status", "--porcelain", "--", ...nativePaths))
    throw new Error(
      "Commit native gateway changes before creating or packaging a diagnostic host.",
    );
  return {
    sourceCommit: await git("rev-parse", "HEAD"),
    nativeSource: {
      hostTree: await git("rev-parse", "HEAD:native/provider-gateway-workjet-host"),
      proxyTree: await git("rev-parse", "HEAD:native/provider-gateway"),
    },
  };
}
async function regularBytes(path: string, maximum: number): Promise<Buffer> {
  const stat = await NodeFSP.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum)
    throw new Error("Diagnostic artifact must be a bounded regular file.");
  const bytes = await NodeFSP.readFile(path);
  if (bytes.byteLength !== stat.size) throw new Error("Diagnostic artifact changed during read.");
  return bytes;
}
export function assertDiagnosticMachO(bytes: Uint8Array, arch: "arm64" | "x64"): void {
  const buffer = Buffer.from(bytes);
  const cpu = arch === "arm64" ? 0x0100000c : 0x01000007;
  if (
    buffer.length < 32 ||
    buffer.readUInt32LE(0) !== 0xfeedfacf ||
    buffer.readUInt32LE(4) !== cpu ||
    buffer.readUInt32LE(12) !== 2
  )
    throw new Error(
      "Diagnostic host must be a Mach-O executable for the requested Mac architecture.",
    );
}
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Produce a truthful one-platform receipt after compiling committed native source. */
export async function stageDiagnosticProviderGatewayHost(options: {
  repoRoot: string;
  binaryPath: string;
  outDir: string;
  arch: "arm64" | "x64";
  expectedNativeSource: Awaited<ReturnType<typeof captureDiagnosticNativeSource>>["nativeSource"];
}): Promise<string> {
  const identity = await captureDiagnosticNativeSource(options.repoRoot);
  if (JSON.stringify(identity.nativeSource) !== JSON.stringify(options.expectedNativeSource))
    throw new Error("Native source changed during diagnostic compilation.");
  const bytes = await regularBytes(
    options.binaryPath,
    PROVIDER_GATEWAY_DIAGNOSTIC_EXECUTABLE_MAX_BYTES,
  );
  assertDiagnosticMachO(bytes, options.arch);
  const crate = await NodeFSP.readFile(
    NodePath.join(options.repoRoot, "native/provider-gateway-workjet-host/Cargo.toml"),
    "utf8",
  );
  const version = /^version\s*=\s*"([^"]+)"/mu.exec(crate)?.[1];
  if (!version) throw new Error("Diagnostic host crate version is missing.");
  const manifest = decodeProviderGatewayHostDiagnostic({
    schema: "workjet.provider-gateway-host.diagnostic-package.v1",
    component: "workjet-provider-gateway-host",
    ...identity,
    version,
    artifact: {
      os: "darwin",
      arch: options.arch,
      triple: options.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
      fileName: "workjet-provider-gateway-host",
      byteLength: bytes.byteLength,
      sha256: digest(bytes),
    },
  });
  await NodeFSP.mkdir(options.outDir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(options.outDir, manifest.artifact.fileName), bytes, {
    flag: "wx",
    mode: 0o755,
  });
  const path = NodePath.join(options.outDir, PROVIDER_GATEWAY_DIAGNOSTIC_FILE);
  await NodeFSP.writeFile(path, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return path;
}

/** Explicit build input only. Never downloads, invents a release pin or falls back. */
export async function prepareDiagnosticProviderGatewayHost(options: {
  repoRoot: string;
  manifestPath: string;
  platform: "mac" | "linux" | "win";
  arch: "arm64" | "x64" | "universal";
  dependencyRoot?: string;
}): Promise<{ installPath: string; version: string; manifest: ProviderGatewayHostDiagnostic }> {
  if (options.platform !== "mac" || options.arch === "universal")
    throw new Error(
      "A diagnostic host package supports one explicitly built Mac architecture only.",
    );
  const manifest = decodeProviderGatewayHostDiagnostic(
    JSON.parse(
      (await regularBytes(options.manifestPath, PROVIDER_GATEWAY_DIAGNOSTIC_MAX_BYTES)).toString(
        "utf8",
      ),
    ),
  );
  if (manifest.artifact.arch !== options.arch)
    throw new Error("Diagnostic host does not match the requested architecture.");
  const identity = await captureDiagnosticNativeSource(options.repoRoot);
  if (
    identity.nativeSource.hostTree !== manifest.nativeSource.hostTree ||
    identity.nativeSource.proxyTree !== manifest.nativeSource.proxyTree
  )
    throw new Error("Diagnostic host was built from different native gateway source.");
  const bytes = await regularBytes(
    NodePath.join(NodePath.dirname(options.manifestPath), manifest.artifact.fileName),
    PROVIDER_GATEWAY_DIAGNOSTIC_EXECUTABLE_MAX_BYTES,
  );
  if (
    bytes.byteLength !== manifest.artifact.byteLength ||
    digest(bytes) !== manifest.artifact.sha256
  )
    throw new Error("Diagnostic host bytes disagree with their recorded size and SHA-256.");
  assertDiagnosticMachO(bytes, options.arch);
  const installPath = NodePath.join(
    options.dependencyRoot ??
      NodePath.join(options.repoRoot, ".deps/workjet-provider-gateway-host/diagnostic"),
    manifest.artifact.sha256,
  );
  await NodeFSP.mkdir(installPath, { recursive: true });
  const installStat = await NodeFSP.lstat(installPath);
  if (!installStat.isDirectory() || installStat.isSymbolicLink())
    throw new Error("Diagnostic staging must use a real owned directory.");
  const writeAtomic = async (path: string, data: Uint8Array | string, mode: number) => {
    const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(temporary, data, { flag: "wx", mode });
      await NodeFSP.rename(temporary, path);
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
  };
  await writeAtomic(NodePath.join(installPath, manifest.artifact.fileName), bytes, 0o755);
  await NodeFSP.chmod(NodePath.join(installPath, manifest.artifact.fileName), 0o755);
  await writeAtomic(
    NodePath.join(installPath, PROVIDER_GATEWAY_DIAGNOSTIC_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
    0o644,
  );
  return { installPath, version: `diagnostic-${manifest.sourceCommit.slice(0, 12)}`, manifest };
}
