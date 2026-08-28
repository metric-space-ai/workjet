import type {
  CtoxMobileShellPackResolveResult,
  CtoxMobileShellPackTrustKey,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  validateBusinessOsShellPackDistribution,
  validateBusinessOsShellPackTrustMap,
} from "./shell-pack-distribution";

const NOW = Date.parse("2026-08-25T12:00:00Z");
const expected = { businessOsRevision: "revision-a", appVersion: "1.2.3" } as const;
const trustKeys: readonly CtoxMobileShellPackTrustKey[] = [
  {
    signingKeyId: "key-current",
    algorithm: "Ed25519",
    publicKey: "11".repeat(32),
    state: "current",
  },
  {
    signingKeyId: "key-next",
    algorithm: "Ed25519",
    publicKey: "22".repeat(32),
    state: "next",
  },
];

function descriptor(): CtoxMobileShellPackResolveResult {
  return {
    type: "ctox.mobile.shell-pack-distribution.v1",
    manifest: {
      type: "ctox.mobile.shell-pack.v1",
      packId: "pack-a",
      businessOsRevision: expected.businessOsRevision,
      appVersion: expected.appVersion,
      totalSize: 10,
      files: [{ path: "index.html", size: 10, sha256: "33".repeat(32) }],
      signingKeyId: "key-current",
      signature: "44".repeat(64),
    },
    artifact: {
      url: "https://shells.example.test/pack-a.zip",
      size: 100,
      sha256: "55".repeat(32),
      contentType: "application/zip",
      expiresAt: "2026-08-25T12:05:00Z",
    },
  };
}

describe("Business OS shell pack distribution", () => {
  it("accepts an exact descriptor only with the current+next trust map", () => {
    const result = validateBusinessOsShellPackDistribution({
      descriptor: descriptor(),
      expected,
      trustKeys,
      now: NOW,
    });
    expect(result.descriptor.manifest.packId).toBe("pack-a");
    expect([...result.publicKeys.keys()]).toEqual(["key-current", "key-next"]);
  });

  it("stays fail-closed without production trust keys or for an unknown key", () => {
    expect(() => validateBusinessOsShellPackTrustMap([])).toThrowError(
      expect.objectContaining({ code: "trust-unavailable" }),
    );
    expect(() =>
      validateBusinessOsShellPackDistribution({
        descriptor: descriptor(),
        expected,
        trustKeys: [],
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "trust-unavailable" }));

    expect(() =>
      validateBusinessOsShellPackDistribution({
        descriptor: {
          ...descriptor(),
          manifest: { ...descriptor().manifest, signingKeyId: "key-unknown" },
        },
        expected,
        trustKeys,
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "untrusted-key" }));
  });

  it("rejects expired, insecure and incompatible artifact descriptors", () => {
    expect(() =>
      validateBusinessOsShellPackDistribution({
        descriptor: {
          ...descriptor(),
          artifact: { ...descriptor().artifact, expiresAt: "2026-08-25T11:59:00Z" },
        },
        expected,
        trustKeys,
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "artifact-expired" }));

    expect(() =>
      validateBusinessOsShellPackDistribution({
        descriptor: {
          ...descriptor(),
          artifact: { ...descriptor().artifact, url: "https://user:pass@shells.example.test/a" },
        },
        expected,
        trustKeys,
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "artifact" }));

    expect(() =>
      validateBusinessOsShellPackDistribution({
        descriptor: {
          ...descriptor(),
          manifest: { ...descriptor().manifest, appVersion: "9.9.9" },
        },
        expected,
        trustKeys,
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "compatibility" }));
  });
});
