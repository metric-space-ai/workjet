// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SUPPORT_CRASH_METADATA_KEYS } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronCrashReporter from "../electron/ElectronCrashReporter.ts";
import * as DesktopCrashReporting from "./DesktopCrashReporting.ts";

const HOME_DIRECTORY = "/Users/canary";

const environmentLayer = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: HOME_DIRECTORY,
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: true,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
});

const appIdentityLayer = Layer.succeed(DesktopAppIdentity.DesktopAppIdentity, {
  resolveUserDataPath: Effect.succeed("/tmp/userdata"),
  commitHash: Effect.succeed(Option.some("a1b2c3d4e5f6")),
  configure: Effect.void,
} satisfies DesktopAppIdentity.DesktopAppIdentity["Service"]);

const makeSettingsLayer = (settings: DesktopAppSettings.DesktopSettings) =>
  Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    load: Effect.succeed(settings),
    get: Effect.succeed(settings),
    setMainWindowBounds: () => Effect.die("unexpected setMainWindowBounds"),
    setServerExposureMode: () => Effect.die("unexpected setServerExposureMode"),
    setTailscaleServe: () => Effect.die("unexpected setTailscaleServe"),
    setUpdateChannel: () => Effect.die("unexpected setUpdateChannel"),
    setWslBackendEnabled: () => Effect.die("unexpected setWslBackendEnabled"),
    setWslDistro: () => Effect.die("unexpected setWslDistro"),
    setWslOnly: () => Effect.die("unexpected setWslOnly"),
    applyWslWindowsFallback: Effect.die("unexpected applyWslWindowsFallback"),
    applyWslWindowsFallbackInMemory: Effect.die("unexpected applyWslWindowsFallbackInMemory"),
  } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

const makeRecordingCrashReporterLayer = (
  recorded: Ref.Ref<ReadonlyArray<Electron.CrashReporterStartOptions>>,
) =>
  Layer.succeed(ElectronCrashReporter.ElectronCrashReporter, {
    start: (options) => Ref.update(recorded, (all) => [...all, options]),
    getUploadToServer: Effect.succeed(false),
    getCrashesDirectory: Effect.succeed("/tmp/crashes"),
  } satisfies ElectronCrashReporter.ElectronCrashReporter["Service"]);

const configureAndRecord = (settings: DesktopAppSettings.DesktopSettings) =>
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<Electron.CrashReporterStartOptions>>([]);
    const crashReporting = yield* DesktopCrashReporting.make.pipe(
      Effect.provide(makeRecordingCrashReporterLayer(recorded)),
    );
    yield* crashReporting.configure;
    // A second call must not re-start the reporter.
    yield* crashReporting.configure;
    return {
      started: yield* Ref.get(recorded),
      state: yield* crashReporting.state,
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(appIdentityLayer, makeSettingsLayer(settings)).pipe(
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(DesktopConfig.layerTest({})),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("DesktopCrashReporting", () => {
  it.effect("never uploads and configures no submit URL", () =>
    Effect.gen(function* () {
      const outcome = yield* configureAndRecord(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
      assert.strictEqual(outcome.started.length, 1);

      const options = outcome.started[0];
      assert.isDefined(options);
      assert.strictEqual(options?.uploadToServer, false);
      assert.isUndefined(options?.submitURL);
      assert.strictEqual(options?.compress, true);
      assert.strictEqual(options?.ignoreSystemCrashHandler, false);
      assert.strictEqual(outcome.state.started, true);
      assert.strictEqual(outcome.state.uploadToServer, false);
    }),
  );

  it.effect("attaches exactly the declared metadata keys", () =>
    Effect.gen(function* () {
      const outcome = yield* configureAndRecord(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
      const options = outcome.started[0];
      assert.deepStrictEqual(
        Object.keys(options?.extra ?? {}).sort(),
        [...SUPPORT_CRASH_METADATA_KEYS].sort(),
      );
      assert.deepStrictEqual(
        Object.keys(options?.globalExtra ?? {}).sort(),
        [...SUPPORT_CRASH_METADATA_KEYS].sort(),
      );
      assert.deepStrictEqual(options?.extra, {
        appVersion: "1.2.3",
        commitHash: "a1b2c3d4e5f6",
        platform: "darwin",
        arch: "arm64",
        channel: "latest",
        packaged: "true",
      });
    }),
  );

  it("gates every metadata value, so no secret can reach extra", () => {
    const ledger = {
      redactedFieldCount: 0,
      omittedFieldCount: 0,
      cleanFieldCount: 0,
    };
    const metadata = DesktopCrashReporting.buildSupportCrashMetadata(ledger, {
      // Every one of these is a shape a mis-plumbed caller could supply.
      appVersion: "1.2.3+build/Users/canary/secret",
      commitHash: Option.some("sk-ant-api03-9zQx4Lm2Rt8Wv6Yb1Nc3Kd5Fg7Hj0Ps"),
      platform: "darwin",
      processArch: "arm64",
      updateChannel: "canary@example.com",
      isPackaged: false,
      homeDirectory: HOME_DIRECTORY,
    });

    const serialized = JSON.stringify(metadata);
    assert.isFalse(serialized.includes("sk-ant-api03"));
    assert.isFalse(serialized.includes("canary"));
    assert.strictEqual(metadata.packaged, "false");
    assert.isAbove(ledger.redactedFieldCount, 0);

    const options = DesktopCrashReporting.buildCrashReporterOptions({
      productName: "CTOX Desktop App",
      metadata,
    });
    const extraSerialized = JSON.stringify(options.extra);
    assert.isFalse(extraSerialized.includes("sk-ant-api03"));
    assert.isFalse(extraSerialized.includes("canary"));
    assert.strictEqual(options.uploadToServer, false);
  });
});
