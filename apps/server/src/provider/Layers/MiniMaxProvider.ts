import type { MiniMaxSettings } from "@workjet/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { buildServerProvider, collectStreamAsString, isCommandMissingCause, type ServerProviderDraft } from "../providerSnapshot.ts";
import { makeMiniMaxAcpRuntime, miniMaxEnvironment } from "../acp/MiniMaxAcpSupport.ts";
import { miniMaxModelsFromConfig, resolveMiniMaxModelValue, MINIMAX_CODE_RELEASE } from "../minimax/MiniMaxProtocol.ts";

const ProbeCursor = Schema.Struct({ sessionId: Schema.String, profileKey: Schema.String });
const decodeProbeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(ProbeCursor));

const PRESENTATION = { displayName: "MiniMax Code", showInteractionModeToggle: true, requiresNewThreadForModelChange: false } as const;

export const buildInitialMiniMaxProviderSnapshot = (settings: MiniMaxSettings) => Effect.gen(function* () {
  return buildServerProvider({ presentation: PRESENTATION, enabled: settings.enabled, checkedAt: DateTime.formatIso(yield* DateTime.now), models: [], probe: { installed: false, version: null, status: "warning", auth: { status: "unknown" }, message: settings.enabled ? "Checking MiniMax Code on this computer..." : "MiniMax Code is disabled." } });
});

/** Discover through the actual authenticated ACP runtime; configured model strings are not evidence. */
export const checkMiniMaxProviderStatus = Effect.fn("checkMiniMaxProviderStatus")(function* (
  settings: MiniMaxSettings,
  environment: NodeJS.ProcessEnv = process.env,
  probeSessionPath?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const snapshot = (probe: Parameters<typeof buildServerProvider>[0]["probe"], models: ServerProviderDraft["models"] = []) => buildServerProvider({ presentation: PRESENTATION, enabled: settings.enabled, checkedAt, models, probe });
  if (!settings.enabled) return snapshot({ installed: false, version: null, status: "warning", auth: { status: "unknown" }, message: "MiniMax Code is disabled." });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const versionResult = yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(ChildProcess.make(settings.binaryPath || "mcode", ["--version"], { env: miniMaxEnvironment(settings, environment), extendEnv: false, shell: false }));
    const [stdout, code] = yield* Effect.all([collectStreamAsString(child.stdout), child.exitCode.pipe(Effect.map(Number))], { concurrency: 2 });
    return { stdout, code };
  }).pipe(Effect.scoped, Effect.timeoutOption("8 seconds"), Effect.result);
  if (Result.isFailure(versionResult)) return snapshot({ installed: !isCommandMissingCause(versionResult.failure), version: null, status: "error", auth: { status: "unknown" }, message: "MiniMax Code could not be started. Install the pinned official CLI or choose its executable path on this computer." });
  if (Option.isNone(versionResult.success)) return snapshot({ installed: true, version: null, status: "error", auth: { status: "unknown" }, message: "MiniMax Code version probe timed out." });
  const version = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(versionResult.success.value.stdout)?.[1] ?? null;
  if (versionResult.success.value.code !== 0 || version !== MINIMAX_CODE_RELEASE.version) return snapshot({ installed: true, version, status: "error", auth: { status: "unknown" }, message: `This adapter is verified against MiniMax Code ${MINIMAX_CODE_RELEASE.version}. Select the pinned executable before starting a session.` });
  // ACP exposes model options only on session setup. Reuse one dedicated status
  // session between refreshes and application restarts.

  const fs = yield* FileSystem.FileSystem;
  const cwd = environment.PWD || process.cwd();
  const profileKey = createHash("sha256").update(JSON.stringify([settings.dataDirectory || environment.MINIMAX_DATA_DIR || environment.MAVIS_DATA_DIR || "default", environment.HOME || ""])).digest("hex");
  const stored = probeSessionPath ? yield* fs.readFileString(probeSessionPath).pipe(Effect.orElseSucceed(() => "")) : "";
  const cursor = decodeProbeCursor(stored);
  const resumeSessionId = cursor._tag === "Some" && cursor.value.profileKey === profileKey ? cursor.value.sessionId : undefined;
  const discovered = yield* Effect.gen(function* () {
    const acp = yield* makeMiniMaxAcpRuntime({ config: settings, environment, spawner, cwd, clientInfo: { name: "workjet-status", version: "1" }, mcpServers: [], ...(resumeSessionId ? { resumeSessionId, requireLoadResponse: true } : {}) });
    const started = yield* acp.start();
    if (probeSessionPath) yield* fs.writeFileString(probeSessionPath, JSON.stringify({ sessionId: started.sessionId, profileKey }));
    if (started.initializeResult.agentInfo?.name !== "minimax-code" || started.initializeResult.agentInfo.version !== MINIMAX_CODE_RELEASE.version) return yield* Effect.fail(new Error("Unexpected MiniMax Code ACP executable identity."));
    const configOptions = yield* acp.getConfigOptions;
    const initialModels = miniMaxModelsFromConfig(configOptions);
    if (initialModels.some((entry) => entry.slug === settings.model)) {
      const selected = yield* Effect.try({ try: () => resolveMiniMaxModelValue(configOptions, settings.model), catch: (cause) => cause });
      yield* acp.setModel(selected);
    }
    const models = miniMaxModelsFromConfig(yield* acp.getConfigOptions);
    yield* acp.request("session/close", { sessionId: started.sessionId }).pipe(Effect.ignore);
    return models;
  }).pipe(Effect.scoped, Effect.timeoutOption("20 seconds"), Effect.result);

  if (Result.isFailure(discovered) || Option.isNone(discovered.success)) return snapshot({ installed: true, version, status: "warning", auth: { status: "unknown" }, message: "MiniMax Code authentication or ACP model discovery failed. Sign in with mcode login on this computer, or configure its existing authorized provider, then refresh." });
  const models = discovered.success.value;
  const available = models.some((model) => model.slug === settings.model);
  return snapshot({ installed: true, version, status: available ? "ready" : "warning", auth: { status: "authenticated" }, message: available ? `MiniMax Code ${version} is ready.` : `The authenticated runtime does not advertise ${settings.model}. Check this computer's account and route; Workjet will not substitute another model.` }, models);
});
