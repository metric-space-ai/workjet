#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - Release staging runs before any Effect runtime and works on raw bytes.

/**
 * Stage, collect, and verify `workjet-provider-gateway-host` release artifacts.
 *
 * The release workflow calls exactly these subcommands, so running them locally
 * reproduces a release byte for byte for whatever targets the local machine can
 * build:
 *
 *   node scripts/provider-gateway-host-artifacts.ts stage \
 *     --triple aarch64-apple-darwin --version 0.1.0 \
 *     --binary <cargo target dir>/aarch64-apple-darwin/release/workjet-provider-gateway-host \
 *     --out-dir dist/gateway-host
 *
 *   node scripts/provider-gateway-host-artifacts.ts collect \
 *     --version 0.1.0 --source-commit <40 hex> --dir dist/gateway-host
 *
 *   node scripts/provider-gateway-host-artifacts.ts verify --dir dist/gateway-host
 *
 *   node scripts/provider-gateway-host-artifacts.ts pin \
 *     --dir dist/gateway-host --out apps/desktop/resources/provider-gateway/host-release.pin.json
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  buildProviderGatewayHostPin,
  buildProviderGatewayHostReleaseManifest,
  decodeProviderGatewayHostReleaseManifest,
  findProviderGatewayHostTarget,
  formatProviderGatewayHostChecksums,
  parseProviderGatewayHostChecksums,
  PROVIDER_GATEWAY_HOST_EXECUTABLE_MAX_BYTES,
  PROVIDER_GATEWAY_HOST_TARGETS,
  providerGatewayHostAssetName,
  providerGatewayHostChecksumsName,
  providerGatewayHostManifestName,
  serializeProviderGatewayHostPin,
  serializeProviderGatewayHostReleaseManifest,
  type ProviderGatewayHostReleaseManifest,
  type StagedProviderGatewayHostArtifact,
} from "./lib/provider-gateway-host-artifacts.ts";

export const STAGED_ARTIFACT_SUFFIX = ".artifact.json";
export const LICENSE_ASSET_FILES = [
  { source: "native/provider-gateway/LICENSE.MIT", asset: "LICENSE.MIT" },
  { source: "native/provider-gateway/LICENSE.AGPL-3.0-only", asset: "LICENSE.AGPL-3.0-only" },
  { source: "native/provider-gateway/LICENSE.upstream", asset: "LICENSE.upstream" },
  { source: "NOTICE.md", asset: "NOTICE.md" },
] as const;

interface ParsedArguments {
  readonly command: string;
  readonly options: ReadonlyMap<string, string>;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0];
  if (command === undefined || command.startsWith("--")) {
    throw new Error("A subcommand is required: stage, collect, verify, or pin.");
  }
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new Error(`Expected a --flag, received ${String(flag)}.`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }
    const name = flag.slice(2);
    if (options.has(name)) throw new Error(`${flag} may be provided only once.`);
    options.set(name, value);
  }
  return { command, options };
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new Error(`--${name} is required.`);
  return value;
}

async function digestRegularFile(
  filePath: string,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const stat = await NodeFSP.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${filePath} is not a regular file.`);
  }
  if (stat.size < 1 || stat.size > PROVIDER_GATEWAY_HOST_EXECUTABLE_MAX_BYTES) {
    throw new Error(`${filePath} is empty or exceeds the executable byte budget.`);
  }
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const hash = NodeCrypto.createHash("sha256");
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      hash.update(buffer);
    }
    if (byteLength !== stat.size) throw new Error(`${filePath} changed while being digested.`);
    return { byteLength, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export interface StageResult {
  readonly assetPath: string;
  readonly recordPath: string;
  readonly staged: StagedProviderGatewayHostArtifact;
}

/** Copy one freshly built executable to its contract asset name and digest it. */
export async function stageArtifact(input: {
  readonly triple: string;
  readonly version: string;
  readonly binaryPath: string;
  readonly outDir: string;
}): Promise<StageResult> {
  findProviderGatewayHostTarget(input.triple);
  const assetName = providerGatewayHostAssetName(input.version, input.triple);
  await NodeFSP.mkdir(input.outDir, { recursive: true });
  const assetPath = NodePath.join(input.outDir, assetName);
  await NodeFSP.rm(assetPath, { force: true });
  await NodeFSP.copyFile(input.binaryPath, assetPath);
  await NodeFSP.chmod(assetPath, 0o755);
  const digest = await digestRegularFile(assetPath);
  const staged: StagedProviderGatewayHostArtifact = {
    triple: input.triple,
    byteLength: digest.byteLength,
    sha256: digest.sha256,
  };
  const recordPath = `${assetPath}${STAGED_ARTIFACT_SUFFIX}`;
  await NodeFSP.writeFile(recordPath, `${JSON.stringify(staged, null, 2)}\n`, "utf8");
  return { assetPath, recordPath, staged };
}

async function readStagedRecords(
  directory: string,
): Promise<readonly StagedProviderGatewayHostArtifact[]> {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  const staged: StagedProviderGatewayHostArtifact[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(STAGED_ARTIFACT_SUFFIX)) continue;
    const parsed: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, entry.name), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`${entry.name} is not a staged-artifact record.`);
    }
    staged.push(parsed as StagedProviderGatewayHostArtifact);
  }
  return staged;
}

export interface CollectResult {
  readonly manifest: ProviderGatewayHostReleaseManifest;
  readonly manifestPath: string;
  readonly checksumsPath: string;
}

/**
 * Merge every staged record into the detached manifest and the sha256sums file,
 * and copy the license texts the dual-licensed binary must be distributed with.
 */
export async function collectRelease(input: {
  readonly version: string;
  readonly sourceCommit: string;
  readonly license: string;
  readonly directory: string;
  readonly repoRoot: string;
}): Promise<CollectResult> {
  const manifest = buildProviderGatewayHostReleaseManifest({
    version: input.version,
    sourceCommit: input.sourceCommit,
    license: input.license,
    staged: await readStagedRecords(input.directory),
  });
  const manifestPath = NodePath.join(
    input.directory,
    providerGatewayHostManifestName(manifest.version),
  );
  const checksumsPath = NodePath.join(
    input.directory,
    providerGatewayHostChecksumsName(manifest.version),
  );
  await NodeFSP.writeFile(
    manifestPath,
    serializeProviderGatewayHostReleaseManifest(manifest),
    "utf8",
  );
  await NodeFSP.writeFile(checksumsPath, formatProviderGatewayHostChecksums(manifest), "utf8");
  for (const license of LICENSE_ASSET_FILES) {
    await NodeFSP.copyFile(
      NodePath.join(input.repoRoot, license.source),
      NodePath.join(input.directory, license.asset),
    );
  }
  return { manifest, manifestPath, checksumsPath };
}

/** Re-read the published directory and prove every asset matches the manifest. */
export async function verifyRelease(input: {
  readonly directory: string;
  readonly version?: string;
}): Promise<ProviderGatewayHostReleaseManifest> {
  const version = input.version ?? (await inferVersion(input.directory));
  const manifestPath = NodePath.join(input.directory, providerGatewayHostManifestName(version));
  const manifestBytes = await NodeFSP.readFile(manifestPath);
  const manifest = decodeProviderGatewayHostReleaseManifest(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
  );
  const checksums = parseProviderGatewayHostChecksums(
    await NodeFSP.readFile(NodePath.join(input.directory, manifest.checksumsFileName), "utf8"),
  );
  if (checksums.size !== manifest.artifacts.length) {
    throw new Error("The checksums file and the manifest cover different artifact sets.");
  }
  for (const artifact of manifest.artifacts) {
    const digest = await digestRegularFile(NodePath.join(input.directory, artifact.fileName));
    if (digest.byteLength !== artifact.byteLength || digest.sha256 !== artifact.sha256) {
      throw new Error(`${artifact.fileName} does not match its manifest entry.`);
    }
    if (checksums.get(artifact.fileName) !== artifact.sha256) {
      throw new Error(`${artifact.fileName} does not match its checksums entry.`);
    }
  }
  for (const license of LICENSE_ASSET_FILES) {
    await NodeFSP.access(NodePath.join(input.directory, license.asset));
  }
  return manifest;
}

async function inferVersion(directory: string): Promise<string> {
  const entries = await NodeFSP.readdir(directory);
  const manifests = entries.filter((name) => name.endsWith(".manifest.json"));
  const only = manifests[0];
  if (manifests.length !== 1 || only === undefined) {
    throw new Error("Pass --version: the directory does not hold exactly one release manifest.");
  }
  return only.slice("workjet-provider-gateway-host-".length, -".manifest.json".length);
}

/** Emit the consumer pin for an already-collected release directory. */
export async function writePin(input: {
  readonly directory: string;
  readonly outPath: string;
  readonly version?: string;
}): Promise<string> {
  const version = input.version ?? (await inferVersion(input.directory));
  const manifestPath = NodePath.join(input.directory, providerGatewayHostManifestName(version));
  const manifestBytes = await NodeFSP.readFile(manifestPath);
  const manifest = decodeProviderGatewayHostReleaseManifest(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
  );
  const pin = buildProviderGatewayHostPin({ manifest, manifestBytes });
  await NodeFSP.mkdir(NodePath.dirname(input.outPath), { recursive: true });
  await NodeFSP.writeFile(input.outPath, serializeProviderGatewayHostPin(pin), "utf8");
  return input.outPath;
}

async function main(argv: readonly string[]): Promise<void> {
  const { command, options } = parseArguments(argv);
  const repoRoot = NodePath.resolve(
    options.get("repo-root") ?? NodeURL.fileURLToPath(new URL("..", import.meta.url)),
  );
  if (command === "targets") {
    for (const target of PROVIDER_GATEWAY_HOST_TARGETS) {
      process.stdout.write(`${target.triple}\t${target.os}\t${target.arch}\t${target.runner}\n`);
    }
    return;
  }
  if (command === "stage") {
    const result = await stageArtifact({
      triple: required(options, "triple"),
      version: required(options, "version"),
      binaryPath: NodePath.resolve(required(options, "binary")),
      outDir: NodePath.resolve(required(options, "out-dir")),
    });
    process.stdout.write(
      `[gateway-host] staged ${result.staged.triple} ${result.staged.byteLength} bytes sha256=${result.staged.sha256}\n`,
    );
    return;
  }
  if (command === "collect") {
    const result = await collectRelease({
      version: required(options, "version"),
      sourceCommit: required(options, "source-commit"),
      license: options.get("license") ?? "MIT OR AGPL-3.0-only",
      directory: NodePath.resolve(required(options, "dir")),
      repoRoot,
    });
    process.stdout.write(
      `[gateway-host] collected ${result.manifest.artifacts.length} artifacts into ${result.manifestPath}\n`,
    );
    return;
  }
  if (command === "verify") {
    const version = options.get("version");
    const manifest = await verifyRelease({
      directory: NodePath.resolve(required(options, "dir")),
      ...(version === undefined ? {} : { version }),
    });
    process.stdout.write(
      `[gateway-host] verified ${manifest.releaseTag} (${manifest.artifacts.length} artifacts)\n`,
    );
    return;
  }
  if (command === "pin") {
    const version = options.get("version");
    const outPath = await writePin({
      directory: NodePath.resolve(required(options, "dir")),
      outPath: NodePath.resolve(required(options, "out")),
      ...(version === undefined ? {} : { version }),
    });
    process.stdout.write(`[gateway-host] wrote pin ${outPath}\n`);
    return;
  }
  throw new Error(`Unknown subcommand ${command}.`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Unknown failure.";
    process.stderr.write(`[gateway-host] ${message}\n`);
    process.exitCode = 1;
  }
}
