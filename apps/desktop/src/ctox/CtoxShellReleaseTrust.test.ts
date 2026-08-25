// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - tests real Ed25519 signatures.
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  CTOX_STABLE_SHELL_CHANNEL_URL,
  resolveBusinessOsStableShellRelease,
  verifyBusinessOsShellChannelPointer,
  verifyBusinessOsShellReleaseManifest,
} from "./CtoxShellReleaseTrust.ts";

function signedFixture() {
  const pair = generateKeyPairSync("ed25519");
  const keyId = "test-current";
  const trust = {
    [keyId]: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
  const signed = <T extends Record<string, unknown>>(payload: T) => ({
    ...payload,
    signature: sign(null, Buffer.from(JSON.stringify(payload)), pair.privateKey).toString("hex"),
  });
  const release = signed({
    type: "ctox.business-os-shell.release.v2",
    version: "1.2.3",
    channel: "stable",
    sourceCommit: "a".repeat(40),
    publishedAt: "2026-08-26T12:00:00Z",
    artifact: {
      url: "https://example.test/shell.tar.gz",
      size: 12,
      sha256: "b".repeat(64),
      contentType: "application/gzip",
    },
    compatibility: {
      workjetMinVersion: "0.1.0",
      workjetMaxVersion: null,
      ctoxMinVersion: "0.3.22",
      ctoxMaxVersion: null,
      shellProtocol: "workjet.business-os-shell.v1",
    },
    files: [{ path: "index.html", size: 12, sha256: "c".repeat(64) }],
    provenance: { embeddedManifestSha256: "d".repeat(64), sbomUrl: "https://example.test/sbom" },
    signingKeyId: keyId,
  });
  const releaseBytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
  const pointer = signed({
    type: "ctox.business-os-shell.channel.v1",
    channel: "stable",
    version: "1.2.3",
    manifestUrl: "https://example.test/release.json",
    manifestSha256: createHash("sha256").update(releaseBytes).digest("hex"),
    publishedAt: "2026-08-26T12:00:00Z",
    signingKeyId: keyId,
  });
  return { pointer, release, releaseBytes, trust };
}

describe("CtoxShellReleaseTrust", () => {
  it("verifies current/next-compatible signed channel and release documents", () => {
    const fixture = signedFixture();
    expect(verifyBusinessOsShellChannelPointer(fixture.pointer, fixture.trust).version).toBe(
      "1.2.3",
    );
    expect(verifyBusinessOsShellReleaseManifest(fixture.release, fixture.trust).version).toBe(
      "1.2.3",
    );
    expect(() =>
      verifyBusinessOsShellReleaseManifest({ ...fixture.release, version: "9.9.9" }, fixture.trust),
    ).toThrow("shell-release-invalid-signature");
  });

  it("resolves the stable pointer, pins its exact bytes, and rejects hash drift", async () => {
    const fixture = signedFixture();
    const fetchFn = async (url: string | URL | Request) => {
      const href = String(url);
      const bytes =
        href === CTOX_STABLE_SHELL_CHANNEL_URL
          ? Buffer.from(JSON.stringify(fixture.pointer))
          : fixture.releaseBytes;
      return new Response(bytes, { status: 200, headers: { "content-type": "application/json" } });
    };
    Object.defineProperty(fetchFn, "name", { value: "fixtureFetch" });
    const release = await resolveBusinessOsStableShellRelease(
      fetchFn as typeof fetch,
      fixture.trust,
    );
    expect(release.version).toBe("1.2.3");
    await expect(
      resolveBusinessOsStableShellRelease(async (url) => {
        const response = await fetchFn(url);
        return String(url) === CTOX_STABLE_SHELL_CHANNEL_URL
          ? response
          : new Response(`${await response.text()} `, { status: 200 });
      }, fixture.trust),
    ).rejects.toThrow("shell-release-manifest-hash-mismatch");
  });
});
