// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Crash-report metadata, local only.
 *
 * Electron's `crashReporter` writes a minidump plus a small map of string
 * annotations. Two decisions make that safe here:
 *
 *  1. `uploadToServer` is `false`, permanently. This repository has no
 *     consent surface — no dialog, no setting, no privacy policy the user has
 *     agreed to — so there is no honest way to send a crash anywhere. Rather
 *     than ship an upload path guarded by a default, there is NO upload path:
 *     no `submitURL` is configured, and
 *     `SUPPORT_BUNDLE_UPLOAD_SUPPORTED` is a literal `false` the type system
 *     enforces. A minidump stays in Electron's crashes directory, next to the
 *     user, until they choose to do something with it.
 *  2. The annotations are exactly {@link SUPPORT_CRASH_METADATA_KEYS} —
 *     version, commit, platform, arch, channel, packaged — and every one of
 *     them is produced by the support bundle's redaction gate. There is no
 *     `addExtraParameter` wrapper anywhere in the app, so no later caller can
 *     append a seventh key.
 *
 * The reporter starts inside `DesktopApp.startup`, before `app.ready`, so
 * early-startup crashes are captured. `buildCrashReporterOptions` is pure and
 * takes no Electron dependency, which is what lets the configuration itself
 * be asserted in a plain unit test.
 */
import {
  SUPPORT_BUNDLE_UPLOAD_SUPPORTED,
  SUPPORT_CRASH_METADATA_KEYS,
  type SupportCrashMetadata,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronCrashReporter from "../electron/ElectronCrashReporter.ts";
import {
  gateText,
  makeSupportRedactionLedger,
  type SupportRedactionLedger,
} from "./SupportBundleRedaction.ts";

const { logInfo: logCrashInfo, logWarning: logCrashWarning } =
  makeComponentLogger("desktop-crash-reporter");

export interface SupportCrashMetadataInput {
  readonly appVersion: string;
  readonly commitHash: Option.Option<string>;
  readonly platform: string;
  readonly processArch: string;
  readonly updateChannel: string;
  readonly isPackaged: boolean;
  readonly homeDirectory: string;
}

/**
 * Builds the whole annotation map. Every value goes through the gate, and the
 * key set is fixed by {@link SUPPORT_CRASH_METADATA_KEYS}; a caller cannot
 * widen it because the return type is the closed
 * {@link SupportCrashMetadata}.
 */
export function buildSupportCrashMetadata(
  ledger: SupportRedactionLedger,
  input: SupportCrashMetadataInput,
): SupportCrashMetadata {
  const options = { homeDirectory: input.homeDirectory };
  return {
    appVersion: gateText(ledger, input.appVersion, options),
    commitHash: gateText(
      ledger,
      Option.getOrElse(input.commitHash, () => "unknown"),
      options,
    ),
    platform: gateText(ledger, input.platform, options),
    arch: gateText(ledger, input.processArch, options),
    channel: gateText(ledger, input.updateChannel, options),
    packaged: input.isPackaged ? "true" : "false",
  };
}

/**
 * The exact options handed to `crashReporter.start`.
 *
 * `submitURL` is absent by construction — Electron only requires it when
 * `uploadToServer` is true, and leaving it out means there is no address a
 * later edit could accidentally enable. `extra` and `globalExtra` carry the
 * same gated map so a renderer or GPU crash is labelled like a main-process
 * one.
 */
export function buildCrashReporterOptions(input: {
  readonly productName: string;
  readonly metadata: SupportCrashMetadata;
}): Electron.CrashReporterStartOptions {
  const extra: Record<string, string> = {};
  for (const key of SUPPORT_CRASH_METADATA_KEYS) {
    extra[key] = input.metadata[key];
  }

  return {
    productName: input.productName,
    uploadToServer: SUPPORT_BUNDLE_UPLOAD_SUPPORTED,
    compress: true,
    ignoreSystemCrashHandler: false,
    extra,
    globalExtra: { ...extra },
  };
}

export interface DesktopCrashReportingState {
  readonly started: boolean;
  /** Read back from Electron after start, not merely what was requested. */
  readonly uploadToServer: boolean;
  readonly metadata: SupportCrashMetadata;
}

export class DesktopCrashReporting extends Context.Service<
  DesktopCrashReporting,
  {
    /** Starts the reporter. Safe to call once; later calls are no-ops. */
    readonly configure: Effect.Effect<void>;
    readonly state: Effect.Effect<DesktopCrashReportingState>;
  }
>()("@t3tools/desktop/support/DesktopCrashReporting") {}

const EMPTY_METADATA: SupportCrashMetadata = {
  appVersion: "",
  commitHash: "",
  platform: "",
  arch: "",
  channel: "",
  packaged: "false",
};

export const make = Effect.gen(function* () {
  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const crashReporter = yield* ElectronCrashReporter.ElectronCrashReporter;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const stateRef = yield* Ref.make<DesktopCrashReportingState>({
    started: false,
    uploadToServer: false,
    metadata: EMPTY_METADATA,
  });

  const configure = Effect.gen(function* () {
    if ((yield* Ref.get(stateRef)).started) return;

    const currentSettings = yield* settings.get;
    const commitHash = yield* appIdentity.commitHash;
    const ledger = makeSupportRedactionLedger();
    const metadata = buildSupportCrashMetadata(ledger, {
      appVersion: environment.appVersion,
      commitHash,
      platform: environment.platform,
      processArch: environment.processArch,
      updateChannel: currentSettings.updateChannel,
      isPackaged: environment.isPackaged,
      homeDirectory: environment.homeDirectory,
    });

    const started = yield* crashReporter
      .start(buildCrashReporterOptions({ productName: environment.displayName, metadata }))
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          logCrashWarning("crash reporter could not start", {
            error: error.message,
          }).pipe(Effect.as(false)),
        ),
      );

    const uploadToServer = started ? yield* crashReporter.getUploadToServer : false;
    yield* Ref.set(stateRef, { started, uploadToServer, metadata });

    if (started) {
      yield* logCrashInfo("crash reporter started", {
        uploadToServer,
        annotationKeys: SUPPORT_CRASH_METADATA_KEYS.length,
      });
    }
  }).pipe(Effect.withSpan("desktop.crashReporting.configure"));

  return DesktopCrashReporting.of({
    configure,
    state: Ref.get(stateRef),
  });
});

export const layer = Layer.effect(DesktopCrashReporting, make);
