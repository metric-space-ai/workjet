import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export const BUSINESS_OS_SHELL_PACK_TYPE = "ctox.mobile.shell-pack.v1";

export interface BusinessOsShellPackFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface BusinessOsShellPackManifest {
  readonly type: typeof BUSINESS_OS_SHELL_PACK_TYPE;
  readonly packId: string;
  readonly businessOsRevision: string;
  readonly appVersion: string;
  readonly totalSize: number;
  readonly files: readonly BusinessOsShellPackFile[];
  readonly signingKeyId: string;
  readonly signature: string;
}

export class BusinessOsShellPackError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BusinessOsShellPackError";
  }
}

function fail(code: string, message: string): never {
  throw new BusinessOsShellPackError(code, message);
}

function isSafePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  );
}

function canonicalPayload(manifest: Omit<BusinessOsShellPackManifest, "signature">): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: manifest.type,
      packId: manifest.packId,
      businessOsRevision: manifest.businessOsRevision,
      appVersion: manifest.appVersion,
      totalSize: manifest.totalSize,
      files: manifest.files.map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
      })),
      signingKeyId: manifest.signingKeyId,
    }),
  );
}

export function shellPackSigningPayload(
  manifest: Omit<BusinessOsShellPackManifest, "signature">,
): Uint8Array {
  return canonicalPayload(manifest);
}

export function verifyBusinessOsShellPack(input: {
  readonly manifest: BusinessOsShellPackManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly publicKeys: ReadonlyMap<string, Uint8Array>;
  readonly expectedAppVersion: string;
  readonly expectedBusinessOsRevision: string;
}): BusinessOsShellPackManifest {
  const { manifest } = input;
  if (manifest.type !== BUSINESS_OS_SHELL_PACK_TYPE) fail("type", "Unsupported shell pack type.");
  if (!manifest.packId || !manifest.signingKeyId)
    fail("identity", "Shell pack identity is missing.");
  if (manifest.appVersion !== input.expectedAppVersion)
    fail("app-version", "Shell pack app version mismatch.");
  if (manifest.businessOsRevision !== input.expectedBusinessOsRevision) {
    fail("revision", "Shell pack Business OS revision mismatch.");
  }
  if (!Number.isSafeInteger(manifest.totalSize) || manifest.totalSize < 0) {
    fail("size", "Shell pack size is invalid.");
  }
  const paths = new Set<string>();
  let totalSize = 0;
  for (const file of manifest.files) {
    if (!isSafePath(file.path) || paths.has(file.path))
      fail("path", "Shell pack path is unsafe or duplicated.");
    paths.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/u.test(file.sha256)) {
      fail("file", "Shell pack file metadata is invalid.");
    }
    const bytes = input.files.get(file.path);
    if (!bytes || bytes.byteLength !== file.size || bytesToHex(sha256(bytes)) !== file.sha256) {
      fail("hash", `Shell pack file failed integrity validation: ${file.path}.`);
    }
    totalSize += file.size;
  }
  if (
    !paths.has("index.html") ||
    totalSize !== manifest.totalSize ||
    input.files.size !== paths.size
  ) {
    fail("completeness", "Shell pack is incomplete or contains undeclared files.");
  }
  const publicKey = input.publicKeys.get(manifest.signingKeyId);
  if (!publicKey) fail("key", "Shell pack signing key is not trusted.");
  let signature: Uint8Array;
  try {
    signature = hexToBytes(manifest.signature);
  } catch {
    return fail("signature", "Shell pack signature is invalid.");
  }
  const { signature: _, ...unsigned } = manifest;
  if (!ed25519.verify(signature, canonicalPayload(unsigned), publicKey)) {
    fail("signature", "Shell pack signature is invalid.");
  }
  return Object.freeze({ ...manifest, files: Object.freeze([...manifest.files]) });
}
