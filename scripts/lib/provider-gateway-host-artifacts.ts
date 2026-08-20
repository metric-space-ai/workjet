// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - Release staging needs byte-level digesting before any Effect runtime exists.

/**
 * The artifact contract for `workjet-provider-gateway-host` release builds.
 *
 * One gateway release publishes exactly one raw executable per Rust target
 * triple, one detached release manifest, one `sha256sums` text file, and the
 * license/notice texts the binary's dual MIT OR AGPL-3.0-only licensing
 * requires. Consumers (Workjet desktop packaging and CTOX packaging) pin a
 * release by recording the manifest digest plus every per-target digest; a pin
 * whose bytes do not reproduce is a hard failure, never a silent rebuild.
 *
 * This module is the single source of truth for naming, URLs, and manifest
 * shape. The release workflow, the local staging CLI, and the consumer
 * resolvers all derive their strings from here so they cannot drift.
 */

import * as NodeCrypto from "node:crypto";

export const PROVIDER_GATEWAY_HOST_CRATE = "workjet-provider-gateway-host";
export const PROVIDER_GATEWAY_HOST_BINARY = "workjet-provider-gateway-host";
export const PROVIDER_GATEWAY_HOST_RELEASE_SCHEMA = "workjet.provider-gateway-host.release.v1";
export const PROVIDER_GATEWAY_HOST_PIN_SCHEMA = "workjet.provider-gateway-host.pin.v1";
export const PROVIDER_GATEWAY_HOST_TAG_PREFIX = "provider-gateway-host-v";
export const PROVIDER_GATEWAY_HOST_RELEASE_REPOSITORY = "metric-space-ai/workjet";
export const PROVIDER_GATEWAY_HOST_MANIFEST_MAX_BYTES = 64 * 1024;
/** A stripped release host is a few MiB; 128 MiB is a generous hard ceiling. */
export const PROVIDER_GATEWAY_HOST_EXECUTABLE_MAX_BYTES = 128 * 1024 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
/** Semver-ish: the crate version, optionally with a prerelease suffix. */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

export type ProviderGatewayHostOs = "darwin" | "linux" | "win32";
export type ProviderGatewayHostArch = "arm64" | "x64";

export interface ProviderGatewayHostTarget {
  /** Rust target triple; the canonical identity of one artifact. */
  readonly triple: string;
  /** Node `process.platform` value a consumer matches against. */
  readonly os: ProviderGatewayHostOs;
  /** Node `process.arch` value a consumer matches against. */
  readonly arch: ProviderGatewayHostArch;
  /** GitHub Actions runner label that produces this triple natively. */
  readonly runner: string;
  readonly executableSuffix: "" | ".exe";
}

/**
 * The six targets Workjet and CTOX packaging require.
 *
 * Runner choice: every triple builds on a runner that can produce it without a
 * cross toolchain. macOS x64 is the one exception and is the repository's
 * existing practice — the desktop release matrix already builds
 * `x86_64-apple-darwin` on the arm64 macOS runner, which Apple's toolchain
 * supports out of the box. The two ARM64 non-Apple triples use GitHub-hosted
 * ARM runners because this repository has no Blacksmith ARM labels; inventing
 * an MSVC/GCC cross-linking setup would be far more fragile than a native run.
 */
export const PROVIDER_GATEWAY_HOST_TARGETS: readonly ProviderGatewayHostTarget[] = [
  {
    triple: "aarch64-apple-darwin",
    os: "darwin",
    arch: "arm64",
    runner: "blacksmith-12vcpu-macos-26",
    executableSuffix: "",
  },
  {
    triple: "x86_64-apple-darwin",
    os: "darwin",
    arch: "x64",
    runner: "blacksmith-12vcpu-macos-26",
    executableSuffix: "",
  },
  {
    triple: "x86_64-unknown-linux-gnu",
    os: "linux",
    arch: "x64",
    runner: "blacksmith-32vcpu-ubuntu-2404",
    executableSuffix: "",
  },
  {
    triple: "aarch64-unknown-linux-gnu",
    os: "linux",
    arch: "arm64",
    runner: "ubuntu-24.04-arm",
    executableSuffix: "",
  },
  {
    triple: "x86_64-pc-windows-msvc",
    os: "win32",
    arch: "x64",
    runner: "blacksmith-32vcpu-windows-2025",
    executableSuffix: ".exe",
  },
  {
    triple: "aarch64-pc-windows-msvc",
    os: "win32",
    arch: "arm64",
    runner: "windows-11-arm",
    executableSuffix: ".exe",
  },
] as const;

export class ProviderGatewayHostArtifactError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderGatewayHostArtifactError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProviderGatewayHostArtifactError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string")
    fail("manifest-invalid", `${label} field ${key} must be a string.`);
  return value;
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
  minimum = 0,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail("manifest-invalid", `${label} field ${key} must be an integer of at least ${minimum}.`);
  }
  return value;
}

export function assertSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value))
    fail("manifest-invalid", `${label} must be a lowercase SHA-256.`);
  return value;
}

export function assertSourceCommit(value: string, label: string): string {
  if (!SOURCE_COMMIT_PATTERN.test(value)) {
    fail("manifest-invalid", `${label} must be 40 lowercase hexadecimal characters.`);
  }
  return value;
}

export function assertVersion(value: string, label: string): string {
  if (!VERSION_PATTERN.test(value)) {
    fail("manifest-invalid", `${label} must be a semantic version such as 0.1.0 or 0.1.0-rc.1.`);
  }
  return value;
}

export function findProviderGatewayHostTarget(triple: string): ProviderGatewayHostTarget {
  const target = PROVIDER_GATEWAY_HOST_TARGETS.find((entry) => entry.triple === triple);
  if (target === undefined) {
    fail("unknown-target", `${triple} is not a released provider-gateway host target.`);
  }
  return target;
}

export function findProviderGatewayHostTargetForHost(
  os: string,
  arch: string,
): ProviderGatewayHostTarget | undefined {
  return PROVIDER_GATEWAY_HOST_TARGETS.find((entry) => entry.os === os && entry.arch === arch);
}

/** `provider-gateway-host-v0.1.0` — deliberately unlike the desktop's `v*.*.*`. */
export function providerGatewayHostReleaseTag(version: string): string {
  return `${PROVIDER_GATEWAY_HOST_TAG_PREFIX}${assertVersion(version, "Release version")}`;
}

export function parseProviderGatewayHostReleaseTag(tag: string): string {
  if (!tag.startsWith(PROVIDER_GATEWAY_HOST_TAG_PREFIX)) {
    fail(
      "tag-invalid",
      `Release tag must start with ${PROVIDER_GATEWAY_HOST_TAG_PREFIX}; received ${tag}.`,
    );
  }
  return assertVersion(tag.slice(PROVIDER_GATEWAY_HOST_TAG_PREFIX.length), "Release tag version");
}

/** `workjet-provider-gateway-host-0.1.0-aarch64-apple-darwin` (`.exe` on Windows). */
export function providerGatewayHostAssetName(version: string, triple: string): string {
  const target = findProviderGatewayHostTarget(triple);
  return `${PROVIDER_GATEWAY_HOST_BINARY}-${assertVersion(version, "Release version")}-${target.triple}${target.executableSuffix}`;
}

export function providerGatewayHostManifestName(version: string): string {
  return `${PROVIDER_GATEWAY_HOST_BINARY}-${assertVersion(version, "Release version")}.manifest.json`;
}

export function providerGatewayHostChecksumsName(version: string): string {
  return `${PROVIDER_GATEWAY_HOST_BINARY}-${assertVersion(version, "Release version")}.sha256sums.txt`;
}

export function providerGatewayHostAssetUrl(tag: string, fileName: string): string {
  parseProviderGatewayHostReleaseTag(tag);
  if (fileName.length === 0 || fileName.includes("/") || fileName.includes("..")) {
    fail("asset-invalid", "Release asset names must be single path-free file names.");
  }
  return `https://github.com/${PROVIDER_GATEWAY_HOST_RELEASE_REPOSITORY}/releases/download/${tag}/${fileName}`;
}

export interface ProviderGatewayHostArtifactRecord {
  readonly triple: string;
  readonly os: ProviderGatewayHostOs;
  readonly arch: ProviderGatewayHostArch;
  readonly fileName: string;
  readonly url: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ProviderGatewayHostReleaseManifest {
  readonly schema: typeof PROVIDER_GATEWAY_HOST_RELEASE_SCHEMA;
  readonly component: typeof PROVIDER_GATEWAY_HOST_CRATE;
  readonly version: string;
  readonly releaseTag: string;
  readonly sourceCommit: string;
  readonly repository: typeof PROVIDER_GATEWAY_HOST_RELEASE_REPOSITORY;
  readonly license: string;
  readonly checksumsFileName: string;
  readonly artifacts: readonly ProviderGatewayHostArtifactRecord[];
}

/** One staged artifact as the per-target build job hands it to the collector. */
export interface StagedProviderGatewayHostArtifact {
  readonly triple: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export function digestBytes(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

export interface BuildProviderGatewayHostReleaseManifestInput {
  readonly version: string;
  readonly sourceCommit: string;
  readonly license: string;
  readonly staged: readonly StagedProviderGatewayHostArtifact[];
}

/**
 * Assemble the detached release manifest. Every declared target must be staged
 * exactly once: a partially built release is refused rather than published as a
 * manifest a consumer would silently fail to resolve on the missing platform.
 */
export function buildProviderGatewayHostReleaseManifest(
  input: BuildProviderGatewayHostReleaseManifestInput,
): ProviderGatewayHostReleaseManifest {
  const version = assertVersion(input.version, "Release version");
  const releaseTag = providerGatewayHostReleaseTag(version);
  const seen = new Set<string>();
  for (const staged of input.staged) {
    findProviderGatewayHostTarget(staged.triple);
    if (seen.has(staged.triple)) {
      fail("duplicate-target", `Target ${staged.triple} was staged more than once.`);
    }
    seen.add(staged.triple);
  }
  const missing = PROVIDER_GATEWAY_HOST_TARGETS.filter((target) => !seen.has(target.triple)).map(
    (target) => target.triple,
  );
  if (missing.length !== 0) {
    fail("incomplete-release", `Release is missing required targets: ${missing.join(", ")}.`);
  }

  const artifacts = PROVIDER_GATEWAY_HOST_TARGETS.map(
    (target): ProviderGatewayHostArtifactRecord => {
      const staged = input.staged.find((entry) => entry.triple === target.triple);
      if (staged === undefined) fail("incomplete-release", `Target ${target.triple} is missing.`);
      if (!Number.isSafeInteger(staged.byteLength) || staged.byteLength < 1) {
        fail("manifest-invalid", `Target ${target.triple} has a non-positive byte length.`);
      }
      if (staged.byteLength > PROVIDER_GATEWAY_HOST_EXECUTABLE_MAX_BYTES) {
        fail("budget-exceeded", `Target ${target.triple} exceeds the executable byte budget.`);
      }
      const fileName = providerGatewayHostAssetName(version, target.triple);
      return {
        triple: target.triple,
        os: target.os,
        arch: target.arch,
        fileName,
        url: providerGatewayHostAssetUrl(releaseTag, fileName),
        byteLength: staged.byteLength,
        sha256: assertSha256(staged.sha256, `Target ${target.triple} SHA-256`),
      };
    },
  );

  return {
    schema: PROVIDER_GATEWAY_HOST_RELEASE_SCHEMA,
    component: PROVIDER_GATEWAY_HOST_CRATE,
    version,
    releaseTag,
    sourceCommit: assertSourceCommit(input.sourceCommit, "Release source commit"),
    repository: PROVIDER_GATEWAY_HOST_RELEASE_REPOSITORY,
    license: input.license,
    checksumsFileName: providerGatewayHostChecksumsName(version),
    artifacts,
  };
}

export function decodeProviderGatewayHostReleaseManifest(
  value: unknown,
): ProviderGatewayHostReleaseManifest {
  if (!isRecord(value)) fail("manifest-invalid", "Release manifest must be a JSON object.");
  const label = "Release manifest";
  if (readString(value, "schema", label) !== PROVIDER_GATEWAY_HOST_RELEASE_SCHEMA) {
    fail("schema-mismatch", "Release manifest uses an unsupported schema.");
  }
  if (readString(value, "component", label) !== PROVIDER_GATEWAY_HOST_CRATE) {
    fail("identity-mismatch", "Release manifest names a different component.");
  }
  if (readString(value, "repository", label) !== PROVIDER_GATEWAY_HOST_RELEASE_REPOSITORY) {
    fail("identity-mismatch", "Release manifest names a different repository.");
  }
  const version = assertVersion(readString(value, "version", label), "Release manifest version");
  const releaseTag = readString(value, "releaseTag", label);
  if (parseProviderGatewayHostReleaseTag(releaseTag) !== version) {
    fail("identity-mismatch", "Release manifest tag and version disagree.");
  }
  if (readString(value, "checksumsFileName", label) !== providerGatewayHostChecksumsName(version)) {
    fail("identity-mismatch", "Release manifest names an unexpected checksums file.");
  }
  const rawArtifacts = value.artifacts;
  if (!Array.isArray(rawArtifacts)) {
    fail("manifest-invalid", "Release manifest artifacts must be an array.");
  }
  const staged = rawArtifacts.map((entry): StagedProviderGatewayHostArtifact => {
    if (!isRecord(entry)) fail("manifest-invalid", "Release manifest artifacts must be objects.");
    const triple = readString(entry, "triple", label);
    const target = findProviderGatewayHostTarget(triple);
    if (readString(entry, "os", label) !== target.os) {
      fail("identity-mismatch", `Artifact ${triple} declares the wrong operating system.`);
    }
    if (readString(entry, "arch", label) !== target.arch) {
      fail("identity-mismatch", `Artifact ${triple} declares the wrong architecture.`);
    }
    const fileName = providerGatewayHostAssetName(version, triple);
    if (readString(entry, "fileName", label) !== fileName) {
      fail("identity-mismatch", `Artifact ${triple} declares an unexpected file name.`);
    }
    if (readString(entry, "url", label) !== providerGatewayHostAssetUrl(releaseTag, fileName)) {
      fail("identity-mismatch", `Artifact ${triple} declares an unexpected download URL.`);
    }
    return {
      triple,
      byteLength: readInteger(entry, "byteLength", label, 1),
      sha256: assertSha256(readString(entry, "sha256", label), `Artifact ${triple} SHA-256`),
    };
  });
  return buildProviderGatewayHostReleaseManifest({
    version,
    sourceCommit: readString(value, "sourceCommit", label),
    license: readString(value, "license", label),
    staged,
  });
}

export function serializeProviderGatewayHostReleaseManifest(
  manifest: ProviderGatewayHostReleaseManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * GNU coreutils `sha256sum` format so `sha256sum --check` works verbatim next
 * to the downloaded assets. Binary mode (`*`) keeps Windows consumers honest.
 */
export function formatProviderGatewayHostChecksums(
  manifest: ProviderGatewayHostReleaseManifest,
): string {
  return `${manifest.artifacts
    .map((artifact) => `${artifact.sha256} *${artifact.fileName}`)
    .join("\n")}\n`;
}

export function parseProviderGatewayHostChecksums(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line);
    if (match === null) fail("checksums-invalid", "Checksum line is not in sha256sum format.");
    const [, digest, fileName] = match;
    if (digest === undefined || fileName === undefined) {
      fail("checksums-invalid", "Checksum line is not in sha256sum format.");
    }
    if (entries.has(fileName)) {
      fail("checksums-invalid", `Checksum file lists ${fileName} more than once.`);
    }
    entries.set(fileName, digest);
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/* Consumer pin                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The pin a consumer checks in. `unreleased` is a first-class state: it records
 * that no gateway host release exists yet, so the resolver must report an unmet
 * pin instead of pretending a digest is available. It is NOT a licence to
 * download something unverified.
 */
export type ProviderGatewayHostPinStatus = "pinned" | "unreleased";

export interface ProviderGatewayHostPin {
  readonly schema: typeof PROVIDER_GATEWAY_HOST_PIN_SCHEMA;
  readonly component: typeof PROVIDER_GATEWAY_HOST_CRATE;
  readonly status: ProviderGatewayHostPinStatus;
  /** Present only when `status === "pinned"`. */
  readonly release?: {
    readonly version: string;
    readonly releaseTag: string;
    readonly sourceCommit: string;
    readonly manifestFileName: string;
    readonly manifestUrl: string;
    readonly manifestByteLength: number;
    readonly manifestSha256: string;
    readonly artifacts: readonly ProviderGatewayHostArtifactRecord[];
  };
  /** Human-readable reason recorded while `status === "unreleased"`. */
  readonly unreleasedReason?: string;
}

export function decodeProviderGatewayHostPin(value: unknown): ProviderGatewayHostPin {
  if (!isRecord(value)) fail("pin-invalid", "Gateway host pin must be a JSON object.");
  const label = "Gateway host pin";
  if (readString(value, "schema", label) !== PROVIDER_GATEWAY_HOST_PIN_SCHEMA) {
    fail("schema-mismatch", "Gateway host pin uses an unsupported schema.");
  }
  if (readString(value, "component", label) !== PROVIDER_GATEWAY_HOST_CRATE) {
    fail("identity-mismatch", "Gateway host pin names a different component.");
  }
  const status = readString(value, "status", label);
  if (status !== "pinned" && status !== "unreleased") {
    fail("pin-invalid", "Gateway host pin status must be 'pinned' or 'unreleased'.");
  }
  if (status === "unreleased") {
    if (value.release !== undefined) {
      fail("pin-invalid", "An unreleased gateway host pin must not carry release material.");
    }
    return {
      schema: PROVIDER_GATEWAY_HOST_PIN_SCHEMA,
      component: PROVIDER_GATEWAY_HOST_CRATE,
      status,
      unreleasedReason: readString(value, "unreleasedReason", label),
    };
  }

  const release = value.release;
  if (!isRecord(release)) fail("pin-invalid", "A pinned gateway host pin must carry a release.");
  const version = assertVersion(readString(release, "version", label), "Pinned version");
  const releaseTag = readString(release, "releaseTag", label);
  if (parseProviderGatewayHostReleaseTag(releaseTag) !== version) {
    fail("identity-mismatch", "Pinned tag and version disagree.");
  }
  const manifestFileName = providerGatewayHostManifestName(version);
  if (readString(release, "manifestFileName", label) !== manifestFileName) {
    fail("identity-mismatch", "Pinned manifest file name does not follow the artifact contract.");
  }
  if (
    readString(release, "manifestUrl", label) !==
    providerGatewayHostAssetUrl(releaseTag, manifestFileName)
  ) {
    fail("identity-mismatch", "Pinned manifest URL does not follow the artifact contract.");
  }
  const rawArtifacts = release.artifacts;
  if (!Array.isArray(rawArtifacts)) fail("pin-invalid", "Pinned artifacts must be an array.");
  const manifest = decodeProviderGatewayHostReleaseManifest({
    schema: PROVIDER_GATEWAY_HOST_RELEASE_SCHEMA,
    component: PROVIDER_GATEWAY_HOST_CRATE,
    version,
    releaseTag,
    sourceCommit: readString(release, "sourceCommit", label),
    repository: PROVIDER_GATEWAY_HOST_RELEASE_REPOSITORY,
    license: "pin",
    checksumsFileName: providerGatewayHostChecksumsName(version),
    artifacts: rawArtifacts,
  });

  return {
    schema: PROVIDER_GATEWAY_HOST_PIN_SCHEMA,
    component: PROVIDER_GATEWAY_HOST_CRATE,
    status,
    release: {
      version,
      releaseTag,
      sourceCommit: manifest.sourceCommit,
      manifestFileName,
      manifestUrl: providerGatewayHostAssetUrl(releaseTag, manifestFileName),
      manifestByteLength: readInteger(release, "manifestByteLength", label, 1),
      manifestSha256: assertSha256(
        readString(release, "manifestSha256", label),
        "Pinned manifest SHA-256",
      ),
      artifacts: manifest.artifacts,
    },
  };
}

/**
 * Build the pin body a maintainer commits after a release is published. Callers
 * pass the published manifest bytes so the pin records the manifest digest the
 * consumer will re-verify.
 */
export function buildProviderGatewayHostPin(input: {
  readonly manifest: ProviderGatewayHostReleaseManifest;
  readonly manifestBytes: Uint8Array;
}): ProviderGatewayHostPin {
  const { manifest, manifestBytes } = input;
  const manifestFileName = providerGatewayHostManifestName(manifest.version);
  return decodeProviderGatewayHostPin({
    schema: PROVIDER_GATEWAY_HOST_PIN_SCHEMA,
    component: PROVIDER_GATEWAY_HOST_CRATE,
    status: "pinned",
    release: {
      version: manifest.version,
      releaseTag: manifest.releaseTag,
      sourceCommit: manifest.sourceCommit,
      manifestFileName,
      manifestUrl: providerGatewayHostAssetUrl(manifest.releaseTag, manifestFileName),
      manifestByteLength: manifestBytes.byteLength,
      manifestSha256: digestBytes(manifestBytes),
      artifacts: manifest.artifacts,
    },
  });
}

export function serializeProviderGatewayHostPin(pin: ProviderGatewayHostPin): string {
  return `${JSON.stringify(pin, null, 2)}\n`;
}
