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
const STATIC_ASSET_PATHS = new Set(["/system-apps.json", "/modules/registry.json"]);
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
    readonly activate: (
      instanceId: string,
      bounds: CtoxGuestBounds,
    ) => Effect.Effect<CtoxManagedGuestResult>;
    readonly deactivate: Effect.Effect<CtoxManagedActionResult>;
    readonly deactivateInstance: (instanceId: string) => Effect.Effect<CtoxManagedActionResult>;
    readonly setBounds: (bounds: CtoxGuestBounds) => Effect.Effect<CtoxManagedActionResult>;
  }
>()("@t3tools/desktop/ctox/CtoxGuestManager") {}

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/{2,}/g, "/").toLowerCase();
  if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized || "/";
}

function isAllowedStaticAssetPath(path: string, method = "GET"): boolean {
  const normalizedMethod = method.trim().toUpperCase();
  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") return false;
  const assetPath = path.startsWith("/business-os/") ? path.slice("/business-os".length) : path;
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
    if (path.startsWith("/api/business-os/") || path === "/api/business-os") {
      if (!ALLOWED_CONTROL_PATHS.has(path)) return true;
    }
    if (path.startsWith("/rxdb/") && !path.startsWith("/rxdb/dist/")) return true;
    if (path === "/commands" || path.startsWith("/commands/")) return true;
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
  if (ALLOWED_CONTROL_PATHS.has(path) || path.startsWith("/rxdb/dist/")) return false;
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
    const activeRef = yield* SynchronizedRef.make<ActiveGuest | undefined>(undefined);

    const preloadPath = `${__dirname}/ctox-guest-preload.cjs`;

    const deactivate = SynchronizedRef.modifyEffect(activeRef, (active) =>
      Effect.sync(() => {
        destroyGuest(active);
        return [{ _tag: "completed" }, undefined] as const;
      }),
    );

    const deactivateInstance = (instanceId: string) =>
      SynchronizedRef.modifyEffect(activeRef, (active) =>
        Effect.sync(() => {
          if (active?.instanceId !== instanceId) {
            return [{ _tag: "completed" }, active] as const;
          }
          destroyGuest(active);
          return [{ _tag: "completed" }, undefined] as const;
        }),
      );

    yield* Effect.addFinalizer(() => deactivate.pipe(Effect.asVoid));

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
      const loaded = yield* Effect.tryPromise({
        try: () => webContents.loadURL(launch.value.launchUrl),
        catch: () => undefined,
      }).pipe(Effect.option);
      if (Option.isNone(loaded)) {
        destroyGuest(active);
        return [{ _tag: "failed", code: "guest_failed" }, undefined] as const;
      }
      return [{ _tag: "ready", instanceId }, active] as const;
    });

    const activate = (
      instanceId: string,
      bounds: CtoxGuestBounds,
    ): Effect.Effect<CtoxManagedGuestResult> =>
      SynchronizedRef.modifyEffect(activeRef, (current) =>
        Effect.gen(function* () {
          destroyGuest(current);
          return yield* prepareGuest(instanceId, bounds);
        }),
      );

    const refresh = (sender: WebContents) =>
      SynchronizedRef.modifyEffect(activeRef, (active) => {
        if (active === undefined || active.view.webContents !== sender || sender.isDestroyed()) {
          return Effect.succeed([undefined, active] as const);
        }
        return Effect.gen(function* () {
          destroyGuest(active);
          const [, replacement] = yield* prepareGuest(
            active.instanceId,
            active.bounds,
            active.browserSession,
          );
          return [undefined, replacement] as const;
        });
      });

    refreshFromWebContents = (sender) => {
      void runPromise(refresh(sender)).catch(() => undefined);
    };

    const setBounds = (bounds: CtoxGuestBounds): Effect.Effect<CtoxManagedActionResult> =>
      SynchronizedRef.modifyEffect(activeRef, (active) =>
        Effect.sync((): readonly [CtoxManagedActionResult, ActiveGuest | undefined] => {
          if (!isValidBounds(bounds)) {
            return [{ _tag: "failed", code: "invalid_input" }, active];
          }
          if (active === undefined) {
            return [{ _tag: "failed", code: "not_active" }, active];
          }
          try {
            active.view.setBounds(bounds);
            return [{ _tag: "completed" }, { ...active, bounds }];
          } catch {
            destroyGuest(active);
            return [{ _tag: "failed", code: "guest_failed" }, undefined];
          }
        }),
      );

    return CtoxGuestManager.of({ activate, deactivate, deactivateInstance, setBounds });
  }).pipe(Effect.withSpan("CtoxGuestManager.make"));

export const layer = (options: CtoxGuestManagerOptions = {}) =>
  Layer.effect(CtoxGuestManager, make(options));
