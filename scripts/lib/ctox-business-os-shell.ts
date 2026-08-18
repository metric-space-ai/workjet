// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off - Release preparation needs byte-level archive validation and bounded HTTP streaming before entering an Effect runtime.

import { createHash, randomBytes } from "node:crypto";
import { constants as NodeFSConstants, createReadStream } from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

import pinnedManifestJson from "../../apps/desktop/resources/ctox/business-os-shell.manifest.json" with { type: "json" };

export const CTOX_BUSINESS_OS_SHELL_SCHEMA = "ctox.business-os-shell.v1";
export const CTOX_BUSINESS_OS_SHELL_MANIFEST_URL =
  "https://github.com/metric-space-ai/ctox/releases/download/business-os-shell-v0.1.0-rc.8/ctox-business-os-shell-0.1.0-rc.8.manifest.json";
export const CTOX_BUSINESS_OS_SHELL_ARCHIVE_URL =
  "https://github.com/metric-space-ai/ctox/releases/download/business-os-shell-v0.1.0-rc.8/ctox-business-os-shell-0.1.0-rc.8.tar.gz";
export const CTOX_BUSINESS_OS_SHELL_DEPENDENCY_ROOT_ENV =
  "T3CODE_CTOX_BUSINESS_OS_SHELL_DEPENDENCY_ROOT";
export const CTOX_BUSINESS_OS_SHELL_EMBEDDED_MANIFEST = "ctox-shell-manifest.json";
export const CTOX_BUSINESS_OS_SHELL_COMPLETION_SENTINEL = ".ctox-business-os-shell.complete.json";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const ALLOWED_REDIRECT_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com"]);
const LOCK_RETRY_MS = 50;
const LOCK_ATTEMPTS = 1_200;
const STALE_LOCK_MS = 30 * 60 * 1_000;

export interface CtoxBusinessOsShellBudgets {
  readonly maxManifestBytes: number;
  readonly maxArchiveBytes: number;
  readonly maxTarEntries: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalFileBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxPathBytes: number;
}

export interface CtoxBusinessOsShellReleaseManifest {
  readonly schema: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly manifestUrl: string;
  readonly manifestByteLength: number;
  readonly manifestSha256: string;
  readonly archiveUrl: string;
  readonly archiveFilename: string;
  readonly archiveRoot: string;
  readonly entry: string;
  readonly archiveByteLength: number;
  readonly archiveSha256: string;
  readonly embeddedManifestSha256: string;
  readonly fileCount: number;
  readonly maxRedirects: number;
  readonly requestTimeoutMs: number;
  readonly budgets: CtoxBusinessOsShellBudgets;
}

interface InventoryRecord {
  readonly path: string;
  readonly byteSize: number;
  readonly sha256: string;
}

interface EmbeddedManifest {
  readonly schema: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly entry: string;
  readonly archiveRoot: string;
  readonly files: ReadonlyArray<InventoryRecord>;
}

interface DetachedManifest extends EmbeddedManifest {
  readonly archiveFilename: string;
  readonly archiveByteLength: number;
  readonly archiveSha256: string;
  readonly embeddedManifestSha256: string;
}

interface TarEntry {
  readonly path: string;
  readonly relativePath: string | undefined;
  readonly type: "file" | "directory";
  readonly size: number;
}

interface ValidatedArchive {
  readonly entries: ReadonlyArray<TarEntry>;
  readonly embeddedManifestBytes: Buffer;
}

interface DownloadExpectation {
  readonly byteLength: number;
  readonly sha256: string;
  readonly maxBytes: number;
}

export interface CtoxBusinessOsShellFetchRequest {
  readonly redirect: "manual";
  readonly signal: AbortSignal;
  readonly headers: Readonly<Record<string, string>>;
}

export type CtoxBusinessOsShellFetch = (
  url: string,
  request: CtoxBusinessOsShellFetchRequest,
) => Promise<Response>;

export interface PrepareCtoxBusinessOsShellOptions {
  readonly dependencyRoot?: string;
  readonly repoRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: CtoxBusinessOsShellFetch;
}

interface PrepareCtoxBusinessOsShellInternalOptions extends PrepareCtoxBusinessOsShellOptions {
  readonly releaseManifest: CtoxBusinessOsShellReleaseManifest;
}

export interface PreparedCtoxBusinessOsShell {
  readonly installPath: string;
  readonly cache: "hit" | "installed";
}

export class CtoxBusinessOsShellError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CtoxBusinessOsShellError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new CtoxBusinessOsShellError(code, message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string")
    fail("manifest-invalid", `Manifest field ${key} must be a string.`);
  return value;
}

function readInteger(record: Record<string, unknown>, key: string, minimum = 0): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum) {
    fail("manifest-invalid", `Manifest field ${key} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    fail("manifest-invalid", `${label} is not valid UTF-8 JSON.`, cause);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value))
    fail("manifest-invalid", `${label} must be a lowercase SHA-256.`);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function validateCanonicalRelativePath(relativePath: string, maxPathBytes: number): string {
  if (relativePath.length === 0) fail("path-invalid", "Archive paths must not be empty.");
  if (Buffer.byteLength(relativePath) > maxPathBytes) {
    fail("budget-exceeded", "Archive path exceeds the configured byte budget.");
  }
  if (relativePath.includes("\\") || hasControlCharacter(relativePath)) {
    fail("path-invalid", "Archive path contains a forbidden character.");
  }
  if (
    NodePath.posix.isAbsolute(relativePath) ||
    NodePath.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/u.test(relativePath)
  ) {
    fail("path-invalid", "Archive path must be relative.");
  }
  if (relativePath !== relativePath.normalize("NFC")) {
    fail("path-invalid", "Archive path must be Unicode-normalized.");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("path-invalid", "Archive path must be canonical and confined.");
  }
  if (NodePath.posix.normalize(relativePath) !== relativePath) {
    fail("path-invalid", "Archive path must be canonical.");
  }
  return relativePath;
}

function parseInventory(value: unknown, maxPathBytes: number): ReadonlyArray<InventoryRecord> {
  if (!Array.isArray(value)) fail("manifest-invalid", "Manifest files must be an array.");
  const seen = new Set<string>();
  const records: InventoryRecord[] = [];
  for (const item of value) {
    if (!isRecord(item)) fail("manifest-invalid", "Manifest inventory entries must be objects.");
    const path = validateCanonicalRelativePath(readString(item, "path"), maxPathBytes);
    const byteSize = readInteger(item, "byteSize");
    const sha256Value = readString(item, "sha256");
    assertSha256(sha256Value, "Inventory SHA-256");
    if (seen.has(path)) fail("duplicate-path", "Manifest inventory contains a duplicate path.");
    seen.add(path);
    records.push({ path, byteSize, sha256: sha256Value });
  }
  return records;
}

function validateEmbeddedIdentity(
  embedded: EmbeddedManifest,
  release: CtoxBusinessOsShellReleaseManifest,
  label: string,
): void {
  if (
    embedded.schema !== release.schema ||
    embedded.version !== release.version ||
    embedded.sourceCommit !== release.sourceCommit ||
    embedded.entry !== release.entry ||
    embedded.archiveRoot !== release.archiveRoot
  ) {
    fail("identity-mismatch", `${label} identity does not match the pinned release.`);
  }
  if (embedded.files.length !== release.fileCount) {
    fail("inventory-mismatch", `${label} file count does not match the pinned release.`);
  }
  if (!embedded.files.some((file) => file.path === release.entry)) {
    fail("inventory-mismatch", `${label} does not inventory the configured entry point.`);
  }
  if (embedded.files.length > release.budgets.maxFiles) {
    fail("budget-exceeded", `${label} exceeds the configured file budget.`);
  }
  let totalBytes = 0;
  for (const file of embedded.files) {
    if (file.byteSize > release.budgets.maxFileBytes) {
      fail("budget-exceeded", `${label} contains a file larger than the configured budget.`);
    }
    totalBytes += file.byteSize;
    if (totalBytes > release.budgets.maxTotalFileBytes) {
      fail("budget-exceeded", `${label} exceeds the configured payload budget.`);
    }
  }
}

function parseEmbeddedManifest(
  bytes: Uint8Array,
  release: CtoxBusinessOsShellReleaseManifest,
  label: string,
): EmbeddedManifest {
  const value = parseJson(bytes, label);
  if (!isRecord(value)) fail("manifest-invalid", `${label} must be a JSON object.`);
  const embedded: EmbeddedManifest = {
    schema: readString(value, "schema"),
    version: readString(value, "version"),
    sourceCommit: readString(value, "sourceCommit"),
    entry: readString(value, "entry"),
    archiveRoot: readString(value, "archiveRoot"),
    files: parseInventory(value.files, release.budgets.maxPathBytes),
  };
  validateEmbeddedIdentity(embedded, release, label);
  return embedded;
}

function parseDetachedManifest(
  bytes: Uint8Array,
  release: CtoxBusinessOsShellReleaseManifest,
): DetachedManifest {
  const value = parseJson(bytes, "Detached shell manifest");
  if (!isRecord(value)) fail("manifest-invalid", "Detached shell manifest must be a JSON object.");
  const embedded = parseEmbeddedManifest(bytes, release, "Detached shell manifest");
  const detached: DetachedManifest = {
    ...embedded,
    archiveFilename: readString(value, "archiveFilename"),
    archiveByteLength: readInteger(value, "archiveByteLength", 1),
    archiveSha256: readString(value, "archiveSha256"),
    embeddedManifestSha256: readString(value, "embeddedManifestSha256"),
  };
  assertSha256(detached.archiveSha256, "Detached archive SHA-256");
  assertSha256(detached.embeddedManifestSha256, "Detached embedded-manifest SHA-256");
  if (
    detached.archiveFilename !== release.archiveFilename ||
    detached.archiveByteLength !== release.archiveByteLength ||
    detached.archiveSha256 !== release.archiveSha256 ||
    detached.embeddedManifestSha256 !== release.embeddedManifestSha256
  ) {
    fail("identity-mismatch", "Detached shell manifest does not match the pinned archive.");
  }
  return detached;
}

function readBudgets(value: unknown): CtoxBusinessOsShellBudgets {
  if (!isRecord(value)) fail("manifest-invalid", "Pinned extraction budgets must be an object.");
  return {
    maxManifestBytes: readInteger(value, "maxManifestBytes", 1),
    maxArchiveBytes: readInteger(value, "maxArchiveBytes", 1),
    maxTarEntries: readInteger(value, "maxTarEntries", 1),
    maxFiles: readInteger(value, "maxFiles", 1),
    maxFileBytes: readInteger(value, "maxFileBytes", 1),
    maxTotalFileBytes: readInteger(value, "maxTotalFileBytes", 1),
    maxExpandedBytes: readInteger(value, "maxExpandedBytes", 1),
    maxPathBytes: readInteger(value, "maxPathBytes", 1),
  };
}

function validatePinnedReleaseUrl(value: string, expected: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    fail("url-invalid", "Pinned release URL is invalid.", cause);
  }
  if (
    value !== expected ||
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    fail("url-invalid", "Only the pinned HTTPS GitHub release URL is accepted.");
  }
  return url;
}

export function decodeCtoxBusinessOsShellReleaseManifest(
  value: unknown,
): CtoxBusinessOsShellReleaseManifest {
  if (!isRecord(value)) fail("manifest-invalid", "Pinned shell manifest must be an object.");
  const release: CtoxBusinessOsShellReleaseManifest = {
    schema: readString(value, "schema"),
    version: readString(value, "version"),
    sourceCommit: readString(value, "sourceCommit"),
    manifestUrl: readString(value, "manifestUrl"),
    manifestByteLength: readInteger(value, "manifestByteLength", 1),
    manifestSha256: readString(value, "manifestSha256"),
    archiveUrl: readString(value, "archiveUrl"),
    archiveFilename: readString(value, "archiveFilename"),
    archiveRoot: readString(value, "archiveRoot"),
    entry: readString(value, "entry"),
    archiveByteLength: readInteger(value, "archiveByteLength", 1),
    archiveSha256: readString(value, "archiveSha256"),
    embeddedManifestSha256: readString(value, "embeddedManifestSha256"),
    fileCount: readInteger(value, "fileCount", 1),
    maxRedirects: readInteger(value, "maxRedirects"),
    requestTimeoutMs: readInteger(value, "requestTimeoutMs", 1),
    budgets: readBudgets(value.budgets),
  };
  if (release.schema !== CTOX_BUSINESS_OS_SHELL_SCHEMA) {
    fail("identity-mismatch", "Pinned shell manifest uses an unsupported schema.");
  }
  if (!SOURCE_COMMIT_PATTERN.test(release.sourceCommit)) {
    fail("manifest-invalid", "Pinned source commit must be 40 lowercase hexadecimal characters.");
  }
  assertSha256(release.manifestSha256, "Pinned detached-manifest SHA-256");
  assertSha256(release.archiveSha256, "Pinned archive SHA-256");
  assertSha256(release.embeddedManifestSha256, "Pinned embedded-manifest SHA-256");
  validateCanonicalRelativePath(release.archiveRoot, release.budgets.maxPathBytes);
  validateCanonicalRelativePath(release.entry, release.budgets.maxPathBytes);
  validatePinnedReleaseUrl(release.manifestUrl, CTOX_BUSINESS_OS_SHELL_MANIFEST_URL);
  validatePinnedReleaseUrl(release.archiveUrl, CTOX_BUSINESS_OS_SHELL_ARCHIVE_URL);
  if (release.archiveByteLength > release.budgets.maxArchiveBytes) {
    fail("budget-exceeded", "Pinned archive exceeds its configured download budget.");
  }
  if (release.manifestByteLength > release.budgets.maxManifestBytes) {
    fail("budget-exceeded", "Pinned detached manifest exceeds its configured download budget.");
  }
  if (release.fileCount > release.budgets.maxFiles) {
    fail("budget-exceeded", "Pinned file count exceeds its configured extraction budget.");
  }
  return release;
}

export const CTOX_BUSINESS_OS_SHELL_RELEASE =
  decodeCtoxBusinessOsShellReleaseManifest(pinnedManifestJson);

function validateRedirectUrl(value: string, base: string): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    fail("redirect-invalid", "Release download returned an invalid redirect.");
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !ALLOWED_REDIRECT_HOSTS.has(url.hostname)
  ) {
    fail("redirect-invalid", "Release download redirected outside approved HTTPS GitHub hosts.");
  }
  return url;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function removePath(targetPath: string): Promise<void> {
  await NodeFSP.rm(targetPath, { recursive: true, force: true });
}

async function downloadVerified(
  url: string,
  destinationPath: string,
  expectation: DownloadExpectation,
  release: CtoxBusinessOsShellReleaseManifest,
  fetchImpl: CtoxBusinessOsShellFetch,
): Promise<void> {
  let currentUrl = validatePinnedReleaseUrl(url, url).href;
  let response: Response | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), release.requestTimeoutMs);
  try {
    for (let redirects = 0; redirects <= release.maxRedirects; redirects += 1) {
      response = await fetchImpl(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "t3code-ctox-business-os-shell-preparer/1",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        if (redirects === release.maxRedirects) {
          fail("redirect-limit", "Release download exceeded the redirect limit.");
        }
        const location = response.headers.get("location");
        if (location === null) fail("redirect-invalid", "Release redirect omitted its location.");
        currentUrl = validateRedirectUrl(location, currentUrl).href;
        continue;
      }
      break;
    }
    if (response === undefined || response.status !== 200) {
      fail("download-failed", "Release download returned a non-success status.");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        fail("download-failed", "Release download returned an invalid content length.");
      }
      if (parsedLength !== expectation.byteLength || parsedLength > expectation.maxBytes) {
        fail("download-mismatch", "Release download content length does not match the pin.");
      }
    }
    if (response.body === null) fail("download-failed", "Release download returned no body.");

    const file = await NodeFSP.open(destinationPath, "wx", 0o600);
    const hash = createHash("sha256");
    let byteLength = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        byteLength += chunk.byteLength;
        if (byteLength > expectation.maxBytes || byteLength > expectation.byteLength) {
          await reader.cancel();
          fail("budget-exceeded", "Release download exceeded its byte budget.");
        }
        hash.update(chunk);
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
    if (byteLength !== expectation.byteLength || hash.digest("hex") !== expectation.sha256) {
      fail(
        "download-mismatch",
        "Release download bytes do not match the pinned length and SHA-256.",
      );
    }
  } catch (cause) {
    await removePath(destinationPath);
    if (cause instanceof CtoxBusinessOsShellError) throw cause;
    fail("download-failed", "Release download failed before verification completed.");
  } finally {
    clearTimeout(timeout);
  }
}

function readNullTerminatedUtf8(
  header: Buffer,
  offset: number,
  length: number,
  label: string,
): string {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const content = nul === -1 ? field : field.subarray(0, nul);
  if (nul !== -1 && field.subarray(nul).some((byte) => byte !== 0)) {
    fail("tar-invalid", `USTAR ${label} has bytes after its terminator.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (cause) {
    fail("tar-invalid", `USTAR ${label} is not valid UTF-8.`, cause);
  }
}

function parseOctal(
  header: Buffer,
  offset: number,
  length: number,
  label: string,
  allowEmpty = false,
): number {
  const field = header.subarray(offset, offset + length);
  if ((field[0] ?? 0) >= 0x80) fail("tar-invalid", `USTAR ${label} uses base-256 encoding.`);
  const text = field.toString("ascii");
  const digits = text.replaceAll("\0", " ").trim();
  if (allowEmpty && digits.length === 0) return 0;
  if (!/^[0-7]+$/u.test(digits)) {
    fail("tar-invalid", `USTAR ${label} is not canonical octal.`);
  }
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail("tar-invalid", `USTAR ${label} is invalid.`);
  return value;
}

function parseTarHeader(header: Buffer, release: CtoxBusinessOsShellReleaseManifest): TarEntry {
  if (header.subarray(257, 263).toString("binary") !== "ustar\0") {
    fail("tar-invalid", "Archive entry is not USTAR.");
  }
  if (header.subarray(263, 265).toString("binary") !== "00") {
    fail("tar-invalid", "Archive entry has an unsupported USTAR version.");
  }
  const expectedChecksum = parseOctal(header, 148, 8, "checksum");
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
  if (actualChecksum !== expectedChecksum)
    fail("tar-checksum", "Archive entry checksum is invalid.");

  parseOctal(header, 100, 8, "mode");
  parseOctal(header, 108, 8, "uid");
  parseOctal(header, 116, 8, "gid");
  const size = parseOctal(header, 124, 12, "size");
  parseOctal(header, 136, 12, "mtime");
  parseOctal(header, 329, 8, "device major", true);
  parseOctal(header, 337, 8, "device minor", true);

  if (header.subarray(157, 257).some((byte) => byte !== 0)) {
    fail("tar-invalid", "USTAR link names are forbidden.");
  }
  const typeByte = header[156];
  const type = typeByte === 0x30 ? "file" : typeByte === 0x35 ? "directory" : undefined;
  if (type === undefined) {
    fail("tar-entry-type", "Only USTAR regular files and directories are accepted.");
  }
  if (type === "directory" && size !== 0) fail("tar-invalid", "USTAR directories must be empty.");
  if (type === "file" && size > release.budgets.maxFileBytes) {
    fail("budget-exceeded", "Archive file exceeds the configured per-file budget.");
  }

  const name = readNullTerminatedUtf8(header, 0, 100, "name");
  const prefix = readNullTerminatedUtf8(header, 345, 155, "prefix");
  const rawPath = prefix.length > 0 ? `${prefix}/${name}` : name;
  const archivePath =
    type === "directory" && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (type === "file" && archivePath.endsWith("/")) {
    fail("tar-invalid", "USTAR regular file paths must not end in a slash.");
  }
  validateCanonicalRelativePath(archivePath, release.budgets.maxPathBytes);
  if (archivePath !== release.archiveRoot && !archivePath.startsWith(`${release.archiveRoot}/`)) {
    fail("path-invalid", "Archive entry is outside the pinned archive root.");
  }
  if (archivePath === release.archiveRoot && type !== "directory") {
    fail("tar-invalid", "Pinned archive root must be a directory.");
  }
  const relativePath =
    archivePath === release.archiveRoot
      ? undefined
      : archivePath.slice(release.archiveRoot.length + 1);
  return { path: archivePath, relativePath, type, size };
}

interface TarVisitor {
  readonly onEntry?: (entry: TarEntry, index: number) => Promise<void> | void;
  readonly onFileChunk?: (entry: TarEntry, chunk: Buffer) => Promise<void> | void;
  readonly onFileEnd?: (entry: TarEntry) => Promise<void> | void;
}

async function parseGzipTar(
  archivePath: string,
  release: CtoxBusinessOsShellReleaseManifest,
  visitor: TarVisitor,
): Promise<ReadonlyArray<TarEntry>> {
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let pending = Buffer.alloc(0);
  let phase: "header" | "data" | "padding" | "ended" = "header";
  let activeEntry: TarEntry | undefined;
  let dataRemaining = 0;
  let paddingRemaining = 0;
  let zeroBlocks = 0;
  let fileCount = 0;
  let totalFileBytes = 0;
  let expandedBytes = 0;

  try {
    const gunzip = createReadStream(archivePath).pipe(createGunzip());
    for await (const rawChunk of gunzip) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      expandedBytes += chunk.length;
      if (expandedBytes > release.budgets.maxExpandedBytes) {
        fail("budget-exceeded", "Expanded archive exceeds the configured byte budget.");
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

      for (;;) {
        if (phase === "ended") {
          if (pending.some((byte) => byte !== 0)) {
            fail("tar-invalid", "Archive has non-zero data after its end marker.");
          }
          pending = Buffer.alloc(0);
          break;
        }
        if (phase === "header") {
          if (pending.length < 512) break;
          const header = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (header.every((byte) => byte === 0)) {
            zeroBlocks += 1;
            if (zeroBlocks === 2) phase = "ended";
            continue;
          }
          if (zeroBlocks !== 0) fail("tar-invalid", "Archive has only one zero end block.");
          const entry = parseTarHeader(header, release);
          if (seen.has(entry.path)) fail("duplicate-path", "Archive contains a duplicate path.");
          seen.add(entry.path);
          entries.push(entry);
          if (entries.length > release.budgets.maxTarEntries) {
            fail("budget-exceeded", "Archive exceeds the configured entry budget.");
          }
          if (entry.type === "file") {
            fileCount += 1;
            totalFileBytes += entry.size;
            if (fileCount > release.budgets.maxFiles + 1) {
              fail("budget-exceeded", "Archive exceeds the configured file budget.");
            }
            if (totalFileBytes > release.budgets.maxTotalFileBytes) {
              fail("budget-exceeded", "Archive exceeds the configured payload budget.");
            }
          }
          activeEntry = entry;
          dataRemaining = entry.size;
          paddingRemaining = (512 - (entry.size % 512)) % 512;
          await visitor.onEntry?.(entry, entries.length - 1);
          phase = dataRemaining > 0 ? "data" : paddingRemaining > 0 ? "padding" : "header";
          if (entry.type === "file" && dataRemaining === 0) await visitor.onFileEnd?.(entry);
          continue;
        }
        if (phase === "data") {
          if (pending.length === 0 || activeEntry === undefined) break;
          const take = Math.min(dataRemaining, pending.length);
          const data = pending.subarray(0, take);
          pending = pending.subarray(take);
          dataRemaining -= take;
          await visitor.onFileChunk?.(activeEntry, data);
          if (dataRemaining === 0) {
            await visitor.onFileEnd?.(activeEntry);
            phase = paddingRemaining > 0 ? "padding" : "header";
          }
          continue;
        }
        if (pending.length < paddingRemaining) break;
        const padding = pending.subarray(0, paddingRemaining);
        pending = pending.subarray(paddingRemaining);
        if (padding.some((byte) => byte !== 0))
          fail("tar-invalid", "Archive padding is not zeroed.");
        paddingRemaining = 0;
        phase = "header";
      }
    }
  } catch (cause) {
    if (cause instanceof CtoxBusinessOsShellError) throw cause;
    fail("tar-invalid", "Archive gzip or TAR stream is invalid.", cause);
  }

  if (phase !== "ended" || pending.length !== 0) {
    fail("tar-invalid", "Archive ended before a complete two-block TAR terminator.");
  }
  if (!seen.has(release.archiveRoot)) fail("tar-invalid", "Archive root directory is missing.");
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    if (entry.relativePath === undefined) continue;
    let parent = NodePath.posix.dirname(entry.path);
    while (parent !== ".") {
      const parentEntry = entryByPath.get(parent);
      if (parentEntry === undefined || parentEntry.type !== "directory") {
        fail("tar-invalid", "Archive entry parent directory is missing or not a directory.");
      }
      if (parent === release.archiveRoot) break;
      parent = NodePath.posix.dirname(parent);
    }
  }
  return entries;
}

async function validateArchive(
  archivePath: string,
  release: CtoxBusinessOsShellReleaseManifest,
): Promise<ValidatedArchive> {
  const embeddedChunks: Buffer[] = [];
  let embeddedBytes = 0;
  const embeddedPath = `${release.archiveRoot}/${CTOX_BUSINESS_OS_SHELL_EMBEDDED_MANIFEST}`;
  const entries = await parseGzipTar(archivePath, release, {
    onFileChunk(entry, chunk) {
      if (entry.path !== embeddedPath) return;
      embeddedBytes += chunk.length;
      if (embeddedBytes > release.budgets.maxManifestBytes) {
        fail("budget-exceeded", "Embedded manifest exceeds the configured byte budget.");
      }
      embeddedChunks.push(Buffer.from(chunk));
    },
  });
  const embeddedEntry = entries.find((entry) => entry.path === embeddedPath);
  if (embeddedEntry === undefined || embeddedEntry.type !== "file") {
    fail("manifest-missing", "Archive embedded manifest is missing.");
  }
  const regularFiles = entries.filter((entry) => entry.type === "file");
  if (regularFiles.length !== release.fileCount + 1) {
    fail("inventory-mismatch", "Archive regular-file count does not match the pinned inventory.");
  }
  return { entries, embeddedManifestBytes: Buffer.concat(embeddedChunks) };
}

function inventoriesEqual(
  left: ReadonlyArray<InventoryRecord>,
  right: ReadonlyArray<InventoryRecord>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((record, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      record.path === other.path &&
      record.byteSize === other.byteSize &&
      record.sha256 === other.sha256
    );
  });
}

function validateArchiveInventory(
  archive: ValidatedArchive,
  detached: DetachedManifest,
  release: CtoxBusinessOsShellReleaseManifest,
): EmbeddedManifest {
  if (sha256(archive.embeddedManifestBytes) !== release.embeddedManifestSha256) {
    fail("embedded-manifest-mismatch", "Embedded manifest SHA-256 does not match the pin.");
  }
  const embedded = parseEmbeddedManifest(
    archive.embeddedManifestBytes,
    release,
    "Embedded shell manifest",
  );
  if (!inventoriesEqual(embedded.files, detached.files)) {
    fail("inventory-mismatch", "Embedded and detached shell inventories differ.");
  }
  const archiveFiles = new Map(
    archive.entries
      .filter(
        (entry): entry is TarEntry & { readonly relativePath: string } =>
          entry.type === "file" &&
          entry.relativePath !== undefined &&
          entry.relativePath !== CTOX_BUSINESS_OS_SHELL_EMBEDDED_MANIFEST,
      )
      .map((entry) => [entry.relativePath, entry.size]),
  );
  for (const file of embedded.files) {
    if (archiveFiles.get(file.path) !== file.byteSize) {
      fail("inventory-mismatch", "Archive files and embedded inventory differ.");
    }
    archiveFiles.delete(file.path);
  }
  if (archiveFiles.size !== 0) fail("inventory-mismatch", "Archive contains unmanifested files.");
  return embedded;
}

function resolveInside(root: string, relativePath: string): string {
  const destination = NodePath.resolve(root, ...relativePath.split("/"));
  const prefix = root.endsWith(NodePath.sep) ? root : `${root}${NodePath.sep}`;
  if (!destination.startsWith(prefix))
    fail("path-invalid", "Resolved archive path escapes staging.");
  return destination;
}

async function extractValidatedArchive(
  archivePath: string,
  stagePath: string,
  validated: ValidatedArchive,
  release: CtoxBusinessOsShellReleaseManifest,
): Promise<void> {
  const directories = validated.entries
    .filter(
      (entry): entry is TarEntry & { readonly relativePath: string } =>
        entry.type === "directory" && entry.relativePath !== undefined,
    )
    .sort(
      (left, right) =>
        left.relativePath.split("/").length - right.relativePath.split("/").length ||
        left.relativePath.localeCompare(right.relativePath),
    );
  for (const entry of directories) {
    await NodeFSP.mkdir(resolveInside(stagePath, entry.relativePath), {
      recursive: false,
      mode: 0o755,
    });
  }
  let currentFile: NodeFSP.FileHandle | undefined;
  let expectedIndex = 0;
  try {
    await parseGzipTar(archivePath, release, {
      async onEntry(entry, index) {
        const expected = validated.entries[index];
        if (
          expected === undefined ||
          entry.path !== expected.path ||
          entry.relativePath !== expected.relativePath ||
          entry.type !== expected.type ||
          entry.size !== expected.size ||
          index !== expectedIndex
        ) {
          fail("tar-changed", "Archive changed between validation and extraction.");
        }
        expectedIndex += 1;
        if (entry.type === "file") {
          if (entry.relativePath === undefined)
            fail("tar-invalid", "Archive root cannot be a file.");
          currentFile = await NodeFSP.open(
            resolveInside(stagePath, entry.relativePath),
            "wx",
            0o644,
          );
        }
      },
      async onFileChunk(_entry, chunk) {
        if (currentFile === undefined)
          fail("tar-invalid", "Archive file stream has no destination.");
        await currentFile.write(chunk);
      },
      async onFileEnd() {
        if (currentFile !== undefined) {
          await currentFile.close();
          currentFile = undefined;
        }
      },
    });
  } finally {
    if (currentFile !== undefined) await currentFile.close();
  }
  if (expectedIndex !== validated.entries.length) {
    fail("tar-changed", "Archive entry count changed between validation and extraction.");
  }
}

async function hashFile(
  filePath: string,
  expectedByteSize: number,
): Promise<{ readonly byteSize: number; readonly sha256: string }> {
  const before = await NodeFSP.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedByteSize) {
    fail("cache-invalid", "Cached shell inventory entry is not a regular file.");
  }
  const noFollow = NodeFSConstants.O_NOFOLLOW ?? 0;
  const handle = await NodeFSP.open(filePath, NodeFSConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== expectedByteSize
    ) {
      fail("cache-invalid", "Cached shell file changed while being opened.");
    }
    const hash = createHash("sha256");
    let byteSize = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      byteSize += chunk.length;
      hash.update(chunk);
    }
    const after = await NodeFSP.lstat(filePath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== expectedByteSize
    ) {
      fail("cache-invalid", "Cached shell file changed while being verified.");
    }
    return { byteSize, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const before = await NodeFSP.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 0 || before.size > maxBytes) {
    fail("cache-invalid", "Cached shell metadata file exceeds its byte budget.");
  }
  const noFollow = NodeFSConstants.O_NOFOLLOW ?? 0;
  const handle = await NodeFSP.open(filePath, NodeFSConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      fail("cache-invalid", "Cached shell metadata changed while being opened.");
    }
    const bytes = await handle.readFile();
    const after = await NodeFSP.lstat(filePath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== bytes.length
    ) {
      fail("cache-invalid", "Cached shell metadata changed while being read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function collectInstallFiles(
  root: string,
  release: CtoxBusinessOsShellReleaseManifest,
): Promise<ReadonlyArray<string>> {
  const files: string[] = [];
  let entryCount = 0;
  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath =
        relativeDirectory.length > 0 ? `${relativeDirectory}/${entry.name}` : entry.name;
      validateCanonicalRelativePath(relativePath, release.budgets.maxPathBytes);
      entryCount += 1;
      if (entryCount > release.budgets.maxTarEntries + 1) {
        fail("cache-invalid", "Cached shell exceeds its entry budget.");
      }
      const absolutePath = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("cache-invalid", "Cached shell contains a symbolic link.");
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
        if (files.length > release.budgets.maxFiles + 2) {
          fail("cache-invalid", "Cached shell exceeds its file budget.");
        }
      } else {
        fail("cache-invalid", "Cached shell contains a special filesystem entry.");
      }
    }
  }
  await walk(root, "");
  files.sort();
  return files;
}

function completionSentinel(release: CtoxBusinessOsShellReleaseManifest): Record<string, unknown> {
  return {
    schema: release.schema,
    version: release.version,
    sourceCommit: release.sourceCommit,
    archiveRoot: release.archiveRoot,
    entry: release.entry,
    archiveSha256: release.archiveSha256,
    embeddedManifestSha256: release.embeddedManifestSha256,
    fileCount: release.fileCount,
  };
}

function recordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

async function verifyInstall(
  installPath: string,
  release: CtoxBusinessOsShellReleaseManifest,
): Promise<EmbeddedManifest> {
  const stat = await NodeFSP.lstat(installPath);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("cache-invalid", "Cached shell is not a directory.");

  const sentinelBytes = await readBoundedRegularFile(
    NodePath.join(installPath, CTOX_BUSINESS_OS_SHELL_COMPLETION_SENTINEL),
    16 * 1024,
  );
  const sentinel = parseJson(sentinelBytes, "Shell completion sentinel");
  if (!isRecord(sentinel) || !recordsEqual(sentinel, completionSentinel(release))) {
    fail("cache-invalid", "Cached shell completion sentinel does not match the pin.");
  }

  const embeddedPath = NodePath.join(installPath, CTOX_BUSINESS_OS_SHELL_EMBEDDED_MANIFEST);
  const embeddedBytes = await readBoundedRegularFile(
    embeddedPath,
    release.budgets.maxManifestBytes,
  );
  if (sha256(embeddedBytes) !== release.embeddedManifestSha256) {
    fail("cache-invalid", "Cached embedded manifest SHA-256 does not match the pin.");
  }
  const embedded = parseEmbeddedManifest(embeddedBytes, release, "Cached embedded shell manifest");

  const expected = new Map(embedded.files.map((file) => [file.path, file]));
  expected.set(CTOX_BUSINESS_OS_SHELL_EMBEDDED_MANIFEST, {
    path: CTOX_BUSINESS_OS_SHELL_EMBEDDED_MANIFEST,
    byteSize: embeddedBytes.length,
    sha256: release.embeddedManifestSha256,
  });
  const sentinelHash = sha256(sentinelBytes);
  expected.set(CTOX_BUSINESS_OS_SHELL_COMPLETION_SENTINEL, {
    path: CTOX_BUSINESS_OS_SHELL_COMPLETION_SENTINEL,
    byteSize: sentinelBytes.length,
    sha256: sentinelHash,
  });

  const actualFiles = await collectInstallFiles(installPath, release);
  if (actualFiles.length !== expected.size)
    fail("cache-invalid", "Cached shell has extra or missing files.");
  for (const relativePath of actualFiles) {
    const record = expected.get(relativePath);
    if (record === undefined) fail("cache-invalid", "Cached shell contains an unmanifested file.");
    const actual = await hashFile(resolveInside(installPath, relativePath), record.byteSize);
    if (actual.byteSize !== record.byteSize || actual.sha256 !== record.sha256) {
      fail("cache-invalid", "Cached shell file bytes do not match the embedded inventory.");
    }
    expected.delete(relativePath);
  }
  if (expected.size !== 0)
    fail("cache-invalid", "Cached shell is missing manifest inventory files.");
  return embedded;
}

async function isValidInstall(
  installPath: string,
  release: CtoxBusinessOsShellReleaseManifest,
): Promise<boolean> {
  try {
    await verifyInstall(installPath, release);
    return true;
  } catch {
    return false;
  }
}

function installPathFor(
  dependencyRoot: string,
  release: CtoxBusinessOsShellReleaseManifest,
): string {
  return NodePath.join(dependencyRoot, "ctox-business-os-shell", release.version);
}

function randomSuffix(): string {
  return `${process.pid}-${randomBytes(8).toString("hex")}`;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function acquirePublishLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await NodeFSP.mkdir(lockPath);
      return async () => removePath(lockPath);
    } catch (cause) {
      if (!isRecord(cause) || cause.code !== "EEXIST") throw cause;
      try {
        const stat = await NodeFSP.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await removePath(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  fail("publish-lock-timeout", "Timed out waiting to publish the verified shell install.");
}

async function publishInstall(
  stagePath: string,
  installPath: string,
  release: CtoxBusinessOsShellReleaseManifest,
): Promise<"hit" | "installed"> {
  const parent = NodePath.dirname(installPath);
  const lockPath = NodePath.join(parent, ".publish.lock");
  const releaseLock = await acquirePublishLock(lockPath);
  try {
    if (await isValidInstall(installPath, release)) return "hit";
    await removePath(installPath);
    await NodeFSP.rename(stagePath, installPath);
    return "installed";
  } finally {
    await releaseLock();
  }
}

function resolveRepoRoot(explicitRepoRoot: string | undefined): string {
  return explicitRepoRoot === undefined
    ? fileURLToPath(new URL("../..", import.meta.url))
    : NodePath.resolve(explicitRepoRoot);
}

export function resolveCtoxBusinessOsShellDependencyRoot(
  options: Pick<PrepareCtoxBusinessOsShellOptions, "dependencyRoot" | "repoRoot" | "env"> = {},
): string {
  const repoRoot = resolveRepoRoot(options.repoRoot);
  const env = options.env ?? process.env;
  const configured = options.dependencyRoot ?? env[CTOX_BUSINESS_OS_SHELL_DEPENDENCY_ROOT_ENV];
  return configured === undefined || configured.trim() === ""
    ? NodePath.join(repoRoot, ".deps")
    : NodePath.resolve(repoRoot, configured);
}

async function prepareWithManifest(
  options: PrepareCtoxBusinessOsShellInternalOptions,
): Promise<PreparedCtoxBusinessOsShell> {
  const release = decodeCtoxBusinessOsShellReleaseManifest(options.releaseManifest);
  const dependencyRoot = resolveCtoxBusinessOsShellDependencyRoot(options);
  const installPath = installPathFor(dependencyRoot, release);
  if (await isValidInstall(installPath, release)) return { installPath, cache: "hit" };

  const fetchImpl: CtoxBusinessOsShellFetch =
    options.fetch ?? ((url, request) => fetch(url, request));
  const installParent = NodePath.dirname(installPath);
  await NodeFSP.mkdir(installParent, { recursive: true });
  const workPath = NodePath.join(installParent, `.prepare-${randomSuffix()}`);
  const extractPath = NodePath.join(installParent, `.install-${randomSuffix()}`);
  const manifestPath = NodePath.join(workPath, "release.manifest.json");
  const archivePath = NodePath.join(workPath, release.archiveFilename);
  await NodeFSP.mkdir(workPath, { mode: 0o700 });
  try {
    await downloadVerified(
      release.manifestUrl,
      manifestPath,
      {
        byteLength: release.manifestByteLength,
        sha256: release.manifestSha256,
        maxBytes: release.budgets.maxManifestBytes,
      },
      release,
      fetchImpl,
    );
    const detachedBytes = await NodeFSP.readFile(manifestPath);
    const detached = parseDetachedManifest(detachedBytes, release);

    await downloadVerified(
      release.archiveUrl,
      archivePath,
      {
        byteLength: release.archiveByteLength,
        sha256: release.archiveSha256,
        maxBytes: release.budgets.maxArchiveBytes,
      },
      release,
      fetchImpl,
    );
    const archive = await validateArchive(archivePath, release);
    validateArchiveInventory(archive, detached, release);

    await NodeFSP.mkdir(extractPath, { mode: 0o755 });
    await extractValidatedArchive(archivePath, extractPath, archive, release);
    const sentinelBytes = Buffer.from(`${JSON.stringify(completionSentinel(release))}\n`);
    await NodeFSP.writeFile(
      NodePath.join(extractPath, CTOX_BUSINESS_OS_SHELL_COMPLETION_SENTINEL),
      sentinelBytes,
      { flag: "wx", mode: 0o644 },
    );
    await verifyInstall(extractPath, release);

    const cache = await publishInstall(extractPath, installPath, release);
    return { installPath, cache };
  } catch (cause) {
    if (cause instanceof CtoxBusinessOsShellError) throw cause;
    fail("prepare-failed", "Failed to prepare the verified Business OS shell.", cause);
  } finally {
    await Promise.allSettled([removePath(workPath), removePath(extractPath)]);
  }
}

export async function prepareCtoxBusinessOsShell(
  options: PrepareCtoxBusinessOsShellOptions = {},
): Promise<PreparedCtoxBusinessOsShell> {
  return prepareWithManifest({ ...options, releaseManifest: CTOX_BUSINESS_OS_SHELL_RELEASE });
}

/** Test-only entry point for tiny synthetic archives; production callers always use the tracked pin. */
export async function prepareCtoxBusinessOsShellForTest(
  options: PrepareCtoxBusinessOsShellOptions & {
    readonly releaseManifest: CtoxBusinessOsShellReleaseManifest;
  },
): Promise<PreparedCtoxBusinessOsShell> {
  return prepareWithManifest(options);
}

export async function verifyCtoxBusinessOsShellInstall(
  installPath: string,
  releaseManifest: CtoxBusinessOsShellReleaseManifest = CTOX_BUSINESS_OS_SHELL_RELEASE,
): Promise<void> {
  await verifyInstall(installPath, decodeCtoxBusinessOsShellReleaseManifest(releaseManifest));
}
