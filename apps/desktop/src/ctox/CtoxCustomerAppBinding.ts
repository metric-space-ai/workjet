// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Electron verifies a tiny detached JSON signature contract before exposing instance-owned app assets.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const BINDING_FILE = "customer-app-binding.json";
const BINDING_TYPE = "ctox.business-os.customer-app-binding.v1";
const MAX_BINDING_BYTES = 64 * 1024;
const MAX_PACKAGE_FILES = 20_000;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;

export const CTOX_CUSTOMER_APP_TRUST_KEYS = {
  "customer-app-current-2026-08": "MCowBQYDK2VwAyEAZECH2XB0VlZWQ7zUzoChyiRkKtfGNK9HmSMvZQuwGjk=",
  "customer-app-next-2026-08": "MCowBQYDK2VwAyEAdAgcqbHB2Sr86KzrWcdYxKCxb6Ofz4sVxhkEhTgvo7s=",
} as const;

type CustomerAppTrustKeys = Readonly<Record<string, string>>;

interface CustomerAppBindingPayload {
  readonly type: typeof BINDING_TYPE;
  readonly customerId: string;
  readonly moduleId: string;
  readonly allowedInstanceIds: readonly string[];
  readonly packageVersion: string;
  readonly packageSha256: string;
  readonly signingKeyId: string;
}

interface CustomerAppBinding extends CustomerAppBindingPayload {
  readonly signature: string;
}

const PUBLIC_SCOPES = new Set(["public", "global", "system", "store", "internal", "shared"]);
const BINDING_KEYS = new Set([
  "type",
  "customerId",
  "moduleId",
  "allowedInstanceIds",
  "packageVersion",
  "packageSha256",
  "signingKeyId",
  "signature",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonFile(path: string, maxBytes: number): unknown {
  const stat = NodeFS.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) {
    throw new Error("invalid-json-file");
  }
  return JSON.parse(NodeFS.readFileSync(path, "utf8"));
}

function manifestRequiresBinding(manifest: Record<string, unknown>): boolean {
  const moduleId = typeof manifest.id === "string" ? manifest.id.trim().toLowerCase() : "";
  if (moduleId.startsWith("rem-") || moduleId.startsWith("thesen-")) return true;
  const customerId = manifest.customerId ?? manifest.customer_id;
  if (customerId !== undefined) {
    if (typeof customerId !== "string" || customerId.trim().length === 0) return true;
    return true;
  }
  for (const field of ["distribution", "audience", "visibility"] as const) {
    const raw = manifest[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || raw.trim().length === 0) return true;
    if (!PUBLIC_SCOPES.has(raw.trim().toLowerCase())) return true;
  }
  return false;
}

function parseBinding(value: unknown): CustomerAppBinding {
  if (!isRecord(value) || Object.keys(value).some((key) => !BINDING_KEYS.has(key))) {
    throw new Error("customer-app-binding-invalid");
  }
  const allowedInstanceIds = value.allowedInstanceIds;
  if (
    value.type !== BINDING_TYPE ||
    typeof value.customerId !== "string" ||
    typeof value.moduleId !== "string" ||
    !Array.isArray(allowedInstanceIds) ||
    !allowedInstanceIds.every((entry) => typeof entry === "string") ||
    typeof value.packageVersion !== "string" ||
    typeof value.packageSha256 !== "string" ||
    typeof value.signingKeyId !== "string" ||
    typeof value.signature !== "string"
  ) {
    throw new Error("customer-app-binding-invalid");
  }
  return {
    type: BINDING_TYPE,
    customerId: value.customerId,
    moduleId: value.moduleId,
    allowedInstanceIds,
    packageVersion: value.packageVersion,
    packageSha256: value.packageSha256,
    signingKeyId: value.signingKeyId,
    signature: value.signature,
  };
}

function readProtectedInstanceId(instanceModuleRoot: string): string {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Synchronous filesystem trust boundary; the platform only selects whether POSIX mode bits are meaningful.
  const hostPlatform = process.platform;
  const path = NodePath.join(instanceModuleRoot, "..", "business-os-instance-id");
  const stat = NodeFS.lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (hostPlatform !== "win32" && (stat.mode & 0o022) !== 0)
  ) {
    throw new Error("customer-app-instance-id-insecure");
  }
  const value = NodeFS.readFileSync(path, "utf8").trim();
  if (value.length === 0) throw new Error("customer-app-instance-id-missing");
  return value;
}

export function ctoxCustomerPackageSha256(root: string): string {
  const hasher = NodeCrypto.createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (current: string): void => {
    const entries = NodeFS.readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    );
    for (const entry of entries) {
      if (current === root && entry.name === BINDING_FILE) continue;
      const path = NodePath.join(current, entry.name);
      const stat = NodeFS.lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("customer-app-package-symlink");
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error("customer-app-package-unsupported-entry");
      fileCount += 1;
      if (fileCount > MAX_PACKAGE_FILES) throw new Error("customer-app-package-too-many-files");
      const bytes = NodeFS.readFileSync(path);
      totalBytes += bytes.length;
      if (totalBytes > MAX_PACKAGE_BYTES) throw new Error("customer-app-package-too-large");
      const relative = NodePath.relative(root, path).split(NodePath.sep).join("/");
      const relativeBytes = Buffer.from(relative, "utf8");
      const relativeLength = Buffer.alloc(8);
      const contentLength = Buffer.alloc(8);
      relativeLength.writeBigUInt64LE(BigInt(relativeBytes.length));
      contentLength.writeBigUInt64LE(BigInt(bytes.length));
      hasher.update(relativeLength);
      hasher.update(relativeBytes);
      hasher.update(contentLength);
      hasher.update(bytes);
    }
  };
  visit(root);
  if (fileCount === 0) throw new Error("customer-app-package-empty");
  return hasher.digest("hex");
}

function canonicalPayload(binding: CustomerAppBinding): Buffer {
  const payload: CustomerAppBindingPayload = {
    type: binding.type,
    customerId: binding.customerId,
    moduleId: binding.moduleId,
    allowedInstanceIds: binding.allowedInstanceIds,
    packageVersion: binding.packageVersion,
    packageSha256: binding.packageSha256,
    signingKeyId: binding.signingKeyId,
  };
  return Buffer.from(JSON.stringify(payload), "utf8");
}

function verifyCustomerBinding(input: {
  readonly moduleDir: string;
  readonly manifest: Record<string, unknown>;
  readonly instanceId: string;
  readonly trustKeys: CustomerAppTrustKeys;
}): void {
  const binding = parseBinding(
    parseJsonFile(NodePath.join(input.moduleDir, BINDING_FILE), MAX_BINDING_BYTES),
  );
  const moduleId = typeof input.manifest.id === "string" ? input.manifest.id.trim() : "";
  const packageVersion =
    typeof input.manifest.version === "string" ? input.manifest.version.trim() : "";
  if (
    binding.customerId.trim().length === 0 ||
    moduleId.length === 0 ||
    binding.moduleId !== moduleId ||
    packageVersion.length === 0 ||
    binding.packageVersion !== packageVersion
  ) {
    throw new Error("customer-app-binding-package-identity-mismatch");
  }
  const allowed = new Set(binding.allowedInstanceIds.map((value) => value.trim()));
  if (
    allowed.size === 0 ||
    allowed.size !== binding.allowedInstanceIds.length ||
    allowed.has("") ||
    !allowed.has(input.instanceId)
  ) {
    throw new Error("customer-app-binding-instance-denied");
  }
  if (!/^[0-9a-f]{64}$/u.test(binding.packageSha256)) {
    throw new Error("customer-app-binding-invalid-hash");
  }
  if (ctoxCustomerPackageSha256(input.moduleDir) !== binding.packageSha256) {
    throw new Error("customer-app-binding-package-mismatch");
  }
  const encodedKey = input.trustKeys[binding.signingKeyId];
  if (encodedKey === undefined || !/^[0-9a-f]{128}$/u.test(binding.signature)) {
    throw new Error("customer-app-binding-untrusted");
  }
  const publicKey = NodeCrypto.createPublicKey({
    key: Buffer.from(encodedKey, "base64"),
    format: "der",
    type: "spki",
  });
  if (
    !NodeCrypto.verify(
      null,
      canonicalPayload(binding),
      publicKey,
      Buffer.from(binding.signature, "hex"),
    )
  ) {
    throw new Error("customer-app-binding-invalid-signature");
  }
}

export function authorizedCtoxRuntimeModuleKeys(
  instanceModuleRoot: string,
  trustKeys: CustomerAppTrustKeys = CTOX_CUSTOMER_APP_TRUST_KEYS,
): ReadonlySet<string> {
  const instanceId = readProtectedInstanceId(instanceModuleRoot);
  const authorized = new Set<string>();
  for (const source of ["installed-modules", "local-modules"] as const) {
    const sourceRoot = NodePath.join(instanceModuleRoot, source);
    if (!NodeFS.existsSync(sourceRoot)) continue;
    const sourceStat = NodeFS.lstatSync(sourceRoot);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) continue;
    for (const entry of NodeFS.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const moduleDir = NodePath.join(sourceRoot, entry.name);
      try {
        const manifestValue = parseJsonFile(NodePath.join(moduleDir, "module.json"), 1024 * 1024);
        if (!isRecord(manifestValue)) continue;
        const bindingPath = NodePath.join(moduleDir, BINDING_FILE);
        if (manifestRequiresBinding(manifestValue) || NodeFS.existsSync(bindingPath)) {
          verifyCustomerBinding({ moduleDir, manifest: manifestValue, instanceId, trustKeys });
        }
        authorized.add(`${source}/${entry.name}`);
      } catch {
        // Fail closed without logging customer identifiers or package contents.
      }
    }
  }
  return authorized;
}

export function ctoxRuntimeModuleKey(relative: string): string | undefined {
  const [source, moduleId] = relative.split("/", 3);
  if (!source || !moduleId || !["installed-modules", "local-modules"].includes(source)) {
    return undefined;
  }
  return `${source}/${moduleId}`;
}
