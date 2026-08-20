// @effect-diagnostics nodeBuiltinImport:off -- This module IS the Node platform implementation behind the injected `GreppyRuntimePlatform` interface: `nodeRun` supervises a `child_process` it must SIGKILL, `nodeDownload` polices its own HTTPS redirect chain byte by byte before anything touches disk, and `nodePlatform` performs the mkdtemp/rename/chmod activation dance. Everything above `GreppyRuntimePlatform` is ordinary Effect code and receives a fake in tests.
import { WorkjetGreppyOperationError } from "@t3tools/contracts";
import {
  decodeGreppyIndexStatus,
  decodePinnedGreppyModelManifest,
  GREPPY_MODEL_ASSETS,
  GREPPY_RUNTIME_PIN,
  GREPPY_STORE_ENV,
  isGreppyIndexReady,
  isGreppyIndexing,
  GreppyRuntimeReason as GreppyRuntimeReasonSchema,
  type GreppyRuntimeReason,
  type GreppyRuntimeSnapshot,
  type GreppyRuntimeSource,
  WORKJET_GREPPY_BUILD_TEMP_ROOT_ENV,
  WORKJET_GREPPY_EXECUTABLE_ENV,
} from "@metric-space-ai/workjet-capabilities";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as Https from "node:https";
import * as Os from "node:os";
import * as NodePath from "node:path";
import { spawn } from "node:child_process";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";

const PROBE_MAX_BYTES = 16 * 1024;
const STATUS_MAX_BYTES = 64 * 1024;
const PROCESS_MAX_BYTES = 128 * 1024;
const SOURCE_MAX_BYTES = 128 * 1024 * 1024;
const MODEL_MAX_BYTES = 600 * 1024 * 1024;
const MODEL_TOTAL_MAX_BYTES = 900 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
const ARCHIVE_LIST_MAX_BYTES = 4 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 20_000;
const INDEX_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 60 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const INSTALL_SENTINEL = `${GREPPY_RUNTIME_PIN.version}\n${GREPPY_RUNTIME_PIN.sourceSha256}\n`;

export type DownloadPolicy = "source" | "model";

export const isAllowedGreppyDownloadUrl = (
  url: URL,
  policy: DownloadPolicy,
  initial: boolean,
): boolean => {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  if (policy === "source") {
    if (initial) return url.toString() === GREPPY_RUNTIME_PIN.sourceUrl;
    return (
      url.hostname === "codeload.github.com" &&
      url.pathname === `/metric-space-ai/greppy/tar.gz/${GREPPY_RUNTIME_PIN.commit}` &&
      url.search === "" &&
      url.hash === ""
    );
  }
  if (initial) return url.hostname === "huggingface.co";
  return url.hostname === "huggingface.co" || url.hostname.endsWith(".hf.co");
};

export const greppyModelUrl = (asset: (typeof GREPPY_MODEL_ASSETS)[number]): URL | undefined => {
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(asset.repository)) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.file)) return undefined;
  if (!/^[a-f0-9]{40}$/.test(asset.revision)) return undefined;
  const url = new URL(
    `https://huggingface.co/${asset.repository}/resolve/${asset.revision}/${asset.file}`,
  );
  return isAllowedGreppyDownloadUrl(url, "model", true) ? url : undefined;
};

export const isConfinedGreppyAssetPath = (sourceRoot: string, destination: string): boolean => {
  if (
    destination.length === 0 ||
    NodePath.isAbsolute(destination) ||
    destination.includes("\\") ||
    destination.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return false;
  }
  const root = NodePath.resolve(sourceRoot);
  const resolved = NodePath.resolve(root, destination);
  return resolved.startsWith(`${root}${NodePath.sep}`);
};

export const validateGreppyArchiveEntries = (entries: ReadonlyArray<string>): boolean =>
  entries.length > 0 &&
  entries.every((entry) => {
    if (entry.includes("\\") || entry.startsWith("/") || entry.includes("\0")) return false;
    const parts = entry.split("/").filter(Boolean);
    return (
      entry.startsWith(GREPPY_RUNTIME_PIN.archivePrefix) &&
      parts.length > 0 &&
      parts.every((part) => part !== "." && part !== "..")
    );
  });

export class GreppyRuntimeError extends Schema.TaggedErrorClass<GreppyRuntimeError>()(
  "GreppyRuntimeError",
  { reason: GreppyRuntimeReasonSchema },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported-host":
        return "Managed Greppy is unsupported on this host.";
      case "override-invalid":
        return "The configured Workjet Greppy override is unusable.";
      case "version-mismatch":
      case "surface-mismatch":
      case "managed-invalid":
        return "The Greppy runtime is incompatible.";
      case "path-unavailable":
      case "binary-unavailable":
        return "Greppy is unavailable on this server.";
      case "timeout":
        return "Greppy runtime operation timed out.";
      case "malformed-response":
      case "oversized-response":
        return "Greppy returned an invalid runtime response.";
      case "index-unavailable":
        return "Greppy indexing is not ready for this workspace.";
      case "process-exit":
      case "install-failed":
        return "Greppy runtime operation failed.";
    }
  }
}

export interface RuntimeCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

export interface RuntimeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
}

export interface RuntimeDownloadResult {
  readonly sha256: string;
  readonly bytes: number;
  readonly finalUrl: string;
  readonly redirects: ReadonlyArray<string>;
}

export interface GreppyRuntimePlatform {
  readonly platform: string;
  readonly arch: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly temporaryDirectory: string;
  readonly statExecutable: (path: string) => Promise<boolean>;
  readonly realpath: (path: string) => Promise<string>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly makeTempDirectory: (parent: string, prefix: string) => Promise<string>;
  readonly readText: (path: string, maximumBytes: number) => Promise<string>;
  readonly writeText: (path: string, content: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly copyFile: (from: string, to: string) => Promise<void>;
  readonly chmodExecutable: (path: string) => Promise<void>;
  readonly run: (command: RuntimeCommand) => Promise<RuntimeCommandResult>;
  readonly download: (input: {
    readonly url: string;
    readonly destination: string;
    readonly maximumBytes: number;
    readonly timeoutMs: number;
    readonly policy: DownloadPolicy;
  }) => Promise<RuntimeDownloadResult>;
}

export interface ResolvedGreppyRuntime {
  readonly executable: string;
  readonly source: GreppyRuntimeSource;
  readonly storeDir: string;
}

export interface GreppyWorkspaceReadiness extends ResolvedGreppyRuntime {
  readonly cwd: string;
  readonly status: "ready" | "indexing";
}

export interface GreppyRuntimeShape {
  readonly storeDir: string;
  readonly resolve: () => Effect.Effect<ResolvedGreppyRuntime, GreppyRuntimeError>;
  readonly inspect: () => Effect.Effect<GreppyRuntimeSnapshot>;
  readonly install: () => Effect.Effect<GreppyRuntimeSnapshot, GreppyRuntimeError>;
  readonly ensureWorkspace: (
    cwd: string,
  ) => Effect.Effect<GreppyWorkspaceReadiness, GreppyRuntimeError>;
}

export class GreppyRuntime extends Context.Service<GreppyRuntime, GreppyRuntimeShape>()(
  "t3/mcp/toolkits/workjet/GreppyRuntime",
) {}

interface RuntimePaths {
  readonly storeDir: string;
  readonly runtimeParent: string;
  readonly versionDir: string;
  readonly executable: string;
  readonly sentinel: string;
}

const runtimePaths = (stateDir: string): RuntimePaths => {
  const runtimeParent = NodePath.join(stateDir, "greppy-runtime");
  const versionDir = NodePath.join(runtimeParent, GREPPY_RUNTIME_PIN.version);
  return {
    storeDir: NodePath.join(stateDir, "greppy"),
    runtimeParent,
    versionDir,
    executable: NodePath.join(versionDir, "greppy"),
    sentinel: NodePath.join(versionDir, ".install-complete"),
  };
};

const safeError = (reason: GreppyRuntimeReason) => new GreppyRuntimeError({ reason });

const isGreppyRuntimeError = Schema.is(GreppyRuntimeError);

export const toWorkjetGreppyOperationError = (
  error: GreppyRuntimeError,
): WorkjetGreppyOperationError => new WorkjetGreppyOperationError({ reason: error.reason });

const runChecked = async (
  platform: GreppyRuntimePlatform,
  command: RuntimeCommand,
  nonzeroReason: GreppyRuntimeReason = "process-exit",
): Promise<RuntimeCommandResult> => {
  let result: RuntimeCommandResult;
  try {
    result = await platform.run(command);
  } catch {
    throw safeError("binary-unavailable");
  }
  if (result.timedOut) throw safeError("timeout");
  if (result.outputExceeded || result.stdoutBytes > command.maximumOutputBytes) {
    throw safeError("oversized-response");
  }
  if (result.exitCode !== 0) throw safeError(nonzeroReason);
  return result;
};

const commandEnv = (storeDir: string): Readonly<Record<string, string>> => ({
  [GREPPY_STORE_ENV]: storeDir,
});

const validateCandidate = async (
  platform: GreppyRuntimePlatform,
  executable: string,
  storeDir: string,
): Promise<void> => {
  if (!(await platform.statExecutable(executable).catch(() => false))) {
    throw safeError("binary-unavailable");
  }
  const version = await runChecked(platform, {
    executable,
    args: ["--version"],
    env: commandEnv(storeDir),
    timeoutMs: PROBE_TIMEOUT_MS,
    maximumOutputBytes: PROBE_MAX_BYTES,
  });
  if (version.stdout.trim() !== `greppy ${GREPPY_RUNTIME_PIN.version}`) {
    throw safeError("version-mismatch");
  }
  const searchHelp = await runChecked(platform, {
    executable,
    args: ["search", "--help"],
    env: commandEnv(storeDir),
    timeoutMs: PROBE_TIMEOUT_MS,
    maximumOutputBytes: PROBE_MAX_BYTES,
  });
  if (
    !["--root", "--json", "--limit", "--max-bytes"].every((flag) =>
      searchHelp.stdout.includes(flag),
    )
  ) {
    throw safeError("surface-mismatch");
  }
  const indexHelp = await runChecked(platform, {
    executable,
    args: ["index", "--help"],
    env: commandEnv(storeDir),
    timeoutMs: PROBE_TIMEOUT_MS,
    maximumOutputBytes: PROBE_MAX_BYTES,
  });
  if (!["status", "--json", "--root"].every((token) => indexHelp.stdout.includes(token))) {
    throw safeError("surface-mismatch");
  }
};

const managedComplete = async (
  platform: GreppyRuntimePlatform,
  paths: RuntimePaths,
): Promise<boolean> => {
  if (!(await platform.exists(paths.sentinel))) return false;
  return (await platform.readText(paths.sentinel, 256).catch(() => "")) === INSTALL_SENTINEL;
};

const supportedHost = (platform: GreppyRuntimePlatform): boolean =>
  (platform.platform === "darwin" || platform.platform === "linux") &&
  (platform.arch === "arm64" || platform.arch === "x64");

const resolveFromPath = async (
  platform: GreppyRuntimePlatform,
  paths: RuntimePaths,
): Promise<ResolvedGreppyRuntime> => {
  const searchPath = platform.environment.PATH ?? "";
  const executableNames = platform.platform === "win32" ? ["greppy.exe", "greppy"] : ["greppy"];
  for (const directory of searchPath.split(NodePath.delimiter)) {
    if (directory.length === 0) continue;
    for (const executableName of executableNames) {
      const candidate = NodePath.join(directory, executableName);
      if (!(await platform.statExecutable(candidate).catch(() => false))) continue;
      try {
        await validateCandidate(platform, candidate, paths.storeDir);
        return { executable: candidate, source: "path", storeDir: paths.storeDir };
      } catch {
        continue;
      }
    }
  }
  throw safeError("path-unavailable");
};

const makeResolved = async (
  platform: GreppyRuntimePlatform,
  paths: RuntimePaths,
): Promise<ResolvedGreppyRuntime> => {
  const override = platform.environment[WORKJET_GREPPY_EXECUTABLE_ENV]?.trim();
  if (override) {
    try {
      await validateCandidate(platform, override, paths.storeDir);
      return { executable: override, source: "override", storeDir: paths.storeDir };
    } catch {
      throw safeError("override-invalid");
    }
  }
  if (await managedComplete(platform, paths)) {
    try {
      await validateCandidate(platform, paths.executable, paths.storeDir);
      return { executable: paths.executable, source: "managed", storeDir: paths.storeDir };
    } catch {
      // A valid separately administered PATH runtime still wins after managed
      // corruption, but preserve the repair signal when no fallback validates.
      try {
        return await resolveFromPath(platform, paths);
      } catch {
        throw safeError("managed-invalid");
      }
    }
  }
  return resolveFromPath(platform, paths);
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw safeError("malformed-response");
  }
};

const readIndexStatus = async (
  platform: GreppyRuntimePlatform,
  runtime: ResolvedGreppyRuntime,
  cwd: string,
) => {
  let result: RuntimeCommandResult;
  try {
    result = await platform.run({
      executable: runtime.executable,
      args: ["index", "status", "--root", cwd, "--json"],
      cwd,
      env: commandEnv(runtime.storeDir),
      timeoutMs: STATUS_TIMEOUT_MS,
      maximumOutputBytes: STATUS_MAX_BYTES,
    });
  } catch {
    throw safeError("binary-unavailable");
  }
  if (result.timedOut) throw safeError("timeout");
  if (result.outputExceeded || result.stdoutBytes > STATUS_MAX_BYTES) {
    throw safeError("oversized-response");
  }
  const decoded = await Effect.runPromise(
    decodeGreppyIndexStatus(parseJson(result.stdout)).pipe(
      Effect.mapError(() => safeError("malformed-response")),
    ),
  );
  // Greppy intentionally exits 1 for no_index. Other non-zero health exits are
  // accepted only when their bounded JSON says no_index or active refreshing.
  if (result.exitCode !== 0 && decoded.status !== "no_index" && !isGreppyIndexing(decoded)) {
    throw safeError("process-exit");
  }
  return decoded;
};

const installFlights = new Map<string, Promise<ResolvedGreppyRuntime>>();

const performInstall = async (
  platform: GreppyRuntimePlatform,
  paths: RuntimePaths,
  configuredBuildTempRoot?: string,
): Promise<ResolvedGreppyRuntime> => {
  const override = platform.environment[WORKJET_GREPPY_EXECUTABLE_ENV]?.trim();
  if (override) {
    try {
      await validateCandidate(platform, override, paths.storeDir);
      return { executable: override, source: "override", storeDir: paths.storeDir };
    } catch {
      throw safeError("override-invalid");
    }
  }
  if (!supportedHost(platform)) throw safeError("unsupported-host");
  if (await managedComplete(platform, paths)) {
    try {
      await validateCandidate(platform, paths.executable, paths.storeDir);
      return { executable: paths.executable, source: "managed", storeDir: paths.storeDir };
    } catch {
      // Explicit install repairs an invalid completed runtime.
    }
  }

  const buildTempRoot =
    configuredBuildTempRoot ??
    platform.environment[WORKJET_GREPPY_BUILD_TEMP_ROOT_ENV]?.trim() ??
    NodePath.join(platform.temporaryDirectory, "workjet-greppy");
  await platform.mkdir(buildTempRoot);
  await platform.mkdir(paths.runtimeParent);
  const scratch = await platform.makeTempDirectory(buildTempRoot, "greppy-build-");
  const activation = await platform.makeTempDirectory(paths.runtimeParent, ".greppy-activate-");
  try {
    const archive = NodePath.join(scratch, "source.tar.gz");
    const sourceDownload = await platform.download({
      url: GREPPY_RUNTIME_PIN.sourceUrl,
      destination: archive,
      maximumBytes: SOURCE_MAX_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      policy: "source",
    });
    if (
      sourceDownload.sha256 !== GREPPY_RUNTIME_PIN.sourceSha256 ||
      sourceDownload.bytes > SOURCE_MAX_BYTES ||
      !isAllowedGreppyDownloadUrl(new URL(sourceDownload.finalUrl), "source", false) ||
      sourceDownload.redirects.some(
        (url) => !isAllowedGreppyDownloadUrl(new URL(url), "source", false),
      )
    ) {
      throw safeError("install-failed");
    }

    const archiveList = await runChecked(
      platform,
      {
        executable: "tar",
        args: ["-tzf", archive],
        timeoutMs: PROBE_TIMEOUT_MS,
        maximumOutputBytes: ARCHIVE_LIST_MAX_BYTES,
      },
      "install-failed",
    );
    const entries = archiveList.stdout.split("\n").filter(Boolean);
    if (!validateGreppyArchiveEntries(entries)) throw safeError("install-failed");
    const extraction = NodePath.join(scratch, "source");
    await platform.mkdir(extraction);
    await runChecked(
      platform,
      {
        executable: "tar",
        args: ["-xzf", archive, "-C", extraction],
        timeoutMs: PROBE_TIMEOUT_MS,
        maximumOutputBytes: PROCESS_MAX_BYTES,
      },
      "install-failed",
    );
    await platform.remove(archive);
    const sourceRoot = NodePath.join(extraction, GREPPY_RUNTIME_PIN.archivePrefix.slice(0, -1));
    const manifestText = await platform.readText(
      NodePath.join(sourceRoot, GREPPY_RUNTIME_PIN.modelManifestPath),
      MANIFEST_MAX_BYTES,
    );
    const assets = await Effect.runPromise(
      decodePinnedGreppyModelManifest(parseJson(manifestText)).pipe(
        Effect.mapError(() => safeError("install-failed")),
      ),
    );
    let modelBytes = 0;
    for (const asset of assets) {
      const pinned = GREPPY_MODEL_ASSETS.find(
        (candidate) =>
          candidate.repository === asset.repository &&
          candidate.file === asset.file &&
          candidate.destination === asset.destination &&
          candidate.revision === asset.revision &&
          candidate.sha256 === asset.sha256,
      );
      const url = pinned && greppyModelUrl(pinned);
      if (!pinned || !url || !isConfinedGreppyAssetPath(sourceRoot, asset.destination)) {
        throw safeError("install-failed");
      }
      const destination = NodePath.join(sourceRoot, asset.destination);
      await platform.mkdir(NodePath.dirname(destination));
      const downloaded = await platform.download({
        url: url.toString(),
        destination,
        maximumBytes: MODEL_MAX_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        policy: "model",
      });
      modelBytes += downloaded.bytes;
      if (
        downloaded.sha256 !== asset.sha256 ||
        downloaded.bytes > MODEL_MAX_BYTES ||
        modelBytes > MODEL_TOTAL_MAX_BYTES ||
        !isAllowedGreppyDownloadUrl(new URL(downloaded.finalUrl), "model", false) ||
        downloaded.redirects.some(
          (redirect) => !isAllowedGreppyDownloadUrl(new URL(redirect), "model", false),
        )
      ) {
        throw safeError("install-failed");
      }
    }

    await runChecked(
      platform,
      {
        executable: "cargo",
        args: GREPPY_RUNTIME_PIN.cargoArgs,
        cwd: sourceRoot,
        timeoutMs: BUILD_TIMEOUT_MS,
        maximumOutputBytes: PROCESS_MAX_BYTES,
      },
      "install-failed",
    );
    const built = NodePath.join(sourceRoot, GREPPY_RUNTIME_PIN.binaryRelativePath);
    if (!(await platform.statExecutable(built))) throw safeError("install-failed");
    const stagedExecutable = NodePath.join(activation, "greppy");
    await platform.copyFile(built, stagedExecutable);
    await platform.chmodExecutable(stagedExecutable);
    await validateCandidate(platform, stagedExecutable, paths.storeDir);
    await platform.writeText(NodePath.join(activation, ".install-complete"), INSTALL_SENTINEL);
    const previous = `${activation}.previous`;
    const hadPrevious = await platform.exists(paths.versionDir);
    if (hadPrevious) await platform.rename(paths.versionDir, previous);
    try {
      await platform.rename(activation, paths.versionDir);
    } catch (error) {
      if (hadPrevious) await platform.rename(previous, paths.versionDir).catch(() => undefined);
      throw error;
    }
    await platform.remove(previous).catch(() => undefined);
    return { executable: paths.executable, source: "managed", storeDir: paths.storeDir };
  } catch {
    throw safeError("install-failed");
  } finally {
    await platform.remove(scratch).catch(() => undefined);
    await platform.remove(activation).catch(() => undefined);
  }
};

const installSingleFlight = (
  platform: GreppyRuntimePlatform,
  paths: RuntimePaths,
  configuredBuildTempRoot?: string,
): Promise<ResolvedGreppyRuntime> => {
  const active = installFlights.get(paths.versionDir);
  if (active) return active;
  const flight = performInstall(platform, paths, configuredBuildTempRoot).finally(() => {
    if (installFlights.get(paths.versionDir) === flight) installFlights.delete(paths.versionDir);
  });
  installFlights.set(paths.versionDir, flight);
  return flight;
};

const fromPromise = <A>(operation: () => Promise<A>): Effect.Effect<A, GreppyRuntimeError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => (isGreppyRuntimeError(error) ? error : safeError("install-failed")),
  });

export const make = (options: {
  readonly stateDir: string;
  readonly platform: GreppyRuntimePlatform;
  readonly buildTempRoot?: string;
}): GreppyRuntimeShape => {
  const paths = runtimePaths(options.stateDir);
  const workspaceFlights = new Map<string, Promise<GreppyWorkspaceReadiness>>();

  const resolve = () => fromPromise(() => makeResolved(options.platform, paths));
  // `inspect` reports availability instead of failing: the body already turns
  // every rejection into an "unavailable" snapshot. `Effect.promise` states that
  // in the type — an impossible rejection remains a defect exactly as the
  // previous `Effect.orDie` made it — without minting an untagged `Error` for a
  // failure channel that has no members.
  const inspect = (): Effect.Effect<GreppyRuntimeSnapshot> =>
    Effect.promise(async () => {
      const installSupported = supportedHost(options.platform);
      try {
        const runtime = await makeResolved(options.platform, paths);
        return {
          availability: "available",
          source: runtime.source,
          version: GREPPY_RUNTIME_PIN.version,
          installSupported,
        } satisfies GreppyRuntimeSnapshot;
      } catch (error) {
        const reason = isGreppyRuntimeError(error) ? error.reason : ("binary-unavailable" as const);
        if (!installSupported && reason === "path-unavailable") {
          return {
            availability: "unsupported",
            reason: "unsupported-host",
            version: GREPPY_RUNTIME_PIN.version,
            installSupported,
          } satisfies GreppyRuntimeSnapshot;
        }
        return {
          availability: "unavailable",
          reason,
          version: GREPPY_RUNTIME_PIN.version,
          installSupported,
        } satisfies GreppyRuntimeSnapshot;
      }
    });
  const install = () =>
    fromPromise(async () => {
      const runtime = await installSingleFlight(options.platform, paths, options.buildTempRoot);
      return {
        availability: "available",
        source: runtime.source,
        version: GREPPY_RUNTIME_PIN.version,
        installSupported: supportedHost(options.platform),
      } satisfies GreppyRuntimeSnapshot;
    });
  const ensureWorkspace = (cwd: string) =>
    fromPromise(async () => {
      const canonicalCwd = await options.platform.realpath(cwd).catch(() => {
        throw safeError("index-unavailable");
      });
      const active = workspaceFlights.get(canonicalCwd);
      if (active) return active;
      const flight = (async (): Promise<GreppyWorkspaceReadiness> => {
        const runtime = await makeResolved(options.platform, paths);
        let status = await readIndexStatus(options.platform, runtime, canonicalCwd);
        if (isGreppyIndexReady(status)) {
          return { ...runtime, cwd: canonicalCwd, status: "ready" };
        }
        if (isGreppyIndexing(status)) {
          return { ...runtime, cwd: canonicalCwd, status: "indexing" };
        }
        let indexResult: RuntimeCommandResult;
        try {
          indexResult = await options.platform.run({
            executable: runtime.executable,
            args: ["index", canonicalCwd],
            cwd: canonicalCwd,
            env: commandEnv(runtime.storeDir),
            timeoutMs: INDEX_TIMEOUT_MS,
            maximumOutputBytes: PROCESS_MAX_BYTES,
          });
        } catch {
          throw safeError("process-exit");
        }
        if (indexResult.timedOut) throw safeError("timeout");
        if (indexResult.outputExceeded) throw safeError("oversized-response");
        status = await readIndexStatus(options.platform, runtime, canonicalCwd);
        if (isGreppyIndexReady(status)) {
          return { ...runtime, cwd: canonicalCwd, status: "ready" };
        }
        if (isGreppyIndexing(status)) {
          return { ...runtime, cwd: canonicalCwd, status: "indexing" };
        }
        if (indexResult.exitCode !== 0) throw safeError("process-exit");
        throw safeError("index-unavailable");
      })().finally(() => {
        if (workspaceFlights.get(canonicalCwd) === flight) {
          workspaceFlights.delete(canonicalCwd);
        }
      });
      workspaceFlights.set(canonicalCwd, flight);
      return flight;
    });

  return GreppyRuntime.of({ storeDir: paths.storeDir, resolve, inspect, install, ensureWorkspace });
};

const nodeRun = (command: RuntimeCommand): Promise<RuntimeCommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    // @effect-diagnostics-next-line globalTimers:off -- `nodeRun` is a raw Promise wrapper around `child_process.spawn`; this timer is the kill deadline for that OS process and is cleared from the child's own `error`/`close` events. `Effect.sleep` cannot arm it: there is no fiber here to interrupt, and routing it through the Effect Clock would make the SIGKILL depend on a TestClock in tests that today drive this path with real Node timers.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, command.timeoutMs);
    const account = (chunk: Buffer, stdoutStream: boolean) => {
      if (stdoutStream) {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= command.maximumOutputBytes) stdout += chunk.toString("utf8");
      } else {
        stderrBytes += chunk.length;
      }
      if (stdoutBytes + stderrBytes > command.maximumOutputBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => account(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => account(chunk, false));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stdoutBytes,
        stderrBytes,
        timedOut,
        outputExceeded,
      });
    });
  });

const nodeDownload = async (input: {
  readonly url: string;
  readonly destination: string;
  readonly maximumBytes: number;
  readonly timeoutMs: number;
  readonly policy: DownloadPolicy;
}): Promise<RuntimeDownloadResult> => {
  const redirects: Array<string> = [];
  const initial = new URL(input.url);
  if (!isAllowedGreppyDownloadUrl(initial, input.policy, true)) {
    throw new Error("disallowed download URL");
  }
  await NodeFs.mkdir(NodePath.dirname(input.destination), { recursive: true });
  const visit = (url: URL, remaining: number): Promise<RuntimeDownloadResult> =>
    new Promise((resolve, reject) => {
      if (!isAllowedGreppyDownloadUrl(url, input.policy, url.toString() === initial.toString())) {
        reject(new Error("disallowed redirect URL"));
        return;
      }
      const request = Https.get(
        url,
        { headers: { "user-agent": "Workjet-Greppy/0.3.1" } },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            const location = response.headers.location;
            response.resume();
            if (!location || remaining === 0) {
              reject(new Error("redirect rejected"));
              return;
            }
            const target = new URL(location, url);
            if (!isAllowedGreppyDownloadUrl(target, input.policy, false)) {
              reject(new Error("redirect host rejected"));
              return;
            }
            redirects.push(target.toString());
            visit(target, remaining - 1).then(resolve, reject);
            return;
          }
          if (status !== 200) {
            response.resume();
            reject(new Error("download failed"));
            return;
          }
          const declared = Number(response.headers["content-length"] ?? 0);
          if (Number.isFinite(declared) && declared > input.maximumBytes) {
            response.resume();
            reject(new Error("download too large"));
            return;
          }
          const hash = createHash("sha256");
          const output = createWriteStream(input.destination, { flags: "wx", mode: 0o600 });
          let bytes = 0;
          let settled = false;
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            response.destroy();
            output.destroy();
            reject(error);
          };
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > input.maximumBytes) {
              fail(new Error("download too large"));
              return;
            }
            hash.update(chunk);
          });
          response.once("error", fail);
          output.once("error", fail);
          output.once("finish", () => {
            if (settled) return;
            settled = true;
            resolve({
              sha256: hash.digest("hex"),
              bytes,
              finalUrl: url.toString(),
              redirects,
            });
          });
          response.pipe(output);
        },
      );
      request.setTimeout(input.timeoutMs, () => request.destroy(new Error("download timeout")));
      request.once("error", reject);
    });
  try {
    return await visit(initial, 5);
  } catch (error) {
    await NodeFs.rm(input.destination, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const nodePlatform = (): GreppyRuntimePlatform => ({
  platform: process.platform,
  arch: process.arch,
  environment: process.env,
  temporaryDirectory: Os.tmpdir(),
  statExecutable: async (path) => {
    const stat = await NodeFs.stat(path);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  },
  realpath: NodeFs.realpath,
  exists: async (path) =>
    NodeFs.access(path).then(
      () => true,
      () => false,
    ),
  mkdir: async (path) => {
    await NodeFs.mkdir(path, { recursive: true });
  },
  makeTempDirectory: async (parent, prefix) => {
    await NodeFs.mkdir(parent, { recursive: true });
    return NodeFs.mkdtemp(NodePath.join(parent, prefix));
  },
  readText: async (path, maximumBytes) => {
    const stat = await NodeFs.stat(path);
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error("file too large");
    return NodeFs.readFile(path, "utf8");
  },
  writeText: async (path, content) => {
    await NodeFs.writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  },
  remove: async (path) => {
    await NodeFs.rm(path, { recursive: true, force: true });
  },
  rename: NodeFs.rename,
  copyFile: NodeFs.copyFile,
  chmodExecutable: async (path) => NodeFs.chmod(path, 0o755),
  run: nodeRun,
  download: nodeDownload,
});

const live = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return make({ stateDir: config.stateDir, platform: nodePlatform() });
});

export const layer = Layer.effect(GreppyRuntime, live);

export const __testing = {
  constants: {
    DOWNLOAD_TIMEOUT_MS,
    MODEL_MAX_BYTES,
    MODEL_TOTAL_MAX_BYTES,
    PROCESS_MAX_BYTES,
    SOURCE_MAX_BYTES,
  },
  runtimePaths,
  validateCandidate,
};
