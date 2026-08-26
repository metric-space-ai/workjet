// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Electron owns this loopback-only static HTTP boundary, its verified release download, and its filesystem callbacks.
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  BusinessOsShellReleaseManifestV2,
  BusinessOsShellUpdateStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import businessOsShellManifest from "../../resources/ctox/business-os-shell.manifest.json" with { type: "json" };
import {
  CTOX_BUSINESS_OS_SHELL_RELEASE,
  CTOX_BUSINESS_OS_SHELL_SCHEMA,
  type CtoxBusinessOsShellReleaseManifest,
  officialCtoxBusinessOsShellReleaseUrls,
  prepareCtoxBusinessOsShellRelease,
} from "../../../../scripts/lib/ctox-business-os-shell.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveBusinessOsShellReleaseVersion } from "./CtoxShellReleaseTrust.ts";

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_SENTINEL_BYTES = 16 * 1024;
const LOOPBACK_HOST = "127.0.0.1";
const SHELL_PATH_PREFIX = "/business-os";
const ALLOWED_RXDB_STATIC_MODULE_PATHS = new Set([
  "/rxdb/src/v1_5_status.mjs",
  "/rxdb/src/protocol-contract.generated.mjs",
]);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const CompletionSentinel = Schema.Struct({
  schema: Schema.Literal(CTOX_BUSINESS_OS_SHELL_SCHEMA),
  version: Schema.String,
  sourceCommit: Schema.String,
  archiveRoot: Schema.String,
  entry: Schema.String,
  archiveSha256: Schema.String,
  embeddedManifestSha256: Schema.String,
  fileCount: Schema.Int,
});
const decodeCompletionSentinel = Schema.decodeUnknownSync(
  Schema.fromJsonString(CompletionSentinel),
);
export const CTOX_BUSINESS_OS_SHELL_COMPLETION_SENTINEL = ".ctox-business-os-shell.complete.json";
export const ctoxBusinessOsShellCompletionSentinel = {
  schema: businessOsShellManifest.schema,
  version: businessOsShellManifest.version,
  sourceCommit: businessOsShellManifest.sourceCommit,
  archiveRoot: businessOsShellManifest.archiveRoot,
  entry: businessOsShellManifest.entry,
  archiveSha256: businessOsShellManifest.archiveSha256,
  embeddedManifestSha256: businessOsShellManifest.embeddedManifestSha256,
  fileCount: businessOsShellManifest.fileCount,
} as const;
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".otf", "font/otf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

/**
 * The instance sources that reach the packed WebRTC launch. `local_daemon` and
 * `ssh_managed` join the paired sources because a CTOX daemon hands out the
 * same desktop invite document whether it runs here or on an SSH host; every
 * other source has no pairing material at all.
 */
export type CtoxBusinessOsLaunchSource =
  | "pairing_invite"
  | "manual_pairing"
  | "local_daemon"
  | "ssh_managed";

export interface CtoxBusinessOsLaunchConfig {
  readonly transport: "webrtc";
  readonly sync_room: string;
  readonly signaling_urls: readonly string[];
  readonly signaling_room_password: string;
  readonly http_bridge_available: false;
  readonly desktop_instance: {
    readonly id: string;
    readonly source: CtoxBusinessOsLaunchSource;
    readonly display_name: string;
    readonly domain: string;
  };
  readonly session?: {
    readonly authenticated: true;
    readonly source: "desktop_invite" | "desktop_manual_pairing";
    readonly capability_token: string;
    readonly capability_expires_at_ms?: number;
    readonly user?: {
      readonly id?: string;
      readonly display_name?: string;
      readonly role?: string;
      readonly is_admin: boolean;
    };
  };
}

export interface CtoxBusinessOsLaunch {
  readonly launchUrl: string;
  readonly launchOrigin: string;
  readonly shellVersion?: string;
  readonly recoveryShell?: boolean;
}

export class CtoxBusinessOsShellError extends Schema.TaggedErrorClass<CtoxBusinessOsShellError>()(
  "CtoxBusinessOsShellError",
  {},
) {
  override get message(): string {
    return "The CTOX Business OS shell could not be launched.";
  }
}

export class CtoxBusinessOsShell extends Context.Service<
  CtoxBusinessOsShell,
  {
    readonly launch: (
      config: CtoxBusinessOsLaunchConfig,
      shellStatus?: BusinessOsShellUpdateStatus,
    ) => Effect.Effect<CtoxBusinessOsLaunch, CtoxBusinessOsShellError>;
  }
>()("@t3tools/desktop/ctox/CtoxBusinessOsShell") {}

interface RunningShellServer {
  readonly origin: string;
  readonly server: NodeHttp.Server;
  readonly version: string;
  readonly recoveryShell: boolean;
}

interface ResolvedShellRoot {
  readonly root: string;
  readonly release: CtoxBusinessOsShellReleaseManifest;
  readonly recoveryShell: boolean;
}

const INSTANCE_MODULE_PREFIXES = ["installed-modules/", "local-modules/"] as const;

/**
 * Local runtime modules remain instance-owned and are therefore not part of a
 * global shell release. Resolve their existing CTOX runtime root without
 * inventing a second configuration switch; `CTOX_INSTALL_ROOT` is the
 * installer's established location override.
 */
export function resolveCtoxLocalModuleAssetRoot(
  env: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): string | undefined {
  const override = env.CTOX_INSTALL_ROOT?.trim();
  const installRoot =
    override !== undefined && override.length > 0
      ? override
      : NodePath.join(homeDirectory, ".local", "lib", "ctox");
  if (!NodePath.isAbsolute(installRoot)) return undefined;
  return NodePath.join(installRoot, "current", "runtime", "business-os");
}

export function resolveCtoxBusinessOsShellRoot(
  environment: Pick<
    DesktopEnvironment.DesktopEnvironment["Service"],
    "isPackaged" | "resourcesPath" | "rootDir"
  >,
): string {
  return environment.isPackaged
    ? NodePath.join(environment.resourcesPath, "ctox-business-os-shell")
    : NodePath.join(
        environment.rootDir,
        ".deps",
        "ctox-business-os-shell",
        businessOsShellManifest.version,
      );
}

const LegacyInventoryFile = Schema.Struct({
  path: Schema.String,
  byteSize: Schema.Int,
  sha256: Schema.String,
});
const LegacyDetachedManifest = Schema.Struct({
  schema: Schema.Literal(CTOX_BUSINESS_OS_SHELL_SCHEMA),
  version: Schema.String,
  sourceCommit: Schema.String,
  entry: Schema.String,
  archiveRoot: Schema.String,
  archiveFilename: Schema.String,
  archiveByteLength: Schema.Int,
  archiveSha256: Schema.String,
  embeddedManifestSha256: Schema.String,
  files: Schema.Array(LegacyInventoryFile),
});

function sameReleaseInventory(
  legacy: typeof LegacyDetachedManifest.Type,
  release: BusinessOsShellReleaseManifestV2,
): boolean {
  if (legacy.files.length !== release.files.length) return false;
  const signed = new Map(release.files.map((file) => [file.path, file]));
  return legacy.files.every((file) => {
    const expected = signed.get(file.path);
    return expected?.size === file.byteSize && expected.sha256 === file.sha256;
  });
}

async function legacyReleaseFromSignedManifest(
  release: BusinessOsShellReleaseManifestV2,
): Promise<CtoxBusinessOsShellReleaseManifest> {
  const official = officialCtoxBusinessOsShellReleaseUrls(release.version);
  if (release.artifact.url !== official.archiveUrl) throw new Error("shell-release-url-mismatch");
  const response = await fetch(official.manifestUrl, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/json" },
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error("shell-release-legacy-manifest-unavailable");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > CTOX_BUSINESS_OS_SHELL_RELEASE.budgets.maxManifestBytes) {
    throw new Error("shell-release-legacy-manifest-size");
  }
  const legacy = Schema.decodeUnknownSync(LegacyDetachedManifest)(
    JSON.parse(bytes.toString("utf8")),
    { onExcessProperty: "ignore" },
  );
  if (
    legacy.version !== release.version ||
    legacy.sourceCommit !== release.sourceCommit ||
    legacy.archiveFilename !== official.archiveFilename ||
    legacy.archiveByteLength !== release.artifact.size ||
    legacy.archiveSha256 !== release.artifact.sha256 ||
    legacy.embeddedManifestSha256 !== release.provenance.embeddedManifestSha256 ||
    !sameReleaseInventory(legacy, release)
  ) {
    throw new Error("shell-release-v1-v2-mismatch");
  }
  return {
    ...CTOX_BUSINESS_OS_SHELL_RELEASE,
    version: release.version,
    sourceCommit: release.sourceCommit,
    manifestUrl: official.manifestUrl,
    manifestByteLength: bytes.length,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    archiveUrl: official.archiveUrl,
    archiveFilename: official.archiveFilename,
    archiveRoot: legacy.archiveRoot,
    entry: legacy.entry,
    archiveByteLength: release.artifact.size,
    archiveSha256: release.artifact.sha256,
    embeddedManifestSha256: release.provenance.embeddedManifestSha256,
    fileCount: release.files.length,
  };
}

function semverTuple(value: string): readonly [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = value.split(/[+-]/u, 1)[0]!.split(".");
  return [Number(major), Number(minor), Number(patch)];
}

function semverCompare(left: string, right: string): number {
  const a = semverTuple(left);
  const b = semverTuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
}

function supportsWorkjet(release: BusinessOsShellReleaseManifestV2, appVersion: string): boolean {
  return (
    semverCompare(appVersion, release.compatibility.workjetMinVersion) >= 0 &&
    (release.compatibility.workjetMaxVersion === null ||
      semverCompare(appVersion, release.compatibility.workjetMaxVersion) <= 0)
  );
}

function expectedSentinel(release: CtoxBusinessOsShellReleaseManifest) {
  return {
    schema: release.schema,
    version: release.version,
    sourceCommit: release.sourceCommit,
    archiveRoot: release.archiveRoot,
    entry: release.entry,
    archiveSha256: release.archiveSha256,
    embeddedManifestSha256: release.embeddedManifestSha256,
    fileCount: release.fileCount,
  };
}

function responseHeaders(): Readonly<Record<string, string>> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function reject(response: NodeHttp.ServerResponse, status: number): void {
  response.writeHead(status, responseHeaders()).end();
}

function isBusinessOsDataRoute(pathname: string): boolean {
  const path = pathname.toLowerCase().replace(/\/{2,}/g, "/");
  if (ALLOWED_RXDB_STATIC_MODULE_PATHS.has(path)) return false;
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/commands" ||
    path.startsWith("/commands/") ||
    path === "/collections" ||
    path.startsWith("/collections/") ||
    path === "/files" ||
    path.startsWith("/files/") ||
    path === "/status" ||
    path.startsWith("/status/") ||
    path === "/session" ||
    path.startsWith("/session/") ||
    path === "/control" ||
    path.startsWith("/control/") ||
    (path.startsWith("/rxdb/") && !path.startsWith("/rxdb/dist/"))
  );
}

function requestPath(rawUrl: string): string | undefined {
  const rawPath = rawUrl.split("?", 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) return undefined;
  return decoded;
}

function shellRelativePath(pathname: string): string {
  const normalized = pathname.replace(/\/{2,}/g, "/");
  if (
    normalized === "" ||
    normalized === "/" ||
    normalized === SHELL_PATH_PREFIX ||
    normalized === `${SHELL_PATH_PREFIX}/`
  )
    return "index.html";
  return normalized.startsWith(`${SHELL_PATH_PREFIX}/`)
    ? normalized.slice(SHELL_PATH_PREFIX.length + 1)
    : normalized.replace(/^\/+/, "");
}

function installStaticHandler(
  server: NodeHttp.Server,
  canonicalRoot: string,
  canonicalInstanceModuleRoot?: string,
): void {
  server.on("request", (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      reject(response, 405);
      return;
    }
    if (request.url === undefined) {
      reject(response, 400);
      return;
    }
    const pathname = requestPath(request.url);
    if (pathname === undefined) {
      reject(response, 400);
      return;
    }
    const relative = shellRelativePath(pathname);
    if (isBusinessOsDataRoute(pathname) || isBusinessOsDataRoute(`/${relative}`)) {
      reject(response, 403);
      return;
    }

    const shellCandidate = NodePath.resolve(canonicalRoot, relative);
    const mayUseInstanceModuleRoot = INSTANCE_MODULE_PREFIXES.some((prefix) =>
      relative.startsWith(prefix),
    );
    const overlayCandidate =
      mayUseInstanceModuleRoot && canonicalInstanceModuleRoot !== undefined
        ? NodePath.resolve(canonicalInstanceModuleRoot, relative)
        : undefined;
    const useOverlay =
      overlayCandidate !== undefined &&
      !NodeFs.existsSync(shellCandidate) &&
      NodeFs.existsSync(overlayCandidate);
    const candidateRoot =
      useOverlay && canonicalInstanceModuleRoot !== undefined
        ? canonicalInstanceModuleRoot
        : canonicalRoot;
    const candidate =
      useOverlay && overlayCandidate !== undefined ? overlayCandidate : shellCandidate;
    if (candidate !== candidateRoot && !candidate.startsWith(`${candidateRoot}${NodePath.sep}`)) {
      reject(response, 403);
      return;
    }

    NodeFs.lstat(candidate, (lstatError, lstat) => {
      if (lstatError !== null) {
        reject(response, 404);
        return;
      }
      if (!lstat.isFile()) {
        reject(response, lstat.isSymbolicLink() ? 403 : 404);
        return;
      }
      NodeFs.realpath(candidate, (realpathError, canonicalCandidate) => {
        if (
          realpathError !== null ||
          (canonicalCandidate !== candidateRoot &&
            !canonicalCandidate.startsWith(`${candidateRoot}${NodePath.sep}`))
        ) {
          reject(response, 403);
          return;
        }
        NodeFs.stat(canonicalCandidate, (statError, stat) => {
          if (statError !== null || !stat.isFile()) {
            reject(response, 404);
            return;
          }
          response.writeHead(200, {
            ...responseHeaders(),
            "content-length": stat.size,
            "content-type":
              MIME_TYPES.get(NodePath.extname(canonicalCandidate).toLowerCase()) ??
              "application/octet-stream",
          });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          const stream = NodeFs.createReadStream(canonicalCandidate);
          stream.once("error", () => response.destroy());
          stream.pipe(response);
        });
      });
    });
  });
}

function startServer(
  resolved: ResolvedShellRoot,
  instanceModuleRoot?: string,
): Effect.Effect<RunningShellServer, CtoxBusinessOsShellError> {
  return Effect.callback<RunningShellServer, CtoxBusinessOsShellError>((resume) => {
    let canonicalRoot: string;
    let canonicalInstanceModuleRoot: string | undefined;
    try {
      canonicalRoot = NodeFs.realpathSync(resolved.root);
      if (!NodeFs.statSync(canonicalRoot).isDirectory()) throw new Error("invalid shell root");
      const sentinelPath = NodePath.join(canonicalRoot, CTOX_BUSINESS_OS_SHELL_COMPLETION_SENTINEL);
      const sentinelStat = NodeFs.lstatSync(sentinelPath);
      if (
        !sentinelStat.isFile() ||
        sentinelStat.isSymbolicLink() ||
        sentinelStat.size < 1 ||
        sentinelStat.size > MAX_SENTINEL_BYTES
      ) {
        throw new Error("invalid shell sentinel");
      }
      const sentinel = decodeCompletionSentinel(NodeFs.readFileSync(sentinelPath, "utf8"), {
        onExcessProperty: "error",
      });
      const expected = expectedSentinel(resolved.release);
      if (
        sentinel.schema !== expected.schema ||
        sentinel.version !== expected.version ||
        sentinel.sourceCommit !== expected.sourceCommit ||
        sentinel.archiveRoot !== expected.archiveRoot ||
        sentinel.entry !== expected.entry ||
        sentinel.archiveSha256 !== expected.archiveSha256 ||
        sentinel.embeddedManifestSha256 !== expected.embeddedManifestSha256 ||
        sentinel.fileCount !== expected.fileCount
      ) {
        throw new Error("shell sentinel mismatch");
      }
      const entryPath = NodePath.join(canonicalRoot, resolved.release.entry);
      const entryStat = NodeFs.lstatSync(entryPath);
      const canonicalEntry = NodeFs.realpathSync(entryPath);
      if (
        !entryStat.isFile() ||
        entryStat.isSymbolicLink() ||
        !canonicalEntry.startsWith(`${canonicalRoot}${NodePath.sep}`)
      ) {
        throw new Error("invalid shell entry");
      }
      if (instanceModuleRoot !== undefined && NodeFs.existsSync(instanceModuleRoot)) {
        const candidate = NodeFs.realpathSync(instanceModuleRoot);
        if (NodeFs.statSync(candidate).isDirectory()) canonicalInstanceModuleRoot = candidate;
      }
    } catch {
      resume(Effect.fail(new CtoxBusinessOsShellError()));
      return;
    }

    const server = NodeHttp.createServer({ maxHeaderSize: MAX_HEADER_BYTES });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 100;
    installStaticHandler(server, canonicalRoot, canonicalInstanceModuleRoot);
    const fail = () => resume(Effect.fail(new CtoxBusinessOsShellError()));
    server.once("error", fail);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", fail);
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== LOOPBACK_HOST) {
        server.close();
        resume(Effect.fail(new CtoxBusinessOsShellError()));
        return;
      }
      resume(
        Effect.succeed({
          origin: `http://${LOOPBACK_HOST}:${address.port}`,
          server,
          version: resolved.release.version,
          recoveryShell: resolved.recoveryShell,
        }),
      );
    });
  });
}

function closeServer(server: NodeHttp.Server): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
    server.closeAllConnections();
  }).pipe(Effect.orElseSucceed(() => undefined));
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const parentScope = yield* Scope.Scope;
  const recoveryRoot = resolveCtoxBusinessOsShellRoot(environment);
  const localModuleAssetRoot = resolveCtoxLocalModuleAssetRoot(process.env, NodeOS.homedir());
  const cacheRoot = NodePath.join(
    environment.stateDir ?? NodePath.join(environment.rootDir, ".t3"),
    "ctox-business-os-shell-cache",
  );
  const serverRef = yield* SynchronizedRef.make<ReadonlyMap<string, RunningShellServer>>(new Map());

  const resolveRoot = (shellStatus?: BusinessOsShellUpdateStatus) =>
    Effect.tryPromise({
      try: async (): Promise<ResolvedShellRoot> => {
        const requestedVersion = shellStatus?.activeVersion ?? businessOsShellManifest.version;
        if (
          shellStatus === undefined ||
          shellStatus?.recoveryShell === true ||
          requestedVersion === businessOsShellManifest.version
        ) {
          return {
            root: recoveryRoot,
            release: CTOX_BUSINESS_OS_SHELL_RELEASE,
            recoveryShell: shellStatus === undefined || shellStatus.recoveryShell,
          };
        }
        const signed = await resolveBusinessOsShellReleaseVersion(requestedVersion);
        if (
          signed.version !== requestedVersion ||
          !supportsWorkjet(signed, environment.appVersion)
        ) {
          throw new Error("shell-release-incompatible");
        }
        const release = await legacyReleaseFromSignedManifest(signed);
        const prepared = await prepareCtoxBusinessOsShellRelease(release, {
          dependencyRoot: cacheRoot,
        });
        return { root: prepared.installPath, release, recoveryShell: false };
      },
      catch: () => new CtoxBusinessOsShellError(),
    });

  const resolveServer = (
    config: CtoxBusinessOsLaunchConfig,
    shellStatus?: BusinessOsShellUpdateStatus,
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolveRoot(shellStatus);
      const moduleRoot =
        config.desktop_instance.source === "local_daemon" ? localModuleAssetRoot : undefined;
      const key = `${resolved.release.version}:${resolved.recoveryShell ? "recovery" : "active"}:${moduleRoot ?? "shell-only"}`;
      return yield* SynchronizedRef.modifyEffect(serverRef, (current) => {
        const existing = current.get(key);
        if (existing !== undefined) return Effect.succeed([existing, current] as const);
        return Effect.gen(function* () {
          const started = yield* startServer(resolved, moduleRoot);
          yield* Scope.addFinalizer(parentScope, closeServer(started.server));
          const next = new Map(current);
          next.set(key, started);
          return [started, next] as const;
        });
      });
    });

  return CtoxBusinessOsShell.of({
    launch: (config, shellStatus) =>
      Effect.gen(function* () {
        const running = yield* resolveServer(config, shellStatus);
        const url = new URL(`${SHELL_PATH_PREFIX}/`, running.origin);
        url.searchParams.set(
          "ctox_config",
          Buffer.from(encodeUnknownJson(config), "utf8").toString("base64url"),
        );
        return {
          launchUrl: url.toString(),
          launchOrigin: running.origin,
          shellVersion: running.version,
          recoveryShell: running.recoveryShell,
        };
      }).pipe(Effect.mapError(() => new CtoxBusinessOsShellError())),
  });
});

export const layer = Layer.effect(CtoxBusinessOsShell, make);
