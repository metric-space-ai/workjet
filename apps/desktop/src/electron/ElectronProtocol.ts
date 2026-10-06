import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeTimersPromises from "node:timers/promises";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import { DESKTOP_DEEP_LINK_SCHEMES, DESKTOP_HOST } from "./desktopSchemes.ts";

export {
  CTOX_DESKTOP_DEVELOPMENT_SCHEME,
  CTOX_DESKTOP_PRODUCTION_SCHEME,
  DESKTOP_DEEP_LINK_SCHEMES,
  DESKTOP_DEVELOPMENT_SCHEME,
  DESKTOP_HOST,
  DESKTOP_PRODUCTION_SCHEME,
  WORKJET_DEVELOPMENT_SCHEME,
  WORKJET_PREVIEW_SCHEME,
  WORKJET_PRODUCTION_SCHEME,
  getDesktopDeepLinkSchemes,
  getDesktopOrigin,
  getDesktopScheme,
  getDesktopUrl,
  getWorkjetDesktopScheme,
} from "./desktopSchemes.ts";

export class ElectronProtocolRegistrationError extends Schema.TaggedErrorClass<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedErrorClass<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

export interface DesktopProtocolRegistrationInput {
  readonly scheme: string;
  readonly targetOrigin: URL;
  readonly backendOrigin: URL;
  readonly clerkFrontendApiHostname: string | undefined;
  /** Trusted shipped UI assets, independent of local service installation. */
  readonly bundledRendererRoot?: string;
}

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@workjet/desktop/electron/ElectronProtocol") {}

export function makeDesktopContentSecurityPolicy(input: DesktopProtocolRegistrationInput): string {
  const clerkOrigin = input.clerkFrontendApiHostname
    ? `https://${input.clerkFrontendApiHostname}`
    : undefined;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    "'wasm-unsafe-eval'",
    ...(clerkOrigin ? [clerkOrigin] : []),
    "https://challenges.cloudflare.com",
  ];

  // The renderer connects directly to user-configured environments in addition to
  // the build-configured Clerk, relay, and OTLP endpoints. Those environment
  // origins are not known when this response policy is created, so restrict
  // connections by the network schemes the client supports instead of by host.
  const connectSources = ["'self'", "http:", "https:", "ws:", "wss:"];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${input.scheme}: blob: data: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${input.scheme}: data:`,
    "worker-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Must run synchronously during process bootstrap, before Electron emits `ready`.
 */
export function registerDesktopSchemePrivilegesSync(): void {
  Electron.protocol.registerSchemesAsPrivileged(
    DESKTOP_DEEP_LINK_SCHEMES.map((scheme) => ({
      scheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    })),
  );
}

const registerDesktopSchemePrivileges = Effect.sync(registerDesktopSchemePrivilegesSync).pipe(
  Effect.withSpan("desktop.electron.protocol.registerSchemePrivileges"),
);

export const layerSchemePrivileges = Layer.effectDiscard(registerDesktopSchemePrivileges);

async function proxyRequest(
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);
  const headersToRemove: string[] = [];
  for (const name of headers.keys()) {
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headersToRemove.push(name);
    }
  }
  for (const name of headersToRemove) {
    headers.delete(name);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? await fetchWithTransientRetry(targetUrl.toString(), init)
      : await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [0, 50, 150] as const;

const RENDERER_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

const serveBundledRenderer = Effect.fn("desktop.electron.protocol.serveBundledRenderer")(
  function* (
    request: Request,
    root: string,
    contentSecurityPolicy: string,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const decodedPath = yield* Effect.try(() =>
      decodeURIComponent(new URL(request.url).pathname),
    ).pipe(Effect.option);
    if (Option.isNone(decodedPath)) {
      return new Response(null, { status: 400 });
    }
    const pathname = decodedPath.value;
    if (
      pathname.includes("\\") ||
      pathname.includes("\0") ||
      pathname.split("/").some((segment) => segment === ".." || segment === ".")
    ) {
      return new Response(null, { status: 400 });
    }
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const realRoot = yield* fs.realPath(root);
    const filePath = yield* fs.realPath(path.resolve(realRoot, relativePath));
    const relative = path.relative(realRoot, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return new Response(null, { status: 403 });
    }
    if ((yield* fs.stat(filePath)).type !== "File") {
      return new Response(null, { status: 404 });
    }
    const data = yield* fs.readFile(filePath);
    return withContentSecurityPolicy(
      new Response(request.method === "HEAD" ? null : new Uint8Array(data), {
        headers: {
          "Content-Type":
            RENDERER_CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
          "Content-Length": String(data.byteLength),
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      }),
      contentSecurityPolicy,
    );
  },
  Effect.orElseSucceed(() => new Response(null, { status: 404 })),
);

function handleDesktopRequest(
  request: Request,
  input: DesktopProtocolRegistrationInput,
  contentSecurityPolicy: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== DESKTOP_HOST) return Promise.resolve(new Response(null, { status: 404 }));
  // Runtime APIs remain authenticated server requests. Only shipped static UI
  // files are served from disk; data endpoints never receive a SPA fallback.
  const isRuntimeRequest =
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/.well-known" ||
    url.pathname.startsWith("/.well-known/");
  if (input.bundledRendererRoot !== undefined && !isRuntimeRequest) {
    // Missing UI assets never fall back to a remote response or index.html.
    return Effect.runPromise(
      serveBundledRenderer(request, input.bundledRendererRoot, contentSecurityPolicy, fs, path),
    );
  }
  return proxyRequest(request, input.targetOrigin, contentSecurityPolicy);
}

async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (const delayMs of TRANSIENT_FETCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await NodeTimersPromises.setTimeout(delayMs);
    }

    try {
      return await Electron.net.fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registered = yield* Ref.make(false);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, (request) =>
              handleDesktopRequest(request, input, contentSecurityPolicy, fs, path),
            );
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({
                scheme: input.scheme,
                cause,
              }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
