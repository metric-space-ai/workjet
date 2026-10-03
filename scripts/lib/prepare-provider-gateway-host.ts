// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - Build-time verified release staging.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  buildProviderGatewayHostPin,
  decodeProviderGatewayHostPin,
  decodeProviderGatewayHostReleaseManifest,
  digestBytes,
  PROVIDER_GATEWAY_HOST_EXECUTABLE_MAX_BYTES,
  PROVIDER_GATEWAY_HOST_MANIFEST_MAX_BYTES,
} from "./provider-gateway-host-artifacts.ts";

type FetchArtifact = (url: string, init: RequestInit) => Promise<Response>;

async function verifiedFile(input: {
  path: string;
  url: string;
  byteLength: number;
  sha256: string;
  maximum: number;
  fetchArtifact: FetchArtifact;
}): Promise<Uint8Array> {
  if (input.byteLength > input.maximum) {
    throw new Error("Pinned provider-gateway artifact exceeds its size limit.");
  }
  try {
    const stat = await NodeFSP.stat(input.path);
    if (stat.isFile() && stat.size === input.byteLength) {
      const cached = await NodeFSP.readFile(input.path);
      if (digestBytes(cached) === input.sha256) return cached;
    }
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }

  const response = await input.fetchArtifact(input.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Provider-gateway artifact download failed: HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > input.byteLength) {
        await reader.cancel();
        throw new Error("Provider-gateway artifact exceeds its pinned byte length.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (byteLength !== input.byteLength || digestBytes(bytes) !== input.sha256) {
    throw new Error("Provider-gateway artifact does not match its pinned size and SHA-256.");
  }
  const temporary = `${input.path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await NodeFSP.rename(temporary, input.path);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
  return bytes;
}

/** Stage only verified release bytes. Packaged apps never use a local-build fallback. */
export async function prepareProviderGatewayHost(options: {
  repoRoot: string;
  platform: "mac" | "linux" | "win";
  arch: "arm64" | "x64" | "universal";
  dependencyRoot?: string;
  pin?: unknown;
  fetchArtifact?: FetchArtifact;
}): Promise<{ installPath: string; version: string }> {
  const pin = decodeProviderGatewayHostPin(
    options.pin ??
      (JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(
            options.repoRoot,
            "apps/desktop/resources/provider-gateway/host-release.pin.json",
          ),
          "utf8",
        ),
      ) as unknown),
  );
  if (pin.status !== "pinned" || !pin.release) {
    throw new Error(
      `Cannot package Workjet without a provider-gateway release: ${pin.unreleasedReason}`,
    );
  }
  if (options.arch === "universal" && options.platform !== "mac") {
    throw new Error("Universal provider-gateway packaging is supported only on macOS.");
  }
  const release = pin.release;
  const os = options.platform === "mac" ? "darwin" : options.platform === "win" ? "win32" : "linux";
  const architectures = options.arch === "universal" ? ["arm64", "x64"] : [options.arch];
  const artifacts = architectures.map((arch) => {
    const artifact = release.artifacts.find((item) => item.os === os && item.arch === arch);
    if (!artifact)
      throw new Error(`Pinned provider-gateway release has no ${os}/${arch} artifact.`);
    return artifact;
  });
  const installPath = NodePath.join(
    options.dependencyRoot ??
      NodePath.join(options.repoRoot, ".deps/workjet-provider-gateway-host"),
    release.version,
    `${os}-${options.arch}`,
  );
  await NodeFSP.mkdir(installPath, { recursive: true });
  const fetchArtifact = options.fetchArtifact ?? fetch;
  const manifestBytes = await verifiedFile({
    path: NodePath.join(installPath, release.manifestFileName),
    url: release.manifestUrl,
    byteLength: release.manifestByteLength,
    sha256: release.manifestSha256,
    maximum: PROVIDER_GATEWAY_HOST_MANIFEST_MAX_BYTES,
    fetchArtifact,
  });
  const manifest = decodeProviderGatewayHostReleaseManifest(
    JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown,
  );
  if (
    JSON.stringify(buildProviderGatewayHostPin({ manifest, manifestBytes })) !== JSON.stringify(pin)
  ) {
    throw new Error("Provider-gateway release manifest disagrees with the committed pin.");
  }
  for (const artifact of artifacts) {
    const executablePath = NodePath.join(installPath, artifact.fileName);
    await verifiedFile({
      path: executablePath,
      url: artifact.url,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      maximum: PROVIDER_GATEWAY_HOST_EXECUTABLE_MAX_BYTES,
      fetchArtifact,
    });
    await NodeFSP.chmod(executablePath, 0o755);
  }
  return { installPath, version: release.version };
}
