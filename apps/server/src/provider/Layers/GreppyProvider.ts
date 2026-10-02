import {
  type GreppySettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@workjet/contracts";
import { createModelCapabilities } from "@workjet/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  type ServerProviderDraft,
  providerModelsFromSettings,
} from "../providerSnapshot.ts";
import {
  GREPPY_DISABLED_MESSAGE,
  GREPPY_HTTPS_MESSAGE,
  GREPPY_MISSING_MESSAGE,
  GREPPY_MODEL_MESSAGE,
  classifyGreppyVersion,
  greppyInstalledMessage,
  greppyVersionRefusal,
  plainHttpEndpoint,
} from "../greppy/GreppyProtocol.ts";

const PRESENTATION = {
  displayName: "Greppy",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export const greppyModelsFromSettings = (
  settings: GreppySettings,
): ReadonlyArray<ServerProviderModel> => {
  const configured = settings.model.trim();
  const builtIn: ReadonlyArray<ServerProviderModel> =
    configured.length > 0
      ? [{ slug: configured, name: configured, isCustom: false, capabilities: EMPTY_CAPABILITIES }]
      : [];
  return providerModelsFromSettings(builtIn, settings.customModels ?? [], EMPTY_CAPABILITIES);
};

const probeMessage = (settings: GreppySettings, version: string | null): string => {
  const notes: string[] = [];
  if (version === null) {
    notes.push(
      "Greppy answered --version, but Workjet could not read a 0.4.x version. The gateway is checked when a thread starts.",
    );
  } else {
    notes.push(greppyInstalledMessage(version));
  }
  if (settings.model.trim().length === 0) notes.push(GREPPY_MODEL_MESSAGE);
  if (plainHttpEndpoint(settings.endpoint) === null) notes.push(GREPPY_HTTPS_MESSAGE);
  return notes.join(" ");
};

const runVersion = (binary: string, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(binary, ["--version"], {
        env: environment,
        extendEnv: false,
        shell: false,
      }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code };
  }).pipe(Effect.scoped);

export const buildInitialGreppyProviderSnapshot = (settings: GreppySettings) =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = greppyModelsFromSettings(settings);
    if (!settings.enabled) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: GREPPY_DISABLED_MESSAGE,
        },
      });
    }
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Greppy...",
      },
    });
  });

export const checkGreppyProviderStatus = Effect.fn("checkGreppyProviderStatus")(function* (
  settings: GreppySettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = greppyModelsFromSettings(settings);
  if (!settings.enabled) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: GREPPY_DISABLED_MESSAGE,
      },
    });
  }

  const binary = settings.binaryPath || "greppy";
  const probed = yield* runVersion(binary, environment).pipe(
    Effect.timeoutOption("8 seconds"),
    Effect.result,
  );
  if (Result.isFailure(probed)) {
    const missing = isCommandMissingCause(probed.failure);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing ? GREPPY_MISSING_MESSAGE : "Failed to execute Greppy (`greppy --version`).",
      },
    });
  }
  if (Option.isNone(probed.success)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Greppy `--version` timed out.",
      },
    });
  }

  const result = probed.success.value;
  if (result.code !== 0) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: result.stderr.trim() || `Greppy --version exited with code ${result.code}.`,
      },
    });
  }

  const version = classifyGreppyVersion(result.stdout);
  if (version.kind === "unsupported") {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: version.version,
        status: "error",
        auth: { status: "unknown" },
        message: greppyVersionRefusal(version.version),
      },
    });
  }

  const parsed = version.kind === "supported" ? version.version : null;
  const needsAttention = parsed === null || settings.model.trim().length === 0 || plainHttpEndpoint(settings.endpoint) === null;
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsed,
      status: needsAttention ? "warning" : "ready",
      auth: { status: "unknown" },
      message: probeMessage(settings, parsed),
    },
  });
});
