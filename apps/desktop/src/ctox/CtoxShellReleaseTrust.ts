// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - shell release verification is owned by Electron main.
import * as NodeCrypto from "node:crypto";

import {
  BusinessOsShellChannelPointerV1,
  BusinessOsShellReleaseManifestV2,
  type BusinessOsShellChannelPointerV1 as BusinessOsShellChannelPointer,
  type BusinessOsShellReleaseManifestV2 as BusinessOsShellReleaseManifest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const CTOX_STABLE_SHELL_CHANNEL_URL =
  "https://github.com/metric-space-ai/ctox/releases/download/business-os-shell-channel-stable/business-os-shell-stable.json";

export function officialBusinessOsShellReleaseManifestUrl(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("shell-release-version-invalid");
  }
  return `https://github.com/metric-space-ai/ctox/releases/download/business-os-shell-v${version}/ctox-business-os-shell-${version}.release.v2.json`;
}

export const BUSINESS_OS_SHELL_TRUST_KEYS = Object.freeze({
  "shell-current-2026-08": "MCowBQYDK2VwAyEAZECH2XB0VlZWQ7zUzoChyiRkKtfGNK9HmSMvZQuwGjk=",
  "shell-next-2026-08": "MCowBQYDK2VwAyEAdAgcqbHB2Sr86KzrWcdYxKCxb6Ofz4sVxhkEhTgvo7s=",
});

type TrustMap = Readonly<Record<string, string>>;

function canonicalPayload(value: Readonly<Record<string, unknown>>): Buffer {
  const { signature: _signature, ...payload } = value;
  return Buffer.from(JSON.stringify(payload), "utf8");
}

function verifySignature(value: Readonly<Record<string, unknown>>, trust: TrustMap): void {
  const keyId = typeof value.signingKeyId === "string" ? value.signingKeyId : "";
  const signature = typeof value.signature === "string" ? value.signature : "";
  const publicKeyBase64 = trust[keyId];
  if (publicKeyBase64 === undefined) throw new Error("shell-release-unknown-key");
  const publicKey = NodeCrypto.createPublicKey({
    key: Buffer.from(publicKeyBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (!NodeCrypto.verify(null, canonicalPayload(value), publicKey, Buffer.from(signature, "hex"))) {
    throw new Error("shell-release-invalid-signature");
  }
}

export function verifyBusinessOsShellChannelPointer(
  value: unknown,
  trust: TrustMap = BUSINESS_OS_SHELL_TRUST_KEYS,
): BusinessOsShellChannelPointer {
  const pointer = Schema.decodeUnknownSync(BusinessOsShellChannelPointerV1)(value, {
    onExcessProperty: "error",
  });
  verifySignature(pointer as unknown as Readonly<Record<string, unknown>>, trust);
  return pointer;
}

export function verifyBusinessOsShellReleaseManifest(
  value: unknown,
  trust: TrustMap = BUSINESS_OS_SHELL_TRUST_KEYS,
): BusinessOsShellReleaseManifest {
  const manifest = Schema.decodeUnknownSync(BusinessOsShellReleaseManifestV2)(value, {
    onExcessProperty: "error",
  });
  verifySignature(manifest as unknown as Readonly<Record<string, unknown>>, trust);
  return manifest;
}

async function fetchJsonBytes(fetchFn: typeof fetch, url: string): Promise<Buffer> {
  const response = await fetchFn(url, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/json" },
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error("shell-release-http-error");
  if (response.url !== "" && !response.url.startsWith("https://")) {
    throw new Error("shell-release-insecure-redirect");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > 8 * 1024 * 1024)
    throw new Error("shell-release-size-invalid");
  return bytes;
}

export async function resolveBusinessOsStableShellRelease(
  fetchFn: typeof fetch = fetch,
  trust: TrustMap = BUSINESS_OS_SHELL_TRUST_KEYS,
): Promise<BusinessOsShellReleaseManifest> {
  const pointerBytes = await fetchJsonBytes(fetchFn, CTOX_STABLE_SHELL_CHANNEL_URL);
  const pointer = verifyBusinessOsShellChannelPointer(
    JSON.parse(pointerBytes.toString("utf8")),
    trust,
  );
  if (pointer.channel !== "stable") throw new Error("shell-release-channel-mismatch");
  const manifestBytes = await fetchJsonBytes(fetchFn, pointer.manifestUrl);
  const digest = NodeCrypto.createHash("sha256").update(manifestBytes).digest("hex");
  if (digest !== pointer.manifestSha256) throw new Error("shell-release-manifest-hash-mismatch");
  const manifest = verifyBusinessOsShellReleaseManifest(
    JSON.parse(manifestBytes.toString("utf8")),
    trust,
  );
  if (manifest.channel !== pointer.channel || manifest.version !== pointer.version) {
    throw new Error("shell-release-pointer-mismatch");
  }
  return manifest;
}

/** Resolve an immutable signed release by version, including an older active rollback slot. */
export async function resolveBusinessOsShellReleaseVersion(
  version: string,
  fetchFn: typeof fetch = fetch,
  trust: TrustMap = BUSINESS_OS_SHELL_TRUST_KEYS,
): Promise<BusinessOsShellReleaseManifest> {
  const manifestBytes = await fetchJsonBytes(
    fetchFn,
    officialBusinessOsShellReleaseManifestUrl(version),
  );
  const manifest = verifyBusinessOsShellReleaseManifest(
    JSON.parse(manifestBytes.toString("utf8")),
    trust,
  );
  if (manifest.version !== version) throw new Error("shell-release-version-mismatch");
  return manifest;
}
