import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import {
  BUSINESS_OS_SHELL_PACK_TYPE,
  shellPackSigningPayload,
  verifyBusinessOsShellPack,
  type BusinessOsShellPackManifest,
} from "./shell-pack";

const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKey = ed25519.getPublicKey(privateKey);
const index = new TextEncoder().encode("<!doctype html><head></head><body>Workjet</body>");
const mobileApps = new TextEncoder().encode(
  JSON.stringify({ type: "workjet.business-os-mobile-apps.v1", revision: "test", apps: [] }),
);
const iconPaths = [
  "icons/threads/ios-standard.png",
  "icons/threads/ios-dark.png",
  "icons/threads/ios-tinted.png",
  "icons/threads/android-foreground.png",
  "icons/threads/android-background.png",
  "icons/threads/android-monochrome.png",
  "icons/threads/web.png",
] as const;
const mobileIcons = new TextEncoder().encode(
  JSON.stringify({
    type: "ctox.business-os-icon-pack.v1",
    familyVersion: 1,
    apps: [
      {
        appId: "threads",
        iconAssetId: "workjet.business-os.threads",
        accessibilityLabel: "Threads",
        format: "png",
        pixelSize: { width: 1024, height: 1024 },
        ios: { standard: iconPaths[0], dark: iconPaths[1], tinted: iconPaths[2] },
        android: { foreground: iconPaths[3], background: iconPaths[4], monochrome: iconPaths[5] },
        web: { standard: iconPaths[6] },
      },
    ],
  }),
);

function pack(): { manifest: BusinessOsShellPackManifest; files: Map<string, Uint8Array> } {
  const files = new Map([
    ["index.html", index],
    ["mobile-apps.json", mobileApps],
    ["mobile-icons.json", mobileIcons],
    ...iconPaths.map((path) => [path, Uint8Array.of(137, 80, 78, 71)] as const),
  ]);
  const assetSize = iconPaths.length * 4;
  const unsigned = {
    type: BUSINESS_OS_SHELL_PACK_TYPE,
    packId: "shell-test",
    businessOsRevision: "revision-a",
    appVersion: "1.2.3",
    totalSize: index.byteLength + mobileApps.byteLength + mobileIcons.byteLength + assetSize,
    files: [
      { path: "index.html", size: index.byteLength, sha256: bytesToHex(sha256(index)) },
      {
        path: "mobile-apps.json",
        size: mobileApps.byteLength,
        sha256: bytesToHex(sha256(mobileApps)),
      },
      {
        path: "mobile-icons.json",
        size: mobileIcons.byteLength,
        sha256: bytesToHex(sha256(mobileIcons)),
      },
      ...iconPaths.map((path) => ({
        path,
        size: 4,
        sha256: bytesToHex(sha256(Uint8Array.of(137, 80, 78, 71))),
      })),
    ],
    signingKeyId: "test-key",
  } as const;
  return {
    manifest: {
      ...unsigned,
      signature: bytesToHex(ed25519.sign(shellPackSigningPayload(unsigned), privateKey)),
    },
    files,
  };
}

function verify(value = pack()) {
  return verifyBusinessOsShellPack({
    ...value,
    publicKeys: new Map([["test-key", publicKey]]),
    expectedAppVersion: "1.2.3",
    expectedBusinessOsRevision: "revision-a",
  });
}

describe("Business OS shell pack", () => {
  it("accepts a complete, signed, exactly compatible pack", () => {
    expect(verify().packId).toBe("shell-test");
  });

  it("rejects hash, signature, revision and completeness failures", () => {
    const hashFailure = pack();
    hashFailure.files.set("index.html", new TextEncoder().encode("tampered"));
    expect(() => verify(hashFailure)).toThrowError(expect.objectContaining({ code: "hash" }));

    const signatureFailure = pack();
    signatureFailure.manifest = { ...signatureFailure.manifest, signature: "00".repeat(64) };
    expect(() => verify(signatureFailure)).toThrowError(
      expect.objectContaining({ code: "signature" }),
    );

    const revisionFailure = pack();
    expect(() =>
      verifyBusinessOsShellPack({
        ...revisionFailure,
        publicKeys: new Map([["test-key", publicKey]]),
        expectedAppVersion: "1.2.3",
        expectedBusinessOsRevision: "revision-b",
      }),
    ).toThrowError(expect.objectContaining({ code: "revision" }));

    const extraFailure = pack();
    extraFailure.files.set("undeclared.js", new Uint8Array());
    expect(() => verify(extraFailure)).toThrowError(
      expect.objectContaining({ code: "completeness" }),
    );
  });

  it("rejects traversal and Office files in the base shell", () => {
    const value = pack();
    const unsafe = { ...value.manifest.files[0]!, path: "../index.html" };
    expect(() =>
      verify({ ...value, manifest: { ...value.manifest, files: [unsafe] } }),
    ).toThrowError(expect.objectContaining({ code: "path" }));

    const office = { ...value.manifest.files[0]!, path: "vendor/ctox-office/index.html" };
    expect(() =>
      verify({ ...value, manifest: { ...value.manifest, files: [office] } }),
    ).toThrowError(expect.objectContaining({ code: "path" }));
  });
});
