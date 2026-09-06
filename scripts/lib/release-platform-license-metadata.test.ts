import { assert, describe, it } from "@effect/vitest";
import { describePackages, type InstalledPackageIndex } from "./release-notice.ts";
import {
  applyReleasePlatformMetadata,
  RELEASE_PLATFORM_LICENSE_METADATA,
  ReleaseNoticePlatformMetadataConflictError,
} from "./release-platform-license-metadata.ts";

describe("reviewed platform release metadata", () => {
  const packages = [
    { name: "@clerk/electron-passkeys-darwin-arm64", version: "0.0.3" },
    { name: "@clerk/electron-passkeys-win32-x64-msvc", version: "0.0.3" },
    { name: "@ff-labs/fff-bin-linux-x64-gnu", version: "0.9.4" },
  ];

  it("produces identical notice entries with Linux, macOS, Windows, or no native manifests", () => {
    const expected = describePackages(packages, applyReleasePlatformMetadata(new Map()));
    for (const host of ["linux", "darwin", "win32"]) {
      const installed: InstalledPackageIndex = new Map(
        Object.entries(RELEASE_PLATFORM_LICENSE_METADATA)
          .filter(([key]) => key.includes(`-${host}-`))
          .map(([key, record]) => [
            key,
            { license: record.license, repository: record.repository },
          ]),
      );
      assert.deepStrictEqual(
        describePackages(packages, applyReleasePlatformMetadata(installed)),
        expected,
      );
    }
    assert.isTrue(
      expected.every((entry) => entry.license === "MIT" && entry.licenseOrigin === "manifest"),
    );
  });

  it("refuses a conflicting installed license instead of hiding metadata drift", () => {
    const installed: InstalledPackageIndex = new Map([
      [
        "@clerk/electron-passkeys-darwin-arm64@0.0.3",
        { license: "DIFFERENT", repository: undefined },
      ],
    ]);
    assert.throws(
      () => applyReleasePlatformMetadata(installed),
      ReleaseNoticePlatformMetadataConflictError,
    );
  });

  it("does not apply reviewed records to other versions or ordinary packages", () => {
    const installed: InstalledPackageIndex = new Map([
      [
        "@clerk/electron-passkeys-darwin-arm64@9.9.9",
        { license: "NEW-LICENSE", repository: undefined },
      ],
      ["ordinary-package@1.0.0", { license: undefined, repository: undefined }],
    ]);
    const result = applyReleasePlatformMetadata(installed);
    assert.deepStrictEqual(
      result.get("@clerk/electron-passkeys-darwin-arm64@9.9.9"),
      installed.get("@clerk/electron-passkeys-darwin-arm64@9.9.9"),
    );
    assert.deepStrictEqual(
      result.get("ordinary-package@1.0.0"),
      installed.get("ordinary-package@1.0.0"),
    );
    assert.equal(installed.size, 2);
  });
});
