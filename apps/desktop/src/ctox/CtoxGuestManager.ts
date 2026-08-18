// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type {
  CtoxGuestBounds,
  CtoxManagedActionResult,
  CtoxManagedGuestResult,
  CtoxManagedInstance,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { WebContentsView, type BrowserWindow, type Session, type WebContents } from "electron";

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as CtoxBusinessOsShell from "./CtoxBusinessOsShell.ts";
import * as CtoxDevAuth from "./CtoxDevAuth.ts";
import * as CtoxElectronSessions from "./CtoxElectronSessions.ts";
import * as CtoxInstanceRegistry from "./CtoxInstanceRegistry.ts";
import * as CtoxManagedLaunch from "./CtoxManagedLaunch.ts";

const SENSITIVE_QUERY_PARAMETERS = new Set([
  "ctox_config",
  "ctoxConfig",
  "room_password",
  "signaling_room_password",
  "pairing_secret",
  "token",
  "launch_token",
]);
const ALLOWED_CONTROL_PATHS = new Set([
  "/api/business-os/status",
  "/api/business-os/sync/config",
  "/api/business-os/ctox/subscription-auth/start",
  "/api/business-os/ctox/subscription-auth/callback",
]);
const DATA_RESOURCE_TYPES = new Set(["xhr", "fetch", "websocket", "webSocket"]);
const STATIC_ASSET_PATHS = new Set([
  "/system-apps.json",
  "/modules/registry.json",
  "/rxdb/src/v1_5_status.mjs",
  "/rxdb/src/protocol-contract.generated.mjs",
]);
const STATIC_ASSET_PREFIXES = [
  "/assets/",
  "/desktop-apps/",
  "/installed-modules/",
  "/local-modules/",
  "/modules/",
  "/shared/",
  "/vendor/",
];
const STATIC_ASSET_EXTENSIONS = new Set([
  "css",
  "gif",
  "html",
  "ico",
  "jpeg",
  "jpg",
  "js",
  "json",
  "mjs",
  "otf",
  "png",
  "svg",
  "ttf",
  "wasm",
  "webp",
  "woff",
  "woff2",
]);
const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
export const REFRESH_MANAGED_LAUNCH_CHANNEL = "instance:refresh-managed-launch";

interface ActiveGuest {
  readonly instanceId: string;
  readonly window: BrowserWindow;
  readonly view: WebContentsView;
  readonly bounds: CtoxGuestBounds;
  readonly browserSession: Session;
}

interface GuestState {
  readonly businessOsModeActive: boolean;
  readonly active: ActiveGuest | undefined;
}

interface BeforeRequestDetails {
  readonly url: string;
  readonly resourceType: string;
  readonly method?: string;
}

export interface CtoxGuestWebPreferences {
  readonly session: Session;
  readonly preload: string;
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
}

export interface CtoxGuestManagerOptions {
  readonly createView?: (webPreferences: CtoxGuestWebPreferences) => WebContentsView | undefined;
}

export class CtoxGuestManager extends Context.Service<
  CtoxGuestManager,
  {
    readonly enterBusinessOsMode: Effect.Effect<CtoxManagedActionResult>;
    readonly exitBusinessOsMode: Effect.Effect<CtoxManagedActionResult>;
    readonly activate: (
      instanceId: string,
      bounds: CtoxGuestBounds,
    ) => Effect.Effect<CtoxManagedGuestResult>;
    readonly deactivate: Effect.Effect<CtoxManagedActionResult>;
    readonly deactivateInstance: (instanceId: string) => Effect.Effect<CtoxManagedActionResult>;
    readonly setBounds: (bounds: CtoxGuestBounds) => Effect.Effect<CtoxManagedActionResult>;
    /** Bounded read of the active guest's installed modules and active module. */
    readonly readGuestApps: (instanceId: string) => Effect.Effect<CtoxGuestAppsObservation>;
    /** Activate the instance if needed, then open the module in its guest. */
    readonly openGuestApp: (
      instanceId: string,
      moduleId: string,
      bounds: CtoxGuestBounds,
    ) => Effect.Effect<CtoxManagedActionResult>;
  }
>()("@t3tools/desktop/ctox/CtoxGuestManager") {}

export const CTOX_APP_MODULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_GUEST_APPS = 128;
const MAX_GUEST_APP_TITLE_LENGTH = 128;

export interface CtoxGuestAppObservation {
  readonly id: string;
  readonly title?: string;
}

export type CtoxGuestAppsObservation =
  | {
      readonly _tag: "completed";
      readonly apps: readonly CtoxGuestAppObservation[];
      readonly activeModuleId: string | null;
    }
  | { readonly _tag: "failed"; readonly code: "not_active" | "guest_failed" };

// Fixed, renderer-independent expression: reads only bounded module identity
// data from the guest's own app state. Never interpolates untrusted input.
const GUEST_LIST_APPS_EXPRESSION = `(() => {
  const app = globalThis.CTOX_BUSINESS_OS_APP;
  if (!app || !Array.isArray(app.modules)) return { ok: false };
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const apps = [];
  for (const mod of app.modules) {
    const id = typeof mod?.id === "string" ? mod.id : "";
    if (!idPattern.test(id)) continue;
    const rawTitle = typeof mod?.title === "string"
      ? mod.title
      : typeof mod?.name === "string" ? mod.name : "";
    const title = rawTitle.trim().slice(0, ${MAX_GUEST_APP_TITLE_LENGTH});
    apps.push(title.length > 0 ? { id, title } : { id });
    if (apps.length >= ${MAX_GUEST_APPS}) break;
  }
  const activeId = typeof app.activeModule?.id === "string" && idPattern.test(app.activeModule.id)
    ? app.activeModule.id
    : null;
  return { ok: true, apps, activeModule: activeId };
})()`;

function buildGuestOpenModuleExpression(moduleId: string): string {
  // The id is validated against CTOX_APP_MODULE_ID_PATTERN before this point;
  // JSON-encoding keeps the embedded literal inert either way.
  return `(async () => {
  const app = globalThis.CTOX_BUSINESS_OS_APP;
  if (!app || typeof app.openModule !== "function") return { ok: false };
  await app.openModule(${JSON.stringify(moduleId)});
  return { ok: true };
})()`;
}

function stripControlCharacters(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) continue;
    out += character;
  }
  return out;
}

function decodeGuestAppsObservation(
  raw: unknown,
): { apps: readonly CtoxGuestAppObservation[]; activeModuleId: string | null } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as {
    readonly ok?: unknown;
    readonly apps?: unknown;
    readonly activeModule?: unknown;
  };
  if (record.ok !== true || !Array.isArray(record.apps)) return undefined;
  const apps: CtoxGuestAppObservation[] = [];
  for (const entry of record.apps.slice(0, MAX_GUEST_APPS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { readonly id?: unknown; readonly title?: unknown };
    if (typeof candidate.id !== "string" || !CTOX_APP_MODULE_ID_PATTERN.test(candidate.id)) {
      continue;
    }
    const title =
      typeof candidate.title === "string"
        ? stripControlCharacters(candidate.title).trim().slice(0, MAX_GUEST_APP_TITLE_LENGTH)
        : "";
    apps.push(title.length > 0 ? { id: candidate.id, title } : { id: candidate.id });
  }
  const activeModuleId =
    typeof record.activeModule === "string" && CTOX_APP_MODULE_ID_PATTERN.test(record.activeModule)
      ? record.activeModule
      : null;
  return { apps, activeModuleId };
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/{2,}/g, "/").toLowerCase();
  if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized || "/";
}

function stripBusinessOsPathPrefix(path: string): string {
  if (path === "/business-os") return "/";
  return path.startsWith("/business-os/") ? path.slice("/business-os".length) : path;
}

function isAllowedStaticAssetPath(path: string, method = "GET"): boolean {
  const normalizedMethod = method.trim().toUpperCase();
  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") return false;
  const assetPath = stripBusinessOsPathPrefix(path);
  if (STATIC_ASSET_PATHS.has(assetPath)) return true;
  if (!STATIC_ASSET_PREFIXES.some((prefix) => assetPath.startsWith(prefix))) return false;
  const filename = assetPath.slice(assetPath.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  return (
    dot > 0 && dot < filename.length - 1 && STATIC_ASSET_EXTENSIONS.has(filename.slice(dot + 1))
  );
}

export function isSafeCtoxExternalUrl(rawUrl: string): boolean {
  try {
    return SAFE_EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

export function isAllowedCtoxTopFrameNavigation(rawUrl: string, launchOrigin: string): boolean {
  if (rawUrl === "about:blank") return true;
  try {
    const url = new URL(rawUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === launchOrigin;
  } catch {
    return false;
  }
}

export function isForbiddenCtoxDataRequest(
  rawUrl: string,
  resourceType: string,
  launchOrigin: string,
  method = "GET",
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    const path = normalizePathname(url.pathname);
    const shellPath = stripBusinessOsPathPrefix(path);
    if (shellPath.startsWith("/api/business-os/") || shellPath === "/api/business-os") {
      if (!ALLOWED_CONTROL_PATHS.has(shellPath)) return true;
    }
    if (
      shellPath.startsWith("/rxdb/") &&
      !shellPath.startsWith("/rxdb/dist/") &&
      !isAllowedStaticAssetPath(shellPath, method)
    )
      return true;
    if (shellPath === "/commands" || shellPath.startsWith("/commands/")) return true;
  }
  if (!DATA_RESOURCE_TYPES.has(resourceType)) return false;
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  let launchHost: string;
  try {
    launchHost = new URL(launchOrigin).host;
  } catch {
    return true;
  }
  if (url.host !== launchHost) return false;
  const path = normalizePathname(url.pathname);
  const shellPath = stripBusinessOsPathPrefix(path);
  if (
    ALLOWED_CONTROL_PATHS.has(shellPath) ||
    shellPath.startsWith("/rxdb/dist/") ||
    isAllowedStaticAssetPath(shellPath, method)
  )
    return false;
  return !isAllowedStaticAssetPath(path, method);
}

export function scrubSensitiveCtoxUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    let changed = false;
    for (const key of SENSITIVE_QUERY_PARAMETERS) {
      if (!url.searchParams.has(key)) continue;
      url.searchParams.delete(key);
      changed = true;
    }
    return changed ? url.toString() : rawUrl;
  } catch {
    return undefined;
  }
}

function isValidBounds(bounds: CtoxGuestBounds): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(
    (value) => Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647,
  );
}

function destroyGuest(active: ActiveGuest | undefined): void {
  if (active === undefined) return;
  try {
    active.window.contentView.removeChildView(active.view);
  } catch {
    // Continue with destruction even if the native hierarchy already detached it.
  }
  try {
    if (!active.view.webContents.isDestroyed()) active.view.webContents.close();
  } catch {
    // Release is best-effort after the view has been detached.
  }
}

function installRequestGuard(session: Session, launchOrigin: string): boolean {
  const webRequest = session.webRequest;
  if (webRequest === undefined || typeof webRequest.onBeforeRequest !== "function") return false;
  try {
    webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (details: BeforeRequestDetails, callback: (response: { cancel: boolean }) => void) => {
        callback({
          cancel: isForbiddenCtoxDataRequest(
            details.url,
            details.resourceType,
            launchOrigin,
            details.method,
          ),
        });
      },
    );
    return true;
  } catch {
    return false;
  }
}

export function createGuestView(
  webPreferences: CtoxGuestWebPreferences,
): WebContentsView | undefined {
  try {
    const view = new WebContentsView({ webPreferences });
    if (view.webContents.session === webPreferences.session) return view;
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {
      // The session mismatch already makes the view unusable; best-effort close.
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function attachGuest(
  window: BrowserWindow,
  view: WebContentsView,
  bounds: CtoxGuestBounds,
): boolean {
  try {
    view.setBounds(bounds);
    window.contentView.addChildView(view);
    return true;
  } catch {
    try {
      window.contentView.removeChildView(view);
    } catch {
      // Nothing else can be detached.
    }
    return false;
  }
}

function isSuccessfulCtoxNavigationCommit(
  rawUrl: string,
  launchOrigin: string,
  httpResponseCode: number,
): boolean {
  if (
    !Number.isSafeInteger(httpResponseCode) ||
    httpResponseCode < 200 ||
    httpResponseCode >= 400
  ) {
    return false;
  }
  try {
    const url = new URL(rawUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === launchOrigin;
  } catch {
    return false;
  }
}

function waitForGuestNavigationCommit(
  webContents: WebContents,
  launchUrl: string,
  launchOrigin: string,
): Effect.Effect<boolean> {
  let cleanup = (): void => undefined;
  return Effect.tryPromise({
    try: () =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        const removeListener = (event: string, listener: (...args: Array<never>) => void): void => {
          try {
            webContents.off(event as never, listener as never);
          } catch {
            // Destruction may race listener cleanup.
          }
        };
        const onDidFrameNavigate = (
          _event: unknown,
          url: string,
          httpResponseCode: number,
          _httpStatusText: string,
          isMainFrame: boolean,
        ): void => {
          if (!isMainFrame) return;
          finish(isSuccessfulCtoxNavigationCommit(url, launchOrigin, httpResponseCode));
        };
        const onDidFailLoad = (
          _event: unknown,
          _errorCode: number,
          _errorDescription: string,
          _validatedUrl: string,
          isMainFrame: boolean,
        ): void => {
          if (isMainFrame) finish(false);
        };
        const onWillNavigate = (
          _event: { readonly preventDefault: () => void },
          url: string,
        ): void => {
          if (!isAllowedCtoxTopFrameNavigation(url, launchOrigin)) finish(false);
        };
        const onDestroyed = (): void => finish(false);
        cleanup = (): void => {
          removeListener("did-frame-navigate", onDidFrameNavigate as never);
          removeListener("did-fail-load", onDidFailLoad as never);
          removeListener("will-navigate", onWillNavigate as never);
          removeListener("destroyed", onDestroyed as never);
        };
        const finish = (committed: boolean): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(committed);
        };

        try {
          webContents.on("did-frame-navigate", onDidFrameNavigate as never);
          webContents.on("did-fail-load", onDidFailLoad as never);
          webContents.on("will-navigate", onWillNavigate as never);
          webContents.on("destroyed", onDestroyed);
          const loading = webContents.loadURL(launchUrl);
          void loading.then(
            () => undefined,
            () => finish(false),
          );
        } catch {
          finish(false);
        }
      }),
    catch: () => undefined,
  }).pipe(
    Effect.orElseSucceed(() => false),
    Effect.ensuring(Effect.sync(() => cleanup())),
  );
}

export const make = (options: CtoxGuestManagerOptions = {}) =>
  Effect.gen(function* () {
    const auth = yield* CtoxDevAuth.CtoxDevAuth;
    const businessOsShell = yield* CtoxBusinessOsShell.CtoxBusinessOsShell;
    const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
    const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
    const launches = yield* CtoxManagedLaunch.CtoxManagedLaunch;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const electronShell = yield* ElectronShell.ElectronShell;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const stateRef = yield* SynchronizedRef.make<GuestState>({
      businessOsModeActive: false,
      active: undefined,
    });

    const preloadPath = `${__dirname}/ctox-guest-preload.cjs`;

    const enterBusinessOsMode = SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.succeed([
        { _tag: "completed" } as const,
        { ...state, businessOsModeActive: true },
      ] as const),
    );

    const exitBusinessOsMode = SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.sync(() => {
        destroyGuest(state.active);
        return [
          { _tag: "completed" } as const,
          { businessOsModeActive: false, active: undefined },
        ] as const;
      }),
    );

    const deactivate = SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.sync(() => {
        destroyGuest(state.active);
        return [{ _tag: "completed" } as const, { ...state, active: undefined }] as const;
      }),
    );

    const deactivateInstance = (instanceId: string) =>
      SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.sync(() => {
          if (state.active?.instanceId !== instanceId) {
            return [{ _tag: "completed" } as const, state] as const;
          }
          destroyGuest(state.active);
          return [{ _tag: "completed" } as const, { ...state, active: undefined }] as const;
        }),
      );

    yield* Effect.addFinalizer(() => exitBusinessOsMode.pipe(Effect.asVoid));

    let refreshFromWebContents: (sender: WebContents) => void = () => undefined;

    const prepareGuest = Effect.fn("CtoxGuestManager.prepareGuest")(function* (
      instanceId: string,
      bounds: CtoxGuestBounds,
      existingSession?: Session,
    ) {
      if (!isValidBounds(bounds)) {
        return [{ _tag: "failed", code: "invalid_input" }, undefined] as const;
      }

      const managed = yield* auth.refresh.pipe(
        Effect.orElseSucceed(() => ({ _tag: "failed", code: "network_error" }) as const),
      );
      const discovery = yield* registry.merge(managed);
      const descriptor =
        discovery._tag === "ready"
          ? discovery.instances.find((instance) => instance.id === instanceId)
          : undefined;
      if (descriptor === undefined) {
        const managedState =
          discovery._tag === "ready" ? (discovery.managedState ?? "ready") : discovery._tag;
        return managedState === "failed"
          ? ([{ _tag: "failed", code: "guest_failed" }, undefined] as const)
          : ([{ _tag: "revoked" }, undefined] as const);
      }

      let authoritativeDescriptor: CtoxManagedInstance;
      let launch: Option.Option<CtoxBusinessOsShell.CtoxBusinessOsLaunch>;
      if (
        descriptor.source === "ctox_dev" &&
        descriptor.status === "available" &&
        descriptor.id.startsWith("managed:")
      ) {
        authoritativeDescriptor = descriptor;
        launch = yield* launches.launch(descriptor).pipe(Effect.option);
      } else if (
        (descriptor.source === "pairing_invite" || descriptor.source === "manual_pairing") &&
        descriptor.status === "paired"
      ) {
        const resolved = yield* registry.resolvePairedLaunch(descriptor.id).pipe(Effect.option);
        if (
          Option.isNone(resolved) ||
          resolved.value.descriptor.id !== descriptor.id ||
          resolved.value.descriptor.source !== descriptor.source
        ) {
          return [{ _tag: "revoked" }, undefined] as const;
        }
        authoritativeDescriptor = resolved.value.descriptor;
        launch = yield* businessOsShell.launch(resolved.value.config).pipe(Effect.option);
      } else {
        return [{ _tag: "revoked" }, undefined] as const;
      }
      if (Option.isNone(launch)) {
        return [{ _tag: "failed", code: "launch_failed" }, undefined] as const;
      }
      const resolvedSession =
        existingSession === undefined
          ? yield* sessions.instance(authoritativeDescriptor).pipe(Effect.option)
          : Option.some(existingSession);
      if (Option.isNone(resolvedSession)) {
        return [{ _tag: "failed", code: "guest_failed" }, undefined] as const;
      }
      const mainWindow = yield* electronWindow.main;
      if (Option.isNone(mainWindow) || mainWindow.value.isDestroyed()) {
        return [{ _tag: "failed", code: "guest_failed" }, undefined] as const;
      }

      const view = (options.createView ?? createGuestView)({
        session: resolvedSession.value,
        preload: preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      });
      if (view === undefined) {
        return [{ _tag: "failed", code: "guest_failed" }, undefined] as const;
      }
      const failView = (): readonly [CtoxManagedGuestResult, undefined] => {
        destroyGuest({
          instanceId,
          window: mainWindow.value,
          view,
          bounds,
          browserSession: resolvedSession.value,
        });
        return [{ _tag: "failed", code: "guest_failed" }, undefined] as const;
      };
      if (!installRequestGuard(resolvedSession.value, launch.value.launchOrigin)) {
        return failView();
      }

      const webContents = view.webContents;
      try {
        webContents.setWindowOpenHandler(({ url }) => {
          if (isSafeCtoxExternalUrl(url)) void runPromise(electronShell.openExternal(url));
          return { action: "deny" };
        });
        webContents.on("will-navigate", (event, url) => {
          if (isAllowedCtoxTopFrameNavigation(url, launch.value.launchOrigin)) return;
          event.preventDefault();
          if (isSafeCtoxExternalUrl(url)) void runPromise(electronShell.openExternal(url));
        });
        webContents.on("did-finish-load", () => {
          const currentUrl = webContents.getURL();
          const scrubbed = scrubSensitiveCtoxUrl(currentUrl);
          if (scrubbed === undefined || scrubbed === currentUrl) return;
          void webContents
            .executeJavaScript(
              `history.replaceState(history.state, document.title, ${encodeUnknownJson(scrubbed)});`,
              true,
            )
            .catch(() => undefined);
        });
        webContents.ipc.on(REFRESH_MANAGED_LAUNCH_CHANNEL, (_event, ...args) => {
          if (args.length === 0) refreshFromWebContents(webContents);
        });
      } catch {
        return failView();
      }
      if (!attachGuest(mainWindow.value, view, bounds)) return failView();

      const active: ActiveGuest = {
        instanceId,
        window: mainWindow.value,
        view,
        bounds,
        browserSession: resolvedSession.value,
      };
      const committed = yield* waitForGuestNavigationCommit(
        webContents,
        launch.value.launchUrl,
        launch.value.launchOrigin,
      ).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            destroyGuest(active);
          }),
        ),
      );
      if (!committed) {
        destroyGuest(active);
        return [{ _tag: "failed", code: "guest_failed" }, undefined] as const;
      }
      return [{ _tag: "ready", instanceId }, active] as const;
    });

    const activate = (
      instanceId: string,
      bounds: CtoxGuestBounds,
    ): Effect.Effect<CtoxManagedGuestResult> =>
      SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* () {
          if (!state.businessOsModeActive) {
            return [{ _tag: "failed", code: "not_active" } as const, state] as const;
          }
          destroyGuest(state.active);
          const [result, active] = yield* prepareGuest(instanceId, bounds);
          return [result, { ...state, active }] as const;
        }),
      );

    const refresh = (sender: WebContents) =>
      SynchronizedRef.modifyEffect(stateRef, (state) => {
        const active = state.active;
        if (active === undefined || active.view.webContents !== sender || sender.isDestroyed()) {
          return Effect.succeed([undefined, state] as const);
        }
        return Effect.gen(function* () {
          destroyGuest(active);
          const [, replacement] = yield* prepareGuest(
            active.instanceId,
            active.bounds,
            active.browserSession,
          );
          return [undefined, { ...state, active: replacement }] as const;
        });
      });

    refreshFromWebContents = (sender) => {
      void runPromise(refresh(sender)).catch(() => undefined);
    };

    const setBounds = (bounds: CtoxGuestBounds): Effect.Effect<CtoxManagedActionResult> =>
      SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.sync((): readonly [CtoxManagedActionResult, GuestState] => {
          if (!isValidBounds(bounds)) {
            return [{ _tag: "failed", code: "invalid_input" }, state];
          }
          const active = state.active;
          if (active === undefined) {
            return [{ _tag: "failed", code: "not_active" }, state];
          }
          try {
            active.view.setBounds(bounds);
            return [{ _tag: "completed" }, { ...state, active: { ...active, bounds } }];
          } catch {
            destroyGuest(active);
            return [
              { _tag: "failed", code: "guest_failed" },
              { ...state, active: undefined },
            ];
          }
        }),
      );

    const readGuestApps = (instanceId: string): Effect.Effect<CtoxGuestAppsObservation> =>
      SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* (): Generator<
          Effect.Effect<unknown>,
          readonly [CtoxGuestAppsObservation, GuestState],
          never
        > {
          const active = state.active;
          if (
            active === undefined ||
            active.instanceId !== instanceId ||
            active.view.webContents.isDestroyed()
          ) {
            return [{ _tag: "failed", code: "not_active" } as const, state] as const;
          }
          const raw = yield* Effect.tryPromise({
            try: () => active.view.webContents.executeJavaScript(GUEST_LIST_APPS_EXPRESSION, true),
            catch: () => undefined,
          }).pipe(Effect.orElseSucceed(() => undefined));
          const observation = decodeGuestAppsObservation(raw);
          if (observation === undefined) {
            return [{ _tag: "failed", code: "guest_failed" } as const, state] as const;
          }
          return [{ _tag: "completed", ...observation } as const, state] as const;
        }),
      );

    const openGuestApp = (
      instanceId: string,
      moduleId: string,
      bounds: CtoxGuestBounds,
    ): Effect.Effect<CtoxManagedActionResult> =>
      Effect.gen(function* () {
        if (!CTOX_APP_MODULE_ID_PATTERN.test(moduleId) || !isValidBounds(bounds)) {
          return { _tag: "failed", code: "invalid_input" } as const;
        }
        const currentlyActive = yield* SynchronizedRef.get(stateRef).pipe(
          Effect.map(
            (state) =>
              state.active !== undefined &&
              state.active.instanceId === instanceId &&
              !state.active.view.webContents.isDestroyed(),
          ),
        );
        if (!currentlyActive) {
          const activation = yield* activate(instanceId, bounds);
          if (activation._tag !== "ready") {
            return {
              _tag: "failed",
              code: activation._tag === "failed" ? activation.code : "guest_failed",
            } as const;
          }
        }
        return yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
          Effect.gen(function* (): Generator<
            Effect.Effect<unknown>,
            readonly [CtoxManagedActionResult, GuestState],
            never
          > {
            const active = state.active;
            if (
              active === undefined ||
              active.instanceId !== instanceId ||
              active.view.webContents.isDestroyed()
            ) {
              return [{ _tag: "failed", code: "not_active" } as const, state] as const;
            }
            const opened = yield* Effect.tryPromise({
              try: () =>
                active.view.webContents.executeJavaScript(
                  buildGuestOpenModuleExpression(moduleId),
                  true,
                ),
              catch: () => undefined,
            }).pipe(Effect.orElseSucceed(() => undefined));
            const succeeded =
              typeof opened === "object" &&
              opened !== null &&
              (opened as { readonly ok?: unknown }).ok === true;
            return [
              succeeded
                ? ({ _tag: "completed" } as const)
                : ({ _tag: "failed", code: "guest_failed" } as const),
              state,
            ] as const;
          }),
        );
      });

    return CtoxGuestManager.of({
      enterBusinessOsMode,
      exitBusinessOsMode,
      activate,
      deactivate,
      deactivateInstance,
      setBounds,
      readGuestApps,
      openGuestApp,
    });
  }).pipe(Effect.withSpan("CtoxGuestManager.make"));

export const layer = (options: CtoxGuestManagerOptions = {}) =>
  Layer.effect(CtoxGuestManager, make(options));
