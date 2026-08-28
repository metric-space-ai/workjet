import type {
  CtoxMobileShellPackResolveResult,
  CtoxMobileShellPackTrustKey,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeProductionBusinessOsShellPackResolver } from "./shell-pack-resolver-core";

const NOW = Date.parse("2026-08-25T12:00:00Z");
const expected = { businessOsRevision: "revision-a", appVersion: "1.2.3" } as const;
const environmentId = "environment-a" as EnvironmentId;
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
const descriptor: CtoxMobileShellPackResolveResult = {
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

describe("production Business OS shell pack resolver", () => {
  it("passes the exact environment and compatibility input to the shared command", async () => {
    const execute = vi.fn(async () => descriptor);
    const resolver = makeProductionBusinessOsShellPackResolver({
      environmentId,
      trustKeys,
      command: { execute },
      now: () => NOW,
    });

    await expect(resolver.resolve(expected)).resolves.toMatchObject({
      descriptor: { manifest: { packId: "pack-a" } },
    });
    expect(execute).toHaveBeenCalledWith({ environmentId, input: expected });
  });

  it("does not issue a credentialed request without the production trust map", async () => {
    const execute = vi.fn(async () => descriptor);
    const resolver = makeProductionBusinessOsShellPackResolver({
      environmentId,
      trustKeys: [],
      command: { execute },
      now: () => NOW,
    });

    await expect(resolver.resolve(expected)).rejects.toMatchObject({ code: "trust-unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });
});
