// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off - Electron owns this loopback-only static HTTP boundary and its filesystem callbacks.
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import businessOsShellManifest from "../../resources/ctox/business-os-shell.manifest.json" with { type: "json" };
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

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
  schema: Schema.Literal(businessOsShellManifest.schema),
  version: Schema.Literal(businessOsShellManifest.version),
  sourceCommit: Schema.Literal(businessOsShellManifest.sourceCommit),
  archiveRoot: Schema.Literal(businessOsShellManifest.archiveRoot),
  entry: Schema.Literal(businessOsShellManifest.entry),
  archiveSha256: Schema.Literal(businessOsShellManifest.archiveSha256),
  embeddedManifestSha256: Schema.Literal(businessOsShellManifest.embeddedManifestSha256),
  fileCount: Schema.Literal(businessOsShellManifest.fileCount),
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

export interface CtoxBusinessOsLaunchConfig {
  readonly transport: "webrtc";
  readonly sync_room: string;
  readonly signaling_urls: readonly string[];
  readonly signaling_room_password: string;
  readonly http_bridge_available: false;
  readonly desktop_instance: {
    readonly id: string;
    readonly source: "pairing_invite" | "manual_pairing";
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
    ) => Effect.Effect<CtoxBusinessOsLaunch, CtoxBusinessOsShellError>;
  }
>()("@t3tools/desktop/ctox/CtoxBusinessOsShell") {}

interface RunningShellServer {
  readonly origin: string;
  readonly server: NodeHttp.Server;
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

function installStaticHandler(server: NodeHttp.Server, canonicalRoot: string): void {
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

    const candidate = NodePath.resolve(canonicalRoot, relative);
    if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${NodePath.sep}`)) {
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
          (canonicalCandidate !== canonicalRoot &&
            !canonicalCandidate.startsWith(`${canonicalRoot}${NodePath.sep}`))
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

function startServer(root: string): Effect.Effect<RunningShellServer, CtoxBusinessOsShellError> {
  return Effect.callback<RunningShellServer, CtoxBusinessOsShellError>((resume) => {
    let canonicalRoot: string;
    try {
      canonicalRoot = NodeFs.realpathSync(root);
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
      decodeCompletionSentinel(NodeFs.readFileSync(sentinelPath, "utf8"), {
        onExcessProperty: "error",
      });
      const entryPath = NodePath.join(canonicalRoot, businessOsShellManifest.entry);
      const entryStat = NodeFs.lstatSync(entryPath);
      const canonicalEntry = NodeFs.realpathSync(entryPath);
      if (
        !entryStat.isFile() ||
        entryStat.isSymbolicLink() ||
        !canonicalEntry.startsWith(`${canonicalRoot}${NodePath.sep}`)
      ) {
        throw new Error("invalid shell entry");
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
    installStaticHandler(server, canonicalRoot);
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
  const root = resolveCtoxBusinessOsShellRoot(environment);
  const serverRef = yield* SynchronizedRef.make<RunningShellServer | undefined>(undefined);

  const resolveServer = SynchronizedRef.modifyEffect(serverRef, (current) => {
    if (current !== undefined) return Effect.succeed([current, current] as const);
    return Effect.gen(function* () {
      const started = yield* startServer(root);
      yield* Scope.addFinalizer(parentScope, closeServer(started.server));
      return [started, started] as const;
    });
  });

  return CtoxBusinessOsShell.of({
    launch: (config) =>
      Effect.gen(function* () {
        const running = yield* resolveServer;
        const url = new URL(`${SHELL_PATH_PREFIX}/`, running.origin);
        url.searchParams.set(
          "ctox_config",
          Buffer.from(encodeUnknownJson(config), "utf8").toString("base64url"),
        );
        return { launchUrl: url.toString(), launchOrigin: running.origin };
      }).pipe(Effect.mapError(() => new CtoxBusinessOsShellError())),
  });
});

export const layer = Layer.effect(CtoxBusinessOsShell, make);
