// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Thin Effect wrapper over Electron's `crashReporter`, so the policy that
 * decides WHAT a crash report may carry (`DesktopCrashReporting`) can be
 * tested without an Electron runtime.
 *
 * The wrapper deliberately exposes no `addExtraParameter`. Electron lets any
 * process append arbitrary key/value annotations to a crash report after the
 * reporter has started, which would be a second, ungated path for data to
 * leave the machine. Everything this app attaches goes through
 * `DesktopCrashReporting`, at start, past the redaction gate, once.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export class ElectronCrashReporterStartError extends Schema.TaggedErrorClass<ElectronCrashReporterStartError>()(
  "ElectronCrashReporterStartError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to start the Electron crash reporter.";
  }
}

export class ElectronCrashReporter extends Context.Service<
  ElectronCrashReporter,
  {
    readonly start: (
      options: Electron.CrashReporterStartOptions,
    ) => Effect.Effect<void, ElectronCrashReporterStartError>;
    /**
     * Electron's own view of the upload setting. Read back after start so the
     * support bundle reports what the runtime actually does, not what this
     * code asked for.
     */
    readonly getUploadToServer: Effect.Effect<boolean>;
    readonly getCrashesDirectory: Effect.Effect<string>;
  }
>()("@t3tools/desktop/electron/ElectronCrashReporter") {}

export const make = ElectronCrashReporter.of({
  start: (options) =>
    Effect.try({
      try: () => {
        Electron.crashReporter.start(options);
      },
      catch: (cause) => new ElectronCrashReporterStartError({ cause }),
    }),
  // Both reads are best-effort: `getUploadToServer` throws on Linux when the
  // reporter has not started, and the crashes directory is unset before
  // `app.ready`. A failed read must never take the app down.
  getUploadToServer: Effect.sync(() => Electron.crashReporter.getUploadToServer()).pipe(
    Effect.orElseSucceed(() => false),
  ),
  getCrashesDirectory: Effect.sync(() => Electron.app.getPath("crashDumps")).pipe(
    Effect.orElseSucceed(() => ""),
  ),
});

export const layer = Layer.succeed(ElectronCrashReporter, make);
