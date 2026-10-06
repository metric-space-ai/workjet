// @effect-diagnostics nodeBuiltinImport:off
import type { MiniMaxSettings } from "@workjet/contracts";
import { resolveSpawnCommand } from "@workjet/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { AcpRequestError } from "effect-acp/errors";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeMiniMaxAcpRuntime, miniMaxEnvironment } from "../acp/MiniMaxAcpSupport.ts";
import {
  miniMaxModelsFromConfig,
  resolveMiniMaxModelValue,
  MINIMAX_CODE_RELEASE,
} from "../minimax/MiniMaxProtocol.ts";

const ProbeCursor = Schema.Struct({ sessionId: Schema.String, profileKey: Schema.String });
const decodeProbeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(ProbeCursor));
const encodeProbeCursor = Schema.encodeSync(Schema.fromJsonString(ProbeCursor));
const encodeProfileKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const isAcpRequestError = Schema.is(AcpRequestError);
class MiniMaxProbeCompatibilityError extends Schema.TaggedErrorClass<MiniMaxProbeCompatibilityError>()(
  "MiniMaxProbeCompatibilityError",
  { message: Schema.String },
) {}

const PRESENTATION = {
  displayName: "MiniMax Code",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;
export const MINIMAX_GATEWAY_UNSUPPORTED =
  "MiniMax Code requires an explicitly configured provider route in its selected profile. Workjet gateway injection is not verified for this CLI. Disable the gateway option and select an authorized native profile.";

/** No direct-profile probe can establish readiness for an unsupported gateway route. */
export const buildMiniMaxGatewayUnavailableSnapshot = (settings: MiniMaxSettings) =>
  Effect.gen(function* () {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: settings.enabled ? MINIMAX_GATEWAY_UNSUPPORTED : "MiniMax Code is disabled.",
      },
    });
  });

export const buildInitialMiniMaxProviderSnapshot = (settings: MiniMaxSettings) =>
  Effect.gen(function* () {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking MiniMax Code on this computer..."
          : "MiniMax Code is disabled.",
      },
    });
  });

/** Discover through the actual authenticated ACP runtime; configured model strings are not evidence. */
export const checkMiniMaxProviderStatus = Effect.fn("checkMiniMaxProviderStatus")(function* (
  settings: MiniMaxSettings,
  environment: NodeJS.ProcessEnv = process.env,
  probeSessionPath?: string,
  probeCwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const snapshot = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    models: ServerProviderDraft["models"] = [],
  ) =>
    buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe,
    });
  if (!settings.enabled)
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "MiniMax Code is disabled.",
    });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const versionResult = yield* Effect.gen(function* () {
    const env = miniMaxEnvironment(settings, environment);
    const command = yield* resolveSpawnCommand(settings.binaryPath || "mcode", ["--version"], {
      env,
      extendEnv: false,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        env,
        extendEnv: false,
        shell: command.shell,
      }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: 2 },
    );
    return { output: `${stdout}\n${stderr}`, code };
  }).pipe(Effect.scoped, Effect.timeoutOption("8 seconds"), Effect.result);
  if (Result.isFailure(versionResult))
    return snapshot({
      installed: !isCommandMissingCause(versionResult.failure),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message:
        "MiniMax Code could not be started. Install the pinned official CLI or choose its executable path on this computer.",
    });
  if (Option.isNone(versionResult.success))
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "MiniMax Code version probe timed out.",
    });
  const version =
    /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(versionResult.success.value.output)?.[1] ?? null;
  if (versionResult.success.value.code !== 0 || version !== MINIMAX_CODE_RELEASE.version)
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `This adapter requires MiniMax Code ${MINIMAX_CODE_RELEASE.version}. Select the pinned executable before starting a session.`,
    });
  // ACP exposes model options only on session setup. Reuse one dedicated status
  // session between refreshes and application restarts.

  const fs = yield* FileSystem.FileSystem;
  const cwd = probeCwd ?? environment.PWD ?? process.cwd();
  const profileKey = NodeCrypto.createHash("sha256")
    .update(
      encodeProfileKey([
        settings.dataDirectory ||
          environment.MINIMAX_DATA_DIR ||
          environment.MAVIS_DATA_DIR ||
          "default",
        environment.HOME || "",
      ]),
    )
    .digest("hex");
  const stored = probeSessionPath
    ? yield* fs.readFileString(probeSessionPath).pipe(Effect.orElseSucceed(() => ""))
    : "";
  const cursor = decodeProbeCursor(stored);
  const resumeSessionId =
    cursor._tag === "Some" && cursor.value.profileKey === profileKey
      ? cursor.value.sessionId
      : undefined;
  const discover = (resumeSessionId?: string) =>
    Effect.gen(function* () {
      const acp = yield* makeMiniMaxAcpRuntime({
        config: settings,
        environment,
        spawner,
        cwd,
        clientInfo: { name: "workjet-status", version: "1" },
        mcpServers: [],
        ...(resumeSessionId ? { resumeSessionId, requireLoadResponse: true } : {}),
      });
      const started = yield* acp.start();
      if (
        started.initializeResult.agentInfo?.name !== "minimax-code" ||
        started.initializeResult.agentInfo.version !== MINIMAX_CODE_RELEASE.version
      )
        return yield* new MiniMaxProbeCompatibilityError({
          message: "Unexpected MiniMax Code ACP executable identity.",
        });
      if (probeSessionPath)
        yield* fs.writeFileString(
          probeSessionPath,
          encodeProbeCursor({ sessionId: started.sessionId, profileKey }),
        );
      const configOptions = yield* acp.getConfigOptions;
      const initialModels = miniMaxModelsFromConfig(configOptions);
      if (initialModels.some((entry) => entry.slug === settings.model)) {
        // Multiple routes require a user choice. Keep the catalog visible without
        // guessing a route merely to inspect effort options.
        const selected = yield* Effect.try({
          try: () => resolveMiniMaxModelValue(configOptions, settings.model),
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined));
        if (selected !== undefined) yield* acp.setModel(selected);
      }
      const models = miniMaxModelsFromConfig(yield* acp.getConfigOptions);
      yield* acp.request("session/close", { sessionId: started.sessionId }).pipe(Effect.ignore);
      return models;
    }).pipe(Effect.scoped);
  // Only the disposable status session may be replaced after a native missing
  // session response. User conversation loads remain strict.
  const discovered = yield* discover(resumeSessionId).pipe(
    Effect.catch((failure) =>
      resumeSessionId &&
      isAcpRequestError(failure) &&
      failure.method === "session/load" &&
      failure.code === -32002
        ? discover()
        : Effect.fail(failure),
    ),
    Effect.timeoutOption("20 seconds"),
    Effect.result,
  );

  if (Result.isFailure(discovered)) {
    const failure = discovered.failure;
    if (isAcpRequestError(failure) && failure.code === -32000)
      return snapshot({
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          "MiniMax Code requires authentication. Run mcode login on this computer, or configure its authorized provider, then refresh.",
      });
    if (failure instanceof MiniMaxProbeCompatibilityError)
      return snapshot({
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "The executable does not identify itself as the pinned official MiniMax Code ACP agent.",
      });
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message:
        "MiniMax Code ACP discovery failed. Check the selected executable, profile and connection on this computer, then refresh.",
    });
  }
  if (Option.isNone(discovered.success))
    return snapshot({
      installed: true,
      version,
      status: "warning",
      auth: { status: "unknown" },
      message:
        "MiniMax Code ACP model discovery timed out. Check the connection on this computer, then refresh.",
    });
  const models = discovered.success.value;
  const available = models.some((model) => model.slug === settings.model);
  return snapshot(
    {
      installed: true,
      version,
      status: available ? "ready" : "warning",
      auth: { status: "authenticated" },
      message: available
        ? `MiniMax Code ${version} is ready.`
        : `The authenticated runtime does not advertise ${settings.model}. Check this computer's account and route; Workjet will not substitute another model.`,
    },
    models,
  );
});
