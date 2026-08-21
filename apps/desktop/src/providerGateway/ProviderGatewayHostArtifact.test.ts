// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - Verifies real on-disk executable digests in a temporary directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Artifact from "./ProviderGatewayHostArtifact.ts";

const VERSION = "0.1.0";
const TAG = `provider-gateway-host-v${VERSION}`;
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BINARY = Buffer.from("#!/bin/false\nnot-a-real-gateway-host\n", "utf8");
const BINARY_SHA256 = NodeCrypto.createHash("sha256").update(BINARY).digest("hex");
const TARGETS = [
  { triple: "aarch64-apple-darwin", os: "darwin", arch: "arm64", suffix: "" },
  { triple: "x86_64-apple-darwin", os: "darwin", arch: "x64", suffix: "" },
  { triple: "x86_64-unknown-linux-gnu", os: "linux", arch: "x64", suffix: "" },
  { triple: "aarch64-unknown-linux-gnu", os: "linux", arch: "arm64", suffix: "" },
  { triple: "x86_64-pc-windows-msvc", os: "win32", arch: "x64", suffix: ".exe" },
  { triple: "aarch64-pc-windows-msvc", os: "win32", arch: "arm64", suffix: ".exe" },
] as const;

function assetName(triple: string, suffix: string): string {
  return `workjet-provider-gateway-host-${VERSION}-${triple}${suffix}`;
}

function pinnedPin(): unknown {
  return {
    schema: "workjet.provider-gateway-host.pin.v1",
    component: "workjet-provider-gateway-host",
    status: "pinned",
    release: {
      version: VERSION,
      releaseTag: TAG,
      sourceCommit: SOURCE_COMMIT,
      manifestFileName: `workjet-provider-gateway-host-${VERSION}.manifest.json`,
      manifestUrl: `https://github.com/metric-space-ai/workjet/releases/download/${TAG}/workjet-provider-gateway-host-${VERSION}.manifest.json`,
      manifestByteLength: 2048,
      manifestSha256: NodeCrypto.createHash("sha256").update("manifest").digest("hex"),
      artifacts: TARGETS.map((target) => ({
        triple: target.triple,
        os: target.os,
        arch: target.arch,
        fileName: assetName(target.triple, target.suffix),
        url: `https://github.com/metric-space-ai/workjet/releases/download/${TAG}/${assetName(target.triple, target.suffix)}`,
        byteLength: BINARY.byteLength,
        sha256: BINARY_SHA256,
      })),
    },
  };
}

function unreleasedPin(): unknown {
  return {
    schema: "workjet.provider-gateway-host.pin.v1",
    component: "workjet-provider-gateway-host",
    status: "unreleased",
    unreleasedReason: "No provider-gateway-host-v* release has been published yet.",
  };
}

function environment(input: {
  readonly isPackaged: boolean;
  readonly rootDir: string;
  readonly resourcesPath: string;
}): Artifact.ProviderGatewayHostEnvironment {
  return input;
}

/** A scoped temporary directory, released with the test's scope. */
const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gateway-host-pin-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);
describe("packaged resource directory", () => {
  it("is the packaged resource directory the build script ships to", () => {
    // Paired with "ships the host where the resolver looks for it" in
    // scripts/build-desktop-artifact.test.ts. The scripts tsconfig cannot
    // import this package, so the agreement is pinned as the same literal on
    // both sides: renaming one alone ships a host the app cannot find, and one
    // of the two tests then fails.
    assert.equal(Artifact.PROVIDER_GATEWAY_HOST_RESOURCE_DIRECTORY, "provider-gateway-host");
  });
});

describe("ProviderGatewayHostArtifact", () => {
  it("decodes the pin checked into this repository", () => {
    const pin = Artifact.PROVIDER_GATEWAY_HOST_PIN;
    assert.strictEqual(pin.schema, Artifact.PROVIDER_GATEWAY_HOST_PIN_SCHEMA);
    assert.strictEqual(pin.component, Artifact.PROVIDER_GATEWAY_HOST_COMPONENT);
    assert.ok(pin.status === "pinned" || pin.status === "unreleased");
  });

  it("rejects a pin with an unknown schema or an excess property", () => {
    assert.throws(() =>
      Artifact.decodeProviderGatewayHostPin({
        ...(unreleasedPin() as Record<string, unknown>),
        schema: "workjet.provider-gateway-host.pin.v2",
      }),
    );
    assert.throws(() =>
      Artifact.decodeProviderGatewayHostPin({
        ...(unreleasedPin() as Record<string, unknown>),
        surprise: true,
      }),
    );
    assert.throws(() =>
      Artifact.decodeProviderGatewayHostPin({
        ...(unreleasedPin() as Record<string, unknown>),
        component: "something-else",
      }),
    );
  });

  it("resolves the pinned artifact per host platform and architecture", () => {
    const pin = Artifact.decodeProviderGatewayHostPin(pinnedPin());
    for (const target of TARGETS) {
      const artifact = Artifact.findPinnedArtifactForHost(pin, {
        platform: target.os,
        arch: target.arch,
      });
      assert.strictEqual(artifact?.triple, target.triple);
      assert.strictEqual(artifact?.fileName, assetName(target.triple, target.suffix));
    }
    assert.strictEqual(
      Artifact.findPinnedArtifactForHost(pin, { platform: "freebsd", arch: "x64" }),
      undefined,
    );
    assert.strictEqual(
      Artifact.findPinnedArtifactForHost(Artifact.decodeProviderGatewayHostPin(unreleasedPin()), {
        platform: "darwin",
        arch: "arm64",
      }),
      undefined,
    );
  });

  it("reads packaged artifacts from resources and development artifacts from a versioned .deps tree", () => {
    assert.strictEqual(
      Artifact.resolveProviderGatewayHostRoot(
        environment({ isPackaged: true, rootDir: "/repo", resourcesPath: "/resources" }),
        VERSION,
      ),
      NodePath.join("/resources", "provider-gateway-host"),
    );
    assert.strictEqual(
      Artifact.resolveProviderGatewayHostRoot(
        environment({ isPackaged: false, rootDir: "/repo", resourcesPath: "/resources" }),
        VERSION,
      ),
      NodePath.join("/repo", ".deps", "workjet-provider-gateway-host", VERSION),
    );
  });

  it.effect("prefers an explicit executable override over the pin in every environment", () =>
    Effect.gen(function* () {
      const pin = Artifact.decodeProviderGatewayHostPin(pinnedPin());
      for (const isPackaged of [false, true]) {
        const resolved = yield* Artifact.resolveProviderGatewayHostExecutable({
          pin,
          environment: environment({ isPackaged, rootDir: "/repo", resourcesPath: "/resources" }),
          host: { platform: "darwin", arch: "arm64" },
          executableOverride: "/custom/workjet-provider-gateway-host",
        });
        assert.strictEqual(resolved.source, "override");
        assert.strictEqual(resolved.executablePath, "/custom/workjet-provider-gateway-host");
      }
      // A blank override is not an override.
      const blank = Artifact.decideProviderGatewayHostSource({
        pin,
        environment: environment({
          isPackaged: false,
          rootDir: "/repo",
          resourcesPath: "/resources",
        }),
        host: { platform: "darwin", arch: "arm64" },
        executableOverride: "   ",
      });
      assert.strictEqual(blank._tag, "pinned");
    }),
  );

  it.effect("uses the pinned artifact when its bytes reproduce the pinned digest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rootDir = yield* temporaryDirectory;
        const installRoot = NodePath.join(
          rootDir,
          ".deps",
          "workjet-provider-gateway-host",
          VERSION,
        );
        const executablePath = NodePath.join(installRoot, assetName("aarch64-apple-darwin", ""));
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(installRoot, { recursive: true });
          await NodeFSP.writeFile(executablePath, BINARY, { mode: 0o755 });
        });

        const resolved = yield* Artifact.resolveProviderGatewayHostExecutable({
          pin: Artifact.decodeProviderGatewayHostPin(pinnedPin()),
          environment: environment({ isPackaged: false, rootDir, resourcesPath: "/resources" }),
          host: { platform: "darwin", arch: "arm64" },
        });
        assert.strictEqual(resolved.source, "pinned");
        assert.strictEqual(resolved.executablePath, executablePath);
        assert.strictEqual(resolved.version, VERSION);
        assert.strictEqual(resolved.triple, "aarch64-apple-darwin");
        assert.strictEqual(
          Artifact.verifyPinnedExecutable({
            executablePath,
            byteLength: BINARY.byteLength,
            sha256: BINARY_SHA256,
          }),
          undefined,
        );
      }),
    ),
  );

  it.effect(
    "names the exact mismatch for a missing, resized, tampered, or symlinked artifact",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rootDir = yield* temporaryDirectory;
          const missing = Artifact.verifyPinnedExecutable({
            executablePath: NodePath.join(rootDir, "absent"),
            byteLength: BINARY.byteLength,
            sha256: BINARY_SHA256,
          });
          assert.ok(missing?.includes("does not exist"));

          const resized = NodePath.join(rootDir, "resized");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(resized, Buffer.concat([BINARY, Buffer.from("x")])),
          );
          assert.ok(
            Artifact.verifyPinnedExecutable({
              executablePath: resized,
              byteLength: BINARY.byteLength,
              sha256: BINARY_SHA256,
            })?.includes("the pin records"),
          );

          const tampered = NodePath.join(rootDir, "tampered");
          const flipped = Buffer.from(BINARY);
          flipped[0] = (flipped[0] ?? 0) ^ 0xff;
          yield* Effect.promise(() => NodeFSP.writeFile(tampered, flipped));
          assert.ok(
            Artifact.verifyPinnedExecutable({
              executablePath: tampered,
              byteLength: BINARY.byteLength,
              sha256: BINARY_SHA256,
            })?.includes("has SHA-256"),
          );

          const real = NodePath.join(rootDir, "real");
          const link = NodePath.join(rootDir, "link");
          yield* Effect.promise(async () => {
            await NodeFSP.writeFile(real, BINARY);
            await NodeFSP.symlink(real, link);
          });
          assert.ok(
            Artifact.verifyPinnedExecutable({
              executablePath: link,
              byteLength: BINARY.byteLength,
              sha256: BINARY_SHA256,
            })?.includes("not a regular file"),
          );
        }),
      ),
  );

  it.effect("falls back to the local build in development and fails hard when packaged", () =>
    Effect.gen(function* () {
      const pinned = Artifact.decodeProviderGatewayHostPin(pinnedPin());
      const unreleased = Artifact.decodeProviderGatewayHostPin(unreleasedPin());

      // Development, no release pinned at all.
      const development = yield* Artifact.resolveProviderGatewayHostExecutable({
        pin: unreleased,
        environment: environment({ isPackaged: false, rootDir: "/repo", resourcesPath: "/res" }),
        host: { platform: "darwin", arch: "arm64" },
      });
      assert.strictEqual(development.source, "local-build");
      assert.strictEqual(development.executablePath, undefined);
      assert.ok((development.reason ?? "").includes("release"));

      // Development, pinned but the file on disk is wrong.
      const stale = yield* Artifact.resolveProviderGatewayHostExecutable({
        pin: pinned,
        environment: environment({ isPackaged: false, rootDir: "/repo", resourcesPath: "/res" }),
        host: { platform: "darwin", arch: "arm64" },
        verify: () => "digest mismatch",
      });
      assert.strictEqual(stale.source, "local-build");
      assert.strictEqual(stale.reason, "digest mismatch");

      // Development on a platform the release does not cover.
      const unsupported = yield* Artifact.resolveProviderGatewayHostExecutable({
        pin: pinned,
        environment: environment({ isPackaged: false, rootDir: "/repo", resourcesPath: "/res" }),
        host: { platform: "freebsd", arch: "x64" },
      });
      assert.strictEqual(unsupported.source, "local-build");
      assert.ok((unsupported.reason ?? "").includes("freebsd-x64"));

      // Packaged: each of those three is a hard, named failure instead.
      for (const attempt of [
        { pin: unreleased, host: { platform: "darwin", arch: "arm64" }, verify: undefined },
        {
          pin: pinned,
          host: { platform: "darwin", arch: "arm64" },
          verify: () => "digest mismatch" as const,
        },
        { pin: pinned, host: { platform: "freebsd", arch: "x64" }, verify: undefined },
      ]) {
        const exit = yield* Effect.exit(
          Artifact.resolveProviderGatewayHostExecutable({
            pin: attempt.pin,
            environment: environment({ isPackaged: true, rootDir: "/repo", resourcesPath: "/res" }),
            host: attempt.host,
            ...(attempt.verify === undefined ? {} : { verify: attempt.verify }),
          }),
        );
        assert.strictEqual(exit._tag, "Failure");
      }

      const failure = yield* Artifact.resolveProviderGatewayHostExecutable({
        pin: unreleased,
        environment: environment({ isPackaged: true, rootDir: "/repo", resourcesPath: "/res" }),
        host: { platform: "darwin", arch: "arm64" },
      }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ProviderGatewayHostArtifactError");
      assert.ok(failure.message.includes("pinned Workjet provider-gateway host is unavailable"));
    }),
  );
});
