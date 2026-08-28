import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CtoxMobileShellPackResolveResult } from "./mobileShell.ts";

const valid = {
  type: "ctox.mobile.shell-pack-distribution.v1",
  manifest: {
    type: "ctox.mobile.shell-pack.v1",
    packId: "pack-a",
    businessOsRevision: "revision-a",
    appVersion: "1.0.0",
    totalSize: 1,
    files: [{ path: "index.html", size: 1, sha256: "a".repeat(64) }],
    signingKeyId: "key-current",
    signature: "b".repeat(128),
  },
  artifact: {
    url: "https://releases.example.test/pack.tar.zst",
    size: 1,
    sha256: "c".repeat(64),
    contentType: "application/zstd",
    expiresAt: "2099-08-25T12:05:00.000Z",
  },
} as const;

describe("CTOX mobile shell-pack contract", () => {
  it("accepts the exact signed manifest and transport descriptor", () => {
    expect(Schema.decodeUnknownSync(CtoxMobileShellPackResolveResult)(valid)).toEqual(valid);
  });

  it.each(["/index.html", "../index.html", "assets/../index.html", "vendor/ctox-office/data.bin"])(
    "rejects unsafe or office-pack path %s",
    (path) => {
      expect(() =>
        Schema.decodeUnknownSync(CtoxMobileShellPackResolveResult)({
          ...valid,
          manifest: { ...valid.manifest, files: [{ ...valid.manifest.files[0], path }] },
        }),
      ).toThrow();
    },
  );

  it("rejects uppercase hashes, unknown schemes and malformed signatures", () => {
    expect(() =>
      Schema.decodeUnknownSync(CtoxMobileShellPackResolveResult)({
        ...valid,
        artifact: { ...valid.artifact, sha256: "A".repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CtoxMobileShellPackResolveResult)({
        ...valid,
        artifact: { ...valid.artifact, url: "http://releases.example.test/pack.tar.zst" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CtoxMobileShellPackResolveResult)({
        ...valid,
        manifest: { ...valid.manifest, signature: "00" },
      }),
    ).toThrow();
  });
});
