import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  collectProductionClosure,
  describePackages,
  DESKTOP_RELEASE_IMPORTERS,
  EXTERNAL_RUNTIME_COMPONENTS,
  groupPackagesByLicense,
  isExcludedFromArtifact,
  packageKey,
  parseSnapshotKey,
  renderReleaseNotice,
  resolveImporterLink,
  resolvePlatformSiblingLicense,
  resolveSnapshotKey,
  ReleaseNoticeSnapshotMissingError,
  stripSnapshotSuffix,
  UNRESOLVED_LICENSE,
  VENDORED_NATIVE_COMPONENTS,
  type InstalledPackageIndex,
  type ReleaseLockfile,
} from "./lib/release-notice.ts";
import { RELEASE_NOTICE_FILENAME } from "./generate-release-notice.ts";

const repoRoot = new URL("..", import.meta.url).pathname;

const lockfile: ReleaseLockfile = {
  importers: {
    "apps/desktop": {
      dependencies: {
        effect: { specifier: "4.0.0", version: "4.0.0(patch_hash=abc)" },
        "@t3tools/shared": { specifier: "workspace:*", version: "link:../../packages/shared" },
      },
      devDependencies: {
        "electron-builder": { specifier: "26.0.0", version: "26.0.0" },
      },
    },
    "packages/shared": {
      dependencies: {
        "@scope/native-darwin-arm64": { specifier: "1.0.0", version: "1.0.0" },
        vite: { specifier: "^7", version: "@voidzero-dev/vite-plus-core@0.2.2(yaml@2.9.0)" },
      },
      optionalDependencies: {
        "@anthropic-ai/claude-agent-sdk-linux-x64": { specifier: "0.3.0", version: "0.3.0" },
      },
    },
  },
  snapshots: {
    "effect@4.0.0(patch_hash=abc)": {},
    "@scope/native-darwin-arm64@1.0.0": {},
    "@voidzero-dev/vite-plus-core@0.2.2(yaml@2.9.0)": {
      dependencies: { "@scope/native-win32-x64": "1.0.0" },
      optionalDependencies: { "unlicensed-thing": "2.0.0" },
    },
    "@scope/native-win32-x64@1.0.0": {},
    "unlicensed-thing@2.0.0": {},
    "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.0": {},
  },
};

const index: InstalledPackageIndex = new Map([
  [
    packageKey("effect", "4.0.0"),
    { license: "MIT", repository: "https://github.com/effect-ts/effect" },
  ],
  [
    packageKey("@scope/native-darwin-arm64", "1.0.0"),
    { license: "Apache-2.0", repository: undefined },
  ],
  [packageKey("unlicensed-thing", "2.0.0"), { license: undefined, repository: undefined }],
  [
    packageKey("@anthropic-ai/claude-agent-sdk-linux-x64", "0.3.0"),
    { license: "SEE LICENSE IN LICENSE.md", repository: undefined },
  ],
]);

describe("release notice model", () => {
  it("parses pnpm snapshot keys, peer suffixes, aliases, and workspace links", () => {
    assert.equal(stripSnapshotSuffix("effect@4.0.0(patch_hash=abc)"), "effect@4.0.0");
    assert.deepStrictEqual(parseSnapshotKey("@scope/pkg@1.2.3(react@19.0.0)"), {
      name: "@scope/pkg",
      version: "1.2.3",
    });
    assert.equal(resolveSnapshotKey("effect", "4.0.0(x@1)"), "effect@4.0.0(x@1)");
    assert.equal(
      resolveSnapshotKey("vite", "@voidzero-dev/core@0.2.2"),
      "@voidzero-dev/core@0.2.2",
    );
    assert.equal(resolveImporterLink("apps/desktop", "../../packages/shared"), "packages/shared");
    assert.deepStrictEqual(
      [...DESKTOP_RELEASE_IMPORTERS],
      ["apps/desktop", "apps/server", "apps/web"],
    );
  });

  it("walks only the production closure and follows workspace links transitively", () => {
    const closure = collectProductionClosure(lockfile, ["apps/desktop"]);
    assert.deepStrictEqual(closure.importers, ["apps/desktop", "packages/shared"]);
    assert.deepStrictEqual(
      closure.packages.map((entry) => packageKey(entry.name, entry.version)),
      [
        "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.0",
        "@scope/native-darwin-arm64@1.0.0",
        "@scope/native-win32-x64@1.0.0",
        "@voidzero-dev/vite-plus-core@0.2.2",
        "effect@4.0.0",
        "unlicensed-thing@2.0.0",
      ],
    );
    // electron-builder is a dev dependency of apps/desktop and must not appear.
    assert.isUndefined(closure.packages.find((entry) => entry.name === "electron-builder"));
  });

  it("fails closed on a lockfile whose snapshots are incomplete", () => {
    assert.throws(
      () =>
        collectProductionClosure(
          { importers: { a: { dependencies: { x: { version: "1.0.0" } } } }, snapshots: {} },
          ["a"],
        ),
      ReleaseNoticeSnapshotMissingError,
    );
  });

  it("resolves platform variants through their sibling family and flags the rest", () => {
    assert.equal(
      resolvePlatformSiblingLicense({ name: "@scope/native-win32-x64", version: "1.0.0" }, index),
      "Apache-2.0",
    );
    assert.isUndefined(
      resolvePlatformSiblingLicense({ name: "unlicensed-thing", version: "2.0.0" }, index),
    );

    const described = describePackages(
      collectProductionClosure(lockfile, ["apps/desktop"]).packages,
      index,
    );
    const byName = new Map(described.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("effect")?.licenseOrigin, "manifest");
    assert.equal(byName.get("@scope/native-win32-x64")?.license, "Apache-2.0");
    assert.equal(byName.get("@scope/native-win32-x64")?.licenseOrigin, "platform-sibling");
    assert.equal(byName.get("unlicensed-thing")?.license, UNRESOLVED_LICENSE);
    assert.equal(byName.get("unlicensed-thing")?.licenseOrigin, "unresolved");
  });

  it("keeps packages the desktop build excludes out of the attributed set", () => {
    assert.isTrue(isExcludedFromArtifact("@anthropic-ai/claude-agent-sdk-linux-x64"));
    assert.isFalse(isExcludedFromArtifact("@anthropic-ai/claude-agent-sdk"));
  });

  it("renders deterministic, license-grouped Markdown with the source offer", () => {
    const packages = describePackages(
      collectProductionClosure(lockfile, ["apps/desktop"]).packages,
      index,
    );
    const input = {
      product: "Workjet",
      rootImporters: ["apps/desktop"] as const,
      workspaceImporters: ["apps/desktop", "packages/shared"] as const,
      packages,
      vendored: VENDORED_NATIVE_COMPONENTS,
      externalRuntime: EXTERNAL_RUNTIME_COMPONENTS,
    };
    const first = renderReleaseNotice(input);
    assert.equal(first, renderReleaseNotice(input));
    assert.notMatch(first, /\d{4}-\d{2}-\d{2}T/u);
    assert.include(first, "## 4. Third-party npm packages (5)");
    assert.include(first, "## 5. Packages excluded from the packaged artifact (1)");
    assert.include(
      first,
      "- `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.0` — SEE LICENSE IN LICENSE.md",
    );
    assert.include(first, "## 6. Unresolved license metadata (2)");
    assert.include(first, "## 7. Source offer");
    assert.include(first, "complete corresponding source");

    const licenses = groupPackagesByLicense(packages).map(([license]) => license);
    assert.deepStrictEqual(licenses, [...licenses].sort());
  });
});

describe("release notice repository facts", () => {
  it("keeps the T3 MIT copyright notice at the repository root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const license = yield* fs.readFileString(path.join(repoRoot, "LICENSE"));
      assert.include(license, "MIT License");
      assert.include(license, "Copyright (c) 2026 T3 Tools Inc.");
      assert.include(
        license,
        "The above copyright notice and this permission notice shall be included",
      );
    }).pipe(Effect.provide(NodeServices.layer)));

  it("matches every vendored component entry to its checked-in manifest and license texts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const component of VENDORED_NATIVE_COMPONENTS) {
        for (const licenseFile of component.licenseFiles) {
          assert.isTrue(
            yield* fs.exists(path.join(repoRoot, licenseFile)),
            `${component.path} references a missing license text ${licenseFile}`,
          );
        }
        const manifestPath = path.join(repoRoot, component.path, "Cargo.toml");
        if (!(yield* fs.exists(manifestPath))) continue;
        const manifest = yield* fs.readFileString(manifestPath);
        const packageBlock = manifest.slice(manifest.indexOf("[package]")).split("\n[")[0] ?? "";
        const field = (key: string): string | undefined =>
          new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "mu").exec(packageBlock)?.[1];
        assert.equal(field("name"), component.component, `${component.path} name`);
        assert.equal(field("version"), component.version, `${component.path} version`);
        assert.equal(field("license"), component.license, `${component.path} license`);
      }
    }).pipe(Effect.provide(NodeServices.layer)));

  it("vendors no Greppy source and records it as an external Apache-2.0 runtime component", () => {
    const greppy = EXTERNAL_RUNTIME_COMPONENTS.find((entry) =>
      entry.component.startsWith("Greppy"),
    );
    assert.isDefined(greppy);
    assert.equal(greppy?.license, "Apache-2.0");
    assert.include(greppy?.note ?? "", "No Greppy source is vendored");
    assert.isUndefined(
      VENDORED_NATIVE_COMPONENTS.find((entry) => entry.path.toLowerCase().includes("greppy")),
    );
  });

  it("keeps the committed release notice in sync with the generator", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const notice = yield* fs.readFileString(path.join(repoRoot, RELEASE_NOTICE_FILENAME));
      assert.include(notice, "# Workjet release NOTICE");
      assert.include(notice, "## 7. Source offer");
      assert.include(notice, "## 2. Vendored native components");
      assert.include(notice, "No Greppy source is vendored");
      assert.notMatch(notice, /\d{4}-\d{2}-\d{2}T\d{2}:/u);
    }).pipe(Effect.provide(NodeServices.layer)));
});
