import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  BuildCommandFailedError,
  createStageWorkspaceConfig,
  createStagePatchedDependencies,
  createStagePnpmLockfile,
  createBuildConfig,
  CTOX_BUSINESS_OS_SHELL_RESOURCE_DIRECTORY,
  createDesktopExtraResources,
  PROVIDER_GATEWAY_HOST_RESOURCE_DIRECTORY,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_LEGAL_EXTRA_RESOURCE,
  DESKTOP_LEGAL_NOTICE_FILES,
  DESKTOP_LEGAL_RESOURCE_DIRECTORY,
  DESKTOP_RESOURCE_MONITOR_EXTRA_RESOURCE,
  MissingDesktopLegalNoticeError,
  stageLegalNotices,
  InvalidMockUpdateServerPortError,
  UnsupportedDesktopBuildArchitectureError,
  LinuxIconResizeError,
  resolveDesktopRuntimeDependencies,
  resolveServerRuntimeDependencies,
  resolveFffNativeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveResourceMonitorRustTargets,
  resourceMonitorExecutableName,
  resolveGitHubPublishConfig,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  resolvePackageManagerUserAgent,
  stageLinuxIconSize,
  STAGE_INSTALL_ARGS,
  StageLockfileResolutionError,
  WINDOWS_ASAR_UNPACK,
  ancestorNodeModulesPaths,
  copyDirectoryPreservingSymlinks,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

function mockProcess(exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function iconResizeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
) {
  let commandIndex = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockProcess(exitCodes[commandIndex++] ?? 0));
    }),
  );
}

const LOCKED_CLAUDE_SDK =
  "0.3.170(@anthropic-ai/sdk@0.93.0(zod@4.4.3))(@modelcontextprotocol/sdk@1.29.0(zod@4.4.3))(zod@4.4.3)";
const LOCKED_EFFECT =
  "4.0.0-beta.103(patch_hash=af36b7948b6f9c56623074662b51dade5699880c1a7c71245de73e13c3185fb6)";
const FFF_DARWIN_ARM64 = "@ff-labs/fff-bin-darwin-arm64";

function makeRootLockFixture(input?: {
  readonly desktopEffectVersion?: string;
  readonly extraFffResolution?: string;
}) {
  const desktopEffectVersion = input?.desktopEffectVersion ?? LOCKED_EFFECT;
  const extraFffResolution = input?.extraFffResolution;
  return {
    lockfileVersion: "9.0",
    settings: {
      autoInstallPeers: true,
      excludeLinksFromLockfile: false,
    },
    packageExtensionsChecksum: "root-workspace-package-extensions",
    patchedDependencies: {
      "effect@4.0.0-beta.103": "af36b7948b6f9c56623074662b51dade5699880c1a7c71245de73e13c3185fb6",
      "unused@1.0.0": "unused-patch-hash",
    },
    importers: {
      "apps/server": {
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": {
            specifier: "^0.3.170",
            version: LOCKED_CLAUDE_SDK,
          },
          effect: {
            specifier: "4.0.0-beta.103",
            version: LOCKED_EFFECT,
          },
        },
      },
      "apps/desktop": {
        dependencies: {
          effect: {
            specifier: "4.0.0-beta.103",
            version: desktopEffectVersion,
          },
          electron: {
            specifier: "41.5.0",
            version: "41.5.0",
          },
        },
      },
    },
    packages: {
      "@anthropic-ai/claude-agent-sdk@0.3.170": {},
      "effect@4.0.0-beta.103": {},
      "electron@41.5.0": {},
      [`${FFF_DARWIN_ARM64}@0.9.4`]: {},
      ...(extraFffResolution ? { [`${FFF_DARWIN_ARM64}@${extraFffResolution}`]: {} } : {}),
    },
    snapshots: {
      [`@anthropic-ai/claude-agent-sdk@${LOCKED_CLAUDE_SDK}`]: {},
      [`effect@${LOCKED_EFFECT}`]: {},
      [`effect@${desktopEffectVersion}`]: {},
      "electron@41.5.0": {},
      [`${FFF_DARWIN_ARM64}@0.9.4`]: {},
      ...(extraFffResolution ? { [`${FFF_DARWIN_ARM64}@${extraFffResolution}`]: {} } : {}),
    },
  };
}

const stageLockInput = {
  dependencies: {
    "@anthropic-ai/claude-agent-sdk": "^0.3.170",
    effect: "4.0.0-beta.103",
    [FFF_DARWIN_ARM64]: "0.9.4",
  },
  devDependencies: {
    electron: "41.5.0",
  },
  promotedDependencyNames: [FFF_DARWIN_ARM64],
  sourceSpecifiers: {
    "apps/server": {
      "@anthropic-ai/claude-agent-sdk": "^0.3.170",
      effect: "catalog:",
    },
    "apps/desktop": {
      effect: "catalog:",
      electron: "41.5.0",
    },
  },
  patchedDependencies: {
    "effect@4.0.0-beta.103": "patches/effect@4.0.0-beta.103.patch",
  },
} as const;

function captureStageLockError(run: () => unknown): StageLockfileResolutionError {
  try {
    run();
  } catch (error) {
    assert.instanceOf(error, StageLockfileResolutionError);
    return error as StageLockfileResolutionError;
  }
  return assert.fail("Expected stage lockfile generation to fail.");
}

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("uses the Workjet package name for every desktop release channel", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "Workjet");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Workjet");
  });

  it("uses Workjet artwork for every packaged desktop platform", () => {
    const expected = {
      macIconPng: BRAND_ASSET_PATHS.workjetAppIconPng,
      macIconIcns: BRAND_ASSET_PATHS.workjetMacIconIcns,
      linuxIconPng: BRAND_ASSET_PATHS.workjetAppIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.workjetWindowsIconIco,
    };
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), expected);
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), expected);
  });

  it("uses Workjet splash and favicon artwork for every desktop release channel", () => {
    assert.equal(resolveDesktopWebAssetBrand("0.0.17"), "workjet");
    assert.equal(resolveDesktopWebAssetBrand("0.0.17-nightly.20260413.42"), "workjet");
  });

  it.effect("resolves GitHub desktop publish config from Effect config", () =>
    Effect.gen(function* () {
      const latestConfig = yield* resolveGitHubPublishConfig("latest").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_UPDATE_REPOSITORY: "metric-space-ai/workjet",
              },
            }),
          ),
        ),
      );
      const nightlyConfig = yield* resolveGitHubPublishConfig("nightly").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: "metric-space-ai/workjet",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(latestConfig, {
        provider: "github",
        owner: "metric-space-ai",
        repo: "workjet",
        releaseType: "release",
      });
      assert.deepStrictEqual(nightlyConfig, {
        provider: "github",
        owner: "metric-space-ai",
        repo: "workjet",
        releaseType: "prerelease",
        channel: "nightly",
      });
    }),
  );

  // The packaged update feed carries the product identity: a Workjet build must
  // resolve to the configured Workjet repository, never to an inherited feed. The
  // slug is environment-derived by design, so the release pipeline MUST set
  // T3CODE_DESKTOP_UPDATE_REPOSITORY to the CTOX `owner/repo` (or run in the
  // Workjet repository, which supplies the same slug through the GitHub Actions
  // GITHUB_REPOSITORY variable). With neither set there is deliberately no
  // publish config at all, so an unconfigured local build ships without an
  // update feed rather than silently pointing at somebody else's releases.
  it.effect("points the desktop update feed at the configured Workjet repository", () =>
    Effect.gen(function* () {
      const withEnv = (env: Record<string, string>) =>
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

      const workjetConfig = yield* resolveGitHubPublishConfig("latest").pipe(
        withEnv({ T3CODE_DESKTOP_UPDATE_REPOSITORY: "metric-space-ai/workjet-updates" }),
      );
      assert.deepStrictEqual(workjetConfig, {
        provider: "github",
        owner: "metric-space-ai",
        repo: "workjet-updates",
        releaseType: "release",
      });

      // The explicit override wins over the ambient GitHub Actions slug, so a
      // Workjet release built from another repository still publishes and
      // updates against the explicitly configured feed.
      const overriddenConfig = yield* resolveGitHubPublishConfig("nightly").pipe(
        withEnv({
          T3CODE_DESKTOP_UPDATE_REPOSITORY: "metric-space-ai/workjet-updates",
          GITHUB_REPOSITORY: "metric-space-ai/workjet",
        }),
      );
      assert.deepStrictEqual(overriddenConfig, {
        provider: "github",
        owner: "metric-space-ai",
        repo: "workjet-updates",
        releaseType: "prerelease",
        channel: "nightly",
      });

      // No slug configured and malformed slugs both mean "no feed", not a
      // fallback to some inherited repository.
      assert.isUndefined(yield* resolveGitHubPublishConfig("latest").pipe(withEnv({})));
      assert.isUndefined(
        yield* resolveGitHubPublishConfig("latest").pipe(
          withEnv({ T3CODE_DESKTOP_UPDATE_REPOSITORY: "   " }),
        ),
      );
      assert.isUndefined(
        yield* resolveGitHubPublishConfig("latest").pipe(
          withEnv({ T3CODE_DESKTOP_UPDATE_REPOSITORY: "metric-space-ai/workjet-updates/extra" }),
        ),
      );
    }),
  );

  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@t3tools/contracts": "workspace:*",
          "@t3tools/shared": "workspace:*",
          "@t3tools/ssh": "workspace:*",
          "@t3tools/tailscale": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
        effect: "4.0.0-beta.59",
      },
    );
  });

  it("omits bundled workspace packages from staged server dependencies", () => {
    assert.deepStrictEqual(
      resolveServerRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@metric-space-ai/workjet-capabilities": "workspace:*",
          effect: "catalog:",
          "node-pty": "^1.1.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.103",
          effect: "4.0.0-beta.103",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.103",
        effect: "4.0.0-beta.103",
        "node-pty": "^1.1.0",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        {
          "@ff-labs/fff-node": "0.9.4",
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.73",
        },
      ),
      {
        "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
        "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
        "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
      },
    );

    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.73" },
      ),
      {},
    );
  });

  it("builds the synthetic root importer from exact package specs and locked resolutions", () => {
    const lockfile = createStagePnpmLockfile(makeRootLockFixture(), stageLockInput);

    assert.deepStrictEqual(lockfile.importers, {
      ".": {
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": {
            specifier: "^0.3.170",
            version: LOCKED_CLAUDE_SDK,
          },
          [FFF_DARWIN_ARM64]: {
            specifier: "0.9.4",
            version: "0.9.4",
          },
          effect: {
            specifier: "4.0.0-beta.103",
            version: LOCKED_EFFECT,
          },
        },
        devDependencies: {
          electron: {
            specifier: "41.5.0",
            version: "41.5.0",
          },
        },
      },
    });
    assert.deepStrictEqual(lockfile.patchedDependencies, {
      "effect@4.0.0-beta.103": "af36b7948b6f9c56623074662b51dade5699880c1a7c71245de73e13c3185fb6",
    });
    assert.notProperty(lockfile, "packageExtensionsChecksum");
  });

  it("keeps ranged, peer-qualified, and patched importer resolutions unchanged", () => {
    const lockfile = createStagePnpmLockfile(makeRootLockFixture(), stageLockInput);
    const importer = (lockfile.importers as Record<string, unknown>)["."] as {
      readonly dependencies: Record<
        string,
        { readonly specifier: string; readonly version: string }
      >;
    };

    assert.equal(
      importer.dependencies["@anthropic-ai/claude-agent-sdk"]?.version,
      LOCKED_CLAUDE_SDK,
    );
    assert.equal(importer.dependencies.effect?.version, LOCKED_EFFECT);
    assert.equal(importer.dependencies["@anthropic-ai/claude-agent-sdk"]?.specifier, "^0.3.170");
  });

  it("promotes native packages only from an existing root-lock package", () => {
    const lockfile = createStagePnpmLockfile(makeRootLockFixture(), stageLockInput);
    const importer = (lockfile.importers as Record<string, unknown>)["."] as {
      readonly dependencies: Record<string, { readonly version: string }>;
    };
    assert.equal(importer.dependencies[FFF_DARWIN_ARM64]?.version, "0.9.4");

    const error = captureStageLockError(() =>
      createStagePnpmLockfile(makeRootLockFixture(), {
        ...stageLockInput,
        dependencies: {
          ...stageLockInput.dependencies,
          "@ff-labs/fff-bin-darwin-x64": "0.9.4",
        },
        promotedDependencyNames: [FFF_DARWIN_ARM64, "@ff-labs/fff-bin-darwin-x64"],
      }),
    );
    assert.equal(error.reason, "missing");
    assert.equal(error.source, "packages");
    assert.equal(error.dependencyName, "@ff-labs/fff-bin-darwin-x64");
  });

  it("fails closed on missing, conflicting, and ambiguous lock resolution data", () => {
    const missingError = captureStageLockError(() =>
      createStagePnpmLockfile(makeRootLockFixture(), {
        ...stageLockInput,
        dependencies: {
          ...stageLockInput.dependencies,
          "missing-package": "^1.0.0",
        },
        sourceSpecifiers: {
          ...stageLockInput.sourceSpecifiers,
          "apps/server": {
            ...stageLockInput.sourceSpecifiers["apps/server"],
            "missing-package": "^1.0.0",
          },
        },
      }),
    );
    assert.equal(missingError.reason, "missing");
    assert.equal(missingError.source, "importers");

    const conflictingEffect = "4.0.0-beta.103(peer@1.0.0)";
    const conflictingError = captureStageLockError(() =>
      createStagePnpmLockfile(
        makeRootLockFixture({ desktopEffectVersion: conflictingEffect }),
        stageLockInput,
      ),
    );
    assert.equal(conflictingError.reason, "conflicting");
    assert.deepStrictEqual(conflictingError.candidates, [LOCKED_EFFECT, conflictingEffect]);

    const ambiguousResolution = "0.9.4(peer@1.0.0)";
    const ambiguousError = captureStageLockError(() =>
      createStagePnpmLockfile(
        makeRootLockFixture({ extraFffResolution: ambiguousResolution }),
        stageLockInput,
      ),
    );
    assert.equal(ambiguousError.reason, "ambiguous");
    assert.equal(ambiguousError.source, "packages");
    assert.deepStrictEqual(ambiguousError.candidates, ["0.9.4", ambiguousResolution]);
  });

  it("generates deterministically without mutating the parsed root lock", () => {
    const rootLockfile = makeRootLockFixture();
    const originalRootLockfile = structuredClone(rootLockfile);

    const first = createStagePnpmLockfile(rootLockfile, stageLockInput);
    const second = createStagePnpmLockfile(rootLockfile, stageLockInput);

    assert.deepStrictEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepStrictEqual(rootLockfile, originalRootLockfile);
    assert.notStrictEqual(first, rootLockfile);
    assert.strictEqual(first.packages, rootLockfile.packages);
    assert.strictEqual(first.snapshots, rootLockfile.snapshots);
  });

  it("installs optional native dependencies for the target desktop architecture", () => {
    assert.deepStrictEqual(STAGE_INSTALL_ARGS, ["install", "--prod", "--frozen-lockfile"]);
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "x64" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["x64"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "linux", arch: "x64" }), {
      supportedArchitectures: {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
    });
    // Windows artifacts also bundle the same-architecture WSL (Linux, glibc) backend, so the
    // staged install must fetch its native optional deps (e.g. ffi-rs) too.
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "x64" }), {
      supportedArchitectures: {
        os: ["win32", "linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "arm64" }), {
      supportedArchitectures: {
        os: ["win32", "linux"],
        cpu: ["arm64"],
        libc: ["glibc"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "universal" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["arm64", "x64"],
      },
    });
  });

  it("stages pnpm 11 allowBuilds and patchedDependencies in the workspace yaml", () => {
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "linux",
        arch: "x64",
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        catalog: {
          effect: "4.0.0-beta.103",
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      }),
      {
        supportedArchitectures: {
          os: ["linux"],
          cpu: ["x64"],
          libc: ["glibc"],
        },
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        catalog: {
          effect: "4.0.0-beta.103",
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      },
    );

    // Empty maps must not be written — pnpm would still require reviewed
    // packages if allowBuilds is present but incomplete, and omitting empty
    // patchedDependencies keeps the stage yaml minimal.
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "mac",
        arch: "arm64",
        allowBuilds: {},
        patchedDependencies: {},
        overrides: {},
      }),
      {
        supportedArchitectures: {
          os: ["darwin"],
          cpu: ["arm64"],
        },
      },
    );
  });

  it("limits Electron locales and excludes the unused Claude SDK executable", () => {
    assert.deepStrictEqual(DESKTOP_ELECTRON_LANGUAGES, ["en-US"]);
    assert.deepStrictEqual(DESKTOP_FILE_EXCLUSIONS, [
      "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
    ]);
  });

  it.effect("applies platform-specific packaging to the build config", () =>
    Effect.gen(function* () {
      const mac = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        "/verified/ctox-business-os-shell",
      );
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        "/verified/ctox-business-os-shell",
      );
      const win = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        "/verified/ctox-business-os-shell",
      );

      assert.notProperty(mac, "asarUnpack");
      assert.notProperty(linux, "asarUnpack");
      assert.deepStrictEqual(win.asarUnpack, WINDOWS_ASAR_UNPACK);
      // Linux registers only the canonical production deep-link scheme.
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).protocols, [
        {
          name: "Workjet",
          schemes: ["workjet"],
        },
      ]);
      for (const config of [mac, linux, win]) {
        assert.equal(config.productName, "Workjet");
        assert.equal(config.artifactName, "Workjet-${version}-${arch}.${ext}");
        assert.deepStrictEqual(config.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
        assert.deepStrictEqual(config.files, DESKTOP_FILE_EXCLUSIONS);
        assert.deepStrictEqual(
          config.extraResources,
          createDesktopExtraResources("/verified/ctox-business-os-shell"),
        );
      }
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("preserves both Linux icon resize failures with structural context", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const error = yield* stageLinuxIconSize("source.png", "target.png", 512, false).pipe(
        Effect.provide(iconResizeSpawnerLayer(commands, [1, 2])),
        Effect.flip,
      );

      assert.instanceOf(error, LinuxIconResizeError);
      assert.equal(error.operation, "resize");
      assert.equal(error.iconSize, 512);
      assert.equal(error.primaryTool, "magick");
      assert.equal(error.fallbackTool, "convert");
      assert.include(error.message, "512x512");
      assert.include(error.message, "`magick`");
      assert.include(error.message, "`convert`");
      assert.notInclude(error.message, "non-zero exit code");

      assert.instanceOf(error.cause, AggregateError);
      const aggregateCause = error.cause as AggregateError;
      assert.lengthOf(aggregateCause.errors, 2);
      assert.strictEqual(aggregateCause.cause, aggregateCause.errors[0]);
      assert.instanceOf(aggregateCause.errors[0], BuildCommandFailedError);
      assert.instanceOf(aggregateCause.errors[1], BuildCommandFailedError);
      const primaryError = aggregateCause.errors[0] as BuildCommandFailedError;
      const fallbackError = aggregateCause.errors[1] as BuildCommandFailedError;
      assert.equal(primaryError.command, "magick linux icon 512x512");
      assert.equal(primaryError.exitCode, 1);
      assert.include(primaryError.message, "magick linux icon");
      assert.equal(fallbackError.command, "convert linux icon 512x512");
      assert.equal(fallbackError.exitCode, 2);
      assert.include(fallbackError.message, "convert linux icon");
      assert.deepStrictEqual(
        commands.map(({ command }) => command),
        ["magick", "convert"],
      );
    });
  });

  it.effect("adds only the production renderer protocol", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        true,
        false,
        undefined,
        "/verified/ctox-business-os-shell",
      );

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "dev.workjet.desktop");
      assert.notProperty(mac, "entitlements");
      assert.notProperty(mac, "provisioningProfile");
      assert.deepStrictEqual(mac.protocols, [
        {
          name: "Workjet",
          schemes: ["workjet"],
        },
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("keeps executable resource editing enabled for unsigned Windows builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        "/verified/ctox-business-os-shell",
      );

      const win = config.win as Record<string, unknown>;
      assert.equal(win.icon, "icon.ico");
      assert.equal(win.signAndEditExecutable, true);
      assert.notProperty(win, "azureSignOptions");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("ships the provider-gateway host only once a release has been staged", () => {
    // There is no provider-gateway-host-v* release yet, so pointing
    // electron-builder at a directory that does not exist would break every
    // packaged build today for a binary nobody can ship. Presence of a staged
    // path is the switch, and the wiring is inert until the tag is cut.
    const withoutHost = createDesktopExtraResources("/verified/ctox-business-os-shell");
    assert.isUndefined(
      withoutHost.find((entry) => entry.to === PROVIDER_GATEWAY_HOST_RESOURCE_DIRECTORY),
      "no staged host means no extra-resource entry at all",
    );

    const withHost = createDesktopExtraResources(
      "/verified/ctox-business-os-shell",
      "/stage/provider-gateway-host",
    );
    assert.deepStrictEqual(
      withHost.find((entry) => entry.to === PROVIDER_GATEWAY_HOST_RESOURCE_DIRECTORY),
      { from: "/stage/provider-gateway-host", to: "provider-gateway-host" },
    );
  });

  it("ships the host where the resolver looks for it", () => {
    // The packaging constant and the resolver's constant are declared in two
    // packages that cannot import each other. A rename on one side alone would
    // ship a host the app silently cannot find, so pin the string in both.
    // The two constants live in packages that cannot import each other (the
    // scripts tsconfig does not include apps/desktop), so the agreement is
    // pinned as the same literal on both sides. The other half of this pair is
    // "the packaged resource directory the build script ships to" in
    // apps/desktop/src/providerGateway/ProviderGatewayHostArtifact.test.ts.
    assert.equal(PROVIDER_GATEWAY_HOST_RESOURCE_DIRECTORY, "provider-gateway-host");
  });

  it("stages the resource monitor and verified shell as external resources", () => {
    assert.deepStrictEqual(DESKTOP_RESOURCE_MONITOR_EXTRA_RESOURCE, {
      from: "apps/desktop/prod-resources/resource-monitor",
      to: "resource-monitor",
    });
    assert.deepStrictEqual(createDesktopExtraResources("/verified/ctox-business-os-shell"), [
      DESKTOP_RESOURCE_MONITOR_EXTRA_RESOURCE,
      {
        from: "/verified/ctox-business-os-shell",
        to: CTOX_BUSINESS_OS_SHELL_RESOURCE_DIRECTORY,
      },
      DESKTOP_LEGAL_EXTRA_RESOURCE,
    ]);
    assert.equal(CTOX_BUSINESS_OS_SHELL_RESOURCE_DIRECTORY, "ctox-business-os-shell");
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("mac", "universal"), [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("linux", "x64"), [
      "x86_64-unknown-linux-gnu",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("win", "arm64"), [
      "aarch64-pc-windows-msvc",
    ]);
    assert.equal(resourceMonitorExecutableName("mac"), "t3-resource-monitor");
    assert.equal(resourceMonitorExecutableName("win"), "t3-resource-monitor.exe");
  });
  it.effect("ships the license notices as a packaged extra resource", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      assert.deepStrictEqual(DESKTOP_LEGAL_EXTRA_RESOURCE, { from: "legal", to: "legal" });
      assert.deepStrictEqual(
        [...DESKTOP_LEGAL_NOTICE_FILES],
        ["LICENSE", "LICENSE_POLICY.md", "NOTICE.md"],
      );

      const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
      const stageAppDir = yield* fs.makeTempDirectoryScoped();
      yield* stageLegalNotices({ repoRoot, stageAppDir });
      for (const noticeFile of DESKTOP_LEGAL_NOTICE_FILES) {
        const staged = path.join(stageAppDir, DESKTOP_LEGAL_RESOURCE_DIRECTORY, noticeFile);
        assert.isTrue(yield* fs.exists(staged), `${noticeFile} was not staged`);
        assert.equal(
          yield* fs.readFileString(staged),
          yield* fs.readFileString(path.join(repoRoot, noticeFile)),
        );
      }
      assert.include(
        yield* fs.readFileString(
          path.join(stageAppDir, DESKTOP_LEGAL_RESOURCE_DIRECTORY, "LICENSE"),
        ),
        "Copyright (c) 2026 T3 Tools Inc.",
      );

      // A tree without the notices must fail the build instead of shipping a
      // binary that silently drops the upstream MIT notice.
      const emptyRoot = yield* fs.makeTempDirectoryScoped();
      const failure = yield* stageLegalNotices({
        repoRoot: emptyRoot,
        stageAppDir: yield* fs.makeTempDirectoryScoped(),
      }).pipe(Effect.flip);
      assert.instanceOf(failure, MissingDesktopLegalNoticeError);
      assert.equal(failure.noticeFile, "LICENSE");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it("promotes target fff binaries to direct staged dependencies", () => {
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "universal", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      "@ff-labs/fff-bin-darwin-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("win", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-win32-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-arm64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-arm64-musl": "0.9.4",
    });
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it("derives the electron-builder package manager user agent from packageManager", () => {
    assert.equal(resolvePackageManagerUserAgent("pnpm@11.10.0"), "pnpm/11.10.0");
    assert.equal(resolvePackageManagerUserAgent(" yarn@4.9.2 "), "yarn/4.9.2");
    assert.equal(resolvePackageManagerUserAgent("pnpm"), "pnpm");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it("classifies invalid configured ports with the decoder's number grammar", () => {
    const cause = new Error("invalid configured port");

    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).reason,
      "not-numeric",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("12.5", cause).reason,
      "not-integer",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("65536", cause).reason,
      "out-of-range",
    );
    assert.strictEqual(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).cause,
      cause,
    );
  });

  it.effect("resolves default platform and architecture from host references", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
        wslPrebuild: Option.none(),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "win32"),
            Layer.succeed(HostProcessArchitecture, "x64"),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PROCESSOR_ARCHITECTURE: "AMD64",
                  PROCESSOR_ARCHITEW6432: "ARM64",
                },
              }),
            ),
          ),
        ),
      );

      assert.equal(resolved.platform, "win");
      assert.equal(resolved.target, "nsis");
      assert.equal(resolved.arch, "arm64");
    }),
  );

  it.effect("rejects universal builds on Linux and Windows before staging binaries", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "win"] as const) {
        const error = yield* Effect.flip(
          resolveBuildOptions({
            platform: Option.some(platform),
            target: Option.none(),
            arch: Option.some("universal"),
            buildVersion: Option.none(),
            outputDir: Option.none(),
            skipBuild: Option.none(),
            keepStage: Option.none(),
            signed: Option.none(),
            verbose: Option.none(),
            mockUpdates: Option.none(),
            mockUpdateServerPort: Option.none(),
            wslPrebuild: Option.none(),
          }),
        );

        assert.instanceOf(error, UnsupportedDesktopBuildArchitectureError);
        assert.deepStrictEqual(error.supportedArchitectures, ["x64", "arm64"]);
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        wslPrebuild: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});

// The self-containment check runs the packaged tree in a scratch directory. Its
// own node_modules holds the unpacked externals and must be ignored, but any
// node_modules *above* it would let Node's parent walk satisfy an import that is
// missing from the package, so the probe refuses to run in that case.
it("lists ancestor node_modules, nearest first, excluding the start directory", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"), [
    "C:\\tmp\\probe\\node_modules",
    "C:\\tmp\\node_modules",
    "C:\\node_modules",
  ]);
});

it("includes the filesystem root for posix paths", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("/tmp/probe", "/"), [
    "/tmp/node_modules",
    "/node_modules",
  ]);
});

// A UNC root must keep its \\server\share prefix. Rebuilding it from segments
// produced relative paths, which fs.exists resolves against the build cwd, so
// the guard checked directories that do not exist and silently passed.
it("keeps the prefix of a UNC path instead of going relative", () => {
  const paths = ancestorNodeModulesPaths("\\\\server\\share\\tmp\\app", "\\");
  for (const candidate of paths) {
    assert.ok(candidate.startsWith("\\\\server\\share"), candidate);
  }
  assert.deepStrictEqual(paths[0], "\\\\server\\share\\tmp\\node_modules");
});

it.effect("rebases packaged links into the isolated tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copy-symlinks-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const packageDir = path.join(source, "node_modules/.pnpm/example@1/node_modules/example");
    const relativePackageLink = path.join(source, "node_modules/example-relative");
    const absolutePackageLink = path.join(source, "node_modules/example-absolute");

    yield* fs.makeDirectory(packageDir, { recursive: true });
    yield* fs.writeFileString(path.join(packageDir, "index.js"), "module.exports = true;\n");
    yield* fs.symlink(
      path.join(".pnpm", "example@1", "node_modules", "example"),
      relativePackageLink,
    );
    yield* fs.symlink(packageDir, absolutePackageLink);

    yield* copyDirectoryPreservingSymlinks(source, destination);

    const copiedPackage = path.join(
      destination,
      "node_modules/.pnpm/example@1/node_modules/example",
    );
    const resolvedCopiedPackage = yield* fs.realPath(copiedPackage);
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-relative")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-absolute")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-relative")),
      resolvedCopiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-absolute")),
      resolvedCopiedPackage,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("ignores trailing separators", () => {
  assert.deepStrictEqual(
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app\\", "\\"),
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"),
  );
});
