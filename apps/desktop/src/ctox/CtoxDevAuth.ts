// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxManagedDiscoveryResult } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BrowserWindow, Cookie } from "electron";
import * as NodeCrypto from "node:crypto";

import * as ElectronShell from "../electron/ElectronShell.ts";
import { currentRecovery, DesktopKeyRecovery } from "../app/DesktopKeyRecovery.ts";
import { CtoxControlDevice } from "./CtoxControlDevice.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  discoverCtoxManagedInstances,
  normalizeCtoxManagedBaseUrl,
} from "./CtoxManagedDiscovery.ts";
import * as CtoxElectronSessions from "./CtoxElectronSessions.ts";

const DEFAULT_CTOX_DEV_BASE_URL = "https://ctox.dev";
const DEFAULT_LOGIN_POLL_INTERVAL_MS = 1_500;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const DESKTOP_CLIENT = "ctox-business-os-desktop";
export const CTOX_DEV_LOGIN_WINDOW_TITLE = "Bei ctox.dev anmelden";

export interface CtoxDevAuthOptions {
  readonly baseUrl?: string;
  readonly loginPollIntervalMs?: number;
  readonly loginTimeoutMs?: number;
}

export type CtoxDevLoginResult =
  | {
      readonly _tag: "completed";
      readonly via: "url" | "refresh";
      readonly loginId?: string;
      readonly discovery?: CtoxManagedDiscoveryResult;
    }
  | {
      readonly _tag: "not_completed";
      readonly reason: "closed" | "timeout";
    };

const CtoxDevAuthOperation = Schema.Literals([
  "account-session",
  "logout-storage",
  "logout-cookies",
  "create-login-window",
  "load-login-window",
  "device-key",
]);

export class CtoxDevAuthConfigurationError extends Schema.TaggedErrorClass<CtoxDevAuthConfigurationError>()(
  "CtoxDevAuthConfigurationError",
  {},
) {
  override get message(): string {
    return "The CTOX account authentication configuration is invalid.";
  }
}

export class CtoxDevAuthOperationError extends Schema.TaggedErrorClass<CtoxDevAuthOperationError>()(
  "CtoxDevAuthOperationError",
  { operation: CtoxDevAuthOperation },
) {
  override get message(): string {
    return "The CTOX account authentication operation failed.";
  }
}

export const CtoxDevAuthError = Schema.Union([
  CtoxDevAuthConfigurationError,
  CtoxDevAuthOperationError,
]);
export type CtoxDevAuthError = typeof CtoxDevAuthError.Type;
export const isCtoxDevAuthError = Schema.is(CtoxDevAuthError);
const isCtoxDevAuthOperationError = Schema.is(CtoxDevAuthOperationError);

export class CtoxDevAuth extends Context.Service<
  CtoxDevAuth,
  {
    readonly refresh: Effect.Effect<CtoxManagedDiscoveryResult, CtoxDevAuthOperationError>;
    readonly login: Effect.Effect<CtoxDevLoginResult, CtoxDevAuthOperationError>;
    readonly logout: Effect.Effect<void, CtoxDevAuthOperationError>;
    readonly deviceStatus?: Effect.Effect<import("@workjet/contracts").CtoxControlDeviceStatus>;
    readonly resetDevice?: Effect.Effect<void>;
  }
>()("@workjet/desktop/ctox/CtoxDevAuth") {}

interface CookieApi {
  readonly get?: (filter: Record<string, never>) => Promise<readonly Cookie[]>;
  readonly remove?: (url: string, name: string) => Promise<void>;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]") {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function normalizeCookieDomain(domain: string | undefined): string | undefined {
  if (domain === undefined) return undefined;
  const normalized = domain.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
  if (normalized === "::1" || normalized === "[::1]") return "[::1]";
  if (normalized.length === 0 || normalized.includes("/") || normalized.includes(":")) {
    return undefined;
  }
  return normalized;
}

function cookieDomainMatchesAccountHost(cookieDomain: string, accountHost: string): boolean {
  if (isLoopbackHostname(accountHost)) return cookieDomain === accountHost;
  if (cookieDomain.split(".").length < 2) return false;
  return (
    cookieDomain === accountHost ||
    accountHost.endsWith(`.${cookieDomain}`) ||
    cookieDomain.endsWith(`.${accountHost}`)
  );
}

function cookieRemovalUrl(cookie: Cookie, domain: string, accountUrl: URL): string {
  const protocol = cookie.secure === false ? "http:" : "https:";
  const path = typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
  if (isLoopbackHostname(accountUrl.hostname) && domain === accountUrl.hostname) {
    return `${protocol}//${accountUrl.host}${path}`;
  }
  return `${protocol}//${domain}${path}`;
}

function safeWebUrl(rawUrl: unknown): URL | undefined {
  if (typeof rawUrl !== "string") return undefined;
  try {
    const url = new URL(rawUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function isLoginCompletionUrl(rawUrl: unknown, accountOrigin: string): boolean {
  const url = safeWebUrl(rawUrl);
  if (url === undefined || url.origin !== accountOrigin || url.hash !== "") return false;
  if (url.pathname === "/desktop/auth/complete") return true;
  if (url.pathname !== "/dashboard" || url.searchParams.size !== 3) return false;
  return (
    url.searchParams.getAll("desktop").length === 1 &&
    url.searchParams.get("desktop") === "1" &&
    url.searchParams.getAll("client").length === 1 &&
    url.searchParams.get("client") === DESKTOP_CLIENT &&
    url.searchParams.getAll("auth_completed").length === 1 &&
    url.searchParams.get("auth_completed") === "1"
  );
}

function closeWindow(window: BrowserWindow): void {
  try {
    if (!window.isDestroyed()) window.close();
  } catch {
    // The login result is already settled; native close failures are non-fatal.
  }
}

export const make = (options: CtoxDevAuthOptions = {}) =>
  Effect.gen(function* () {
    const baseUrl = normalizeCtoxManagedBaseUrl(options.baseUrl ?? DEFAULT_CTOX_DEV_BASE_URL);
    const pollIntervalMs = options.loginPollIntervalMs ?? DEFAULT_LOGIN_POLL_INTERVAL_MS;
    const timeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    if (
      baseUrl === undefined ||
      !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs < 1 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1
    ) {
      return yield* new CtoxDevAuthConfigurationError();
    }

    const accountUrl = new URL(baseUrl);
    const ctoxSessions = yield* CtoxElectronSessions.CtoxElectronSessions;
    const deviceOption = yield* Effect.serviceOption(CtoxControlDevice);
    const device = Option.getOrUndefined(deviceOption);
    const recovery = Option.getOrUndefined(yield* Effect.serviceOption(DesktopKeyRecovery));
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const electronShell = yield* ElectronShell.ElectronShell;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const runPromise = Effect.runPromiseWith(context);

    const accountSession = ctoxSessions.account.pipe(
      Effect.mapError(() => new CtoxDevAuthOperationError({ operation: "account-session" })),
    );

    let deviceDiscovery:
      | { generation: string | undefined; discovery: CtoxManagedDiscoveryResult }
      | undefined;
    const recoverWithDevice = Effect.promise(async () => {
      if (device === undefined || (await device.status()).state !== "active") return undefined;

      const state = recovery === undefined ? undefined : await runPromise(recovery.inspect);
      if (
        recovery?.claimDeviceRecovery !== undefined &&
        !(await runPromise(recovery.claimDeviceRecovery))
      )
        return deviceDiscovery?.generation === state?.generation
          ? deviceDiscovery?.discovery
          : undefined;
      const response = await device.recoverOnce(state?.generation);
      if (response === undefined) return undefined;
      const discovery = await discoverCtoxManagedInstances({
        baseUrl,
        fetchImpl: async () => response.clone(),
      });
      if (
        discovery._tag === "ready" &&
        discovery.sessionVerified === true &&
        state?.pendingLogin &&
        recovery?.restartManagedRepairAfterLogin !== undefined
      ) {
        const status = await device?.status();
        if (status?.state === "active")
          await runPromise(recovery.restartManagedRepairAfterLogin(`device:${status.createdAt}`));
      }
      if (discovery._tag === "ready" && discovery.sessionVerified === true)
        deviceDiscovery = {
          generation:
            recovery === undefined ? undefined : (await runPromise(recovery.inspect))?.generation,
          discovery,
        };
      return discovery;
    }).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.withSpan("CtoxDevAuth.discovery", { attributes: { authentication: "device_key" } }),
    );
    const refresh = Effect.gen(function* () {
      if (
        (yield* currentRecovery.pipe(Effect.orElseSucceed(() => undefined)))?.pendingLogin === true
      ) {
        const restored = yield* recoverWithDevice;
        if (restored?._tag === "ready") return restored;
      }
      const browserSession = yield* accountSession;
      const discovery = yield* Effect.promise(() =>
        discoverCtoxManagedInstances({
          baseUrl,
          fetchImpl: (url, init) => browserSession.fetch(url, init),
        }),
      ).pipe(
        Effect.withSpan("CtoxDevAuth.discovery", {
          attributes: { authentication: "account_session" },
        }),
      );
      if (discovery._tag === "signed_out") {
        const restored = yield* recoverWithDevice;
        if (restored?._tag === "ready") return restored;
      }
      if (discovery._tag === "ready" && discovery.sessionVerified === true && device !== undefined)
        yield* Effect.promise(() =>
          device.retryEnrollment((url, init) => browserSession.fetch(url, init)),
        ).pipe(Effect.ignore);
      return discovery;
    }).pipe(Effect.withSpan("CtoxDevAuth.refresh"));

    const logout = Effect.gen(function* () {
      deviceDiscovery = undefined;
      if (device !== undefined)
        yield* Effect.tryPromise({
          try: () => device.suspend(),
          catch: () => new CtoxDevAuthOperationError({ operation: "device-key" }),
        });
      const browserSession = yield* accountSession;
      yield* Effect.tryPromise({
        try: () =>
          browserSession.clearStorageData({
            origin: baseUrl,
            storages: ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"],
          }),
        catch: () => new CtoxDevAuthOperationError({ operation: "logout-storage" }),
      });

      const cookies = browserSession.cookies as unknown as CookieApi;
      if (typeof cookies.get === "function" && typeof cookies.remove === "function") {
        const accountCookies = yield* Effect.tryPromise({
          try: () => cookies.get?.({}) ?? Promise.resolve([]),
          catch: () => new CtoxDevAuthOperationError({ operation: "logout-cookies" }),
        });
        yield* Effect.all(
          accountCookies.flatMap((cookie) => {
            const domain = normalizeCookieDomain(cookie.domain);
            if (
              domain === undefined ||
              !cookieDomainMatchesAccountHost(domain, accountUrl.hostname)
            ) {
              return [];
            }
            return [
              Effect.tryPromise({
                try: () =>
                  cookies.remove?.(cookieRemovalUrl(cookie, domain, accountUrl), cookie.name) ??
                  Promise.resolve(),
                catch: () => new CtoxDevAuthOperationError({ operation: "logout-cookies" }),
              }),
            ];
          }),
          { concurrency: "unbounded", discard: true },
        );
      }
    }).pipe(Effect.withSpan("CtoxDevAuth.logout"));

    const runLogin = Effect.gen(function* () {
      if (device !== undefined)
        yield* Effect.tryPromise({
          try: () => device.suspend(),
          catch: () => new CtoxDevAuthOperationError({ operation: "device-key" }),
        });
      yield* accountSession;
      const parent = yield* electronWindow.currentMainOrFirst;
      // Ausnahme von „nichts außerhalb der App“ (D39): ctox.dev läuft in einer
      // eigenen, sandboxed Partition, damit kein Konto-Token je den Renderer
      // erreicht und die Origin-Bindung der Abschlussprüfung bleibt. Das
      // Fenster ist ein Kindfenster der App mit festem deutschem Titel.
      const loginWindow = yield* electronWindow
        .create({
          title: CTOX_DEV_LOGIN_WINDOW_TITLE,
          width: 1_080,
          height: 780,
          show: true,
          modal: false,
          ...(Option.isSome(parent) ? { parent: parent.value } : {}),
          webPreferences: {
            partition: CtoxElectronSessions.CTOX_CONTROL_PLANE_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        })
        .pipe(
          Effect.mapError(
            () => new CtoxDevAuthOperationError({ operation: "create-login-window" }),
          ),
        );

      const loginUrl = `${baseUrl}/dashboard?desktop=1&client=${DESKTOP_CLIENT}`;
      return yield* Effect.tryPromise({
        try: () =>
          new Promise<CtoxDevLoginResult>((resolve, reject) => {
            let settled = false;
            let polling = false;
            let latestDiscovery: CtoxManagedDiscoveryResult | undefined;
            let pollFiber: Fiber.Fiber<unknown, unknown> | undefined;
            let timeoutFiber: Fiber.Fiber<unknown, unknown> | undefined;
            const webContents = loginWindow.webContents;

            const cleanup = (): void => {
              if (pollFiber !== undefined) runFork(Fiber.interrupt(pollFiber));
              if (timeoutFiber !== undefined) runFork(Fiber.interrupt(timeoutFiber));
              pollFiber = undefined;
              timeoutFiber = undefined;
              loginWindow.off("closed", onClosed);
              loginWindow.off("page-title-updated", onPageTitleUpdated);
              webContents.off("will-navigate", onWillNavigate);
              webContents.off("did-navigate", onDidNavigate);
              webContents.off("did-navigate-in-page", onDidNavigate);
              webContents.off("did-fail-load", onDidFailLoad as never);
              webContents.setWindowOpenHandler(() => ({ action: "deny" }));
            };

            const finish = (result: CtoxDevLoginResult, close: boolean): void => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(result);
              if (close) closeWindow(loginWindow);
            };

            const fail = (): void => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new CtoxDevAuthOperationError({ operation: "load-login-window" }));
              closeWindow(loginWindow);
            };

            const checkCompletion = (url: unknown): void => {
              if (!isLoginCompletionUrl(url, accountUrl.origin)) return;
              finish(
                {
                  _tag: "completed",
                  via: "url",
                  ...(latestDiscovery === undefined ? {} : { discovery: latestDiscovery }),
                },
                true,
              );
            };

            // Der Seitentitel von ctox.dev (englisch) überschreibt sonst den Fenstertitel.
            const onPageTitleUpdated = (event: { preventDefault: () => void }): void => {
              event.preventDefault();
            };
            const onClosed = (): void => {
              finish({ _tag: "not_completed", reason: "closed" }, false);
            };
            const onWillNavigate = (event: { preventDefault: () => void }, url: string): void => {
              if (safeWebUrl(url) === undefined) event.preventDefault();
              else checkCompletion(url);
            };
            const onDidNavigate = (_event: unknown, url: string): void => {
              checkCompletion(url);
            };
            const onDidFailLoad = (
              _event: unknown,
              errorCode: number,
              _errorDescription: string,
              _validatedUrl: string,
              isMainFrame: boolean,
            ): void => {
              if (isMainFrame && errorCode !== -3) fail();
            };

            const poll = (): void => {
              if (settled || polling) return;
              polling = true;
              void runPromise(refresh)
                .then(
                  (discovery) => {
                    latestDiscovery = discovery;
                    if (discovery._tag === "ready") {
                      finish({ _tag: "completed", via: "refresh", discovery }, true);
                    }
                  },
                  () => undefined,
                )
                .finally(() => {
                  polling = false;
                });
            };

            loginWindow.on("closed", onClosed);
            loginWindow.on("page-title-updated", onPageTitleUpdated);
            webContents.on("will-navigate", onWillNavigate);
            webContents.on("did-navigate", onDidNavigate);
            webContents.on("did-navigate-in-page", onDidNavigate);
            webContents.on("did-fail-load", onDidFailLoad as never);
            webContents.setWindowOpenHandler(({ url }) => {
              const safeUrl = safeWebUrl(url);
              if (safeUrl !== undefined) {
                void runPromise(electronShell.openExternal(safeUrl.href));
              }
              return { action: "deny" };
            });

            timeoutFiber = runFork(
              Effect.sleep(Duration.millis(timeoutMs)).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    timeoutFiber = undefined;
                    finish({ _tag: "not_completed", reason: "timeout" }, true);
                  }),
                ),
              ),
            );
            pollFiber = runFork(
              Effect.forever(
                Effect.sleep(Duration.millis(pollIntervalMs)).pipe(
                  Effect.andThen(Effect.sync(poll)),
                ),
              ),
            );

            void loginWindow.loadURL(loginUrl).then(poll, fail);
          }),
        catch: (error) =>
          isCtoxDevAuthOperationError(error)
            ? error
            : new CtoxDevAuthOperationError({ operation: "load-login-window" }),
      });
    }).pipe(Effect.withSpan("CtoxDevAuth.login"));

    let activeLogin: Promise<CtoxDevLoginResult> | undefined;
    const login = Effect.tryPromise({
      try: () => {
        if (activeLogin !== undefined) return activeLogin;
        const current = runPromise(runLogin)
          .then(async (result) => {
            if (result._tag === "completed") deviceDiscovery = undefined;
            if (result._tag === "completed" && device !== undefined) {
              const session = await runPromise(accountSession);
              await device.enroll((url, init) => session.fetch(url, init)).catch(() => undefined);
            }
            return result._tag === "completed"
              ? { ...result, loginId: NodeCrypto.randomUUID() }
              : result;
          })
          .finally(() => {
            if (activeLogin === current) activeLogin = undefined;
          });
        activeLogin = current;
        return current;
      },
      catch: (error) =>
        isCtoxDevAuthOperationError(error)
          ? error
          : new CtoxDevAuthOperationError({ operation: "load-login-window" }),
    });

    return CtoxDevAuth.of({
      refresh,
      login,
      logout,
      deviceStatus: Effect.tryPromise({
        try: async () =>
          device === undefined ? { state: "not_configured" as const } : device.status(),
        catch: () => new CtoxDevAuthOperationError({ operation: "device-key" }),
      }).pipe(
        Effect.orElseSucceed(() => ({
          state: "not_configured" as const,
          notice: "DEVICE_SERVICE_UNAVAILABLE",
        })),
      ),
      resetDevice: Effect.gen(function* () {
        if (device === undefined) return;
        const session = yield* accountSession.pipe(Effect.option);
        if (Option.isSome(session))
          yield* Effect.tryPromise({
            try: () => device.enroll((url, init) => session.value.fetch(url, init), true),
            catch: () => new CtoxDevAuthOperationError({ operation: "device-key" }),
          });
      }).pipe(Effect.orElseSucceed(() => undefined)),
    });
  }).pipe(Effect.withSpan("CtoxDevAuth.make"));

export const layer = (options: CtoxDevAuthOptions = {}) => Layer.effect(CtoxDevAuth, make(options));
