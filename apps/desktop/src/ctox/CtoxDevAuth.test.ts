// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeEvents from "node:events";

import type { CtoxManagedDiscoveryResult } from "@workjet/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import type { BrowserWindow, BrowserWindowConstructorOptions, Cookie, Session } from "electron";
import { afterEach, expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as CtoxDevAuth from "./CtoxDevAuth.ts";
import { CtoxControlDevice } from "./CtoxControlDevice.ts";
import { DesktopKeyRecovery } from "../app/DesktopKeyRecovery.ts";
import { makeControlDeviceClient } from "./CtoxControlDeviceClient.ts";
import * as CtoxElectronSessions from "./CtoxElectronSessions.ts";

function response(status: number, payload?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  };
}

function cookie(input: Pick<Cookie, "domain" | "name" | "path" | "secure">): Cookie {
  return { ...input, sameSite: "lax", value: "" };
}

interface FakeLoginWindow {
  readonly window: BrowserWindow;
  readonly loadURL: ReturnType<typeof vi.fn>;
  readonly emitWindow: (event: string, ...args: readonly unknown[]) => void;
  readonly emitWebContents: (event: string, ...args: readonly unknown[]) => void;
  readonly listenerCount: (event: string) => number;
  readonly webContentsListenerCount: (event: string) => number;
  readonly invokePopup: (url: string) => { action: string };
  readonly close: ReturnType<typeof vi.fn>;
}

function makeLoginWindow(): FakeLoginWindow {
  const windowEvents = new NodeEvents.EventEmitter();
  const webContentsEvents = new NodeEvents.EventEmitter();
  let destroyed = false;
  let popupHandler: (details: { url: string }) => { action: string } = () => ({ action: "deny" });
  const loadURL = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => {
    if (destroyed) return;
    destroyed = true;
    windowEvents.emit("closed");
  });
  const webContents = {
    on: vi.fn((event: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsEvents.on(event, listener);
      return webContents;
    }),
    off: vi.fn((event: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsEvents.off(event, listener);
      return webContents;
    }),
    setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
      popupHandler = handler;
    }),
  };
  const window = {
    webContents,
    on: vi.fn((event: string, listener: (...args: readonly unknown[]) => void) => {
      windowEvents.on(event, listener);
      return window;
    }),
    off: vi.fn((event: string, listener: (...args: readonly unknown[]) => void) => {
      windowEvents.off(event, listener);
      return window;
    }),
    close,
    isDestroyed: vi.fn(() => destroyed),
    loadURL,
  } as unknown as BrowserWindow;

  return {
    window,
    loadURL,
    emitWindow: (event, ...args) => windowEvents.emit(event, ...args),
    emitWebContents: (event, ...args) => webContentsEvents.emit(event, ...args),
    listenerCount: (event) => windowEvents.listenerCount(event),
    webContentsListenerCount: (event) => webContentsEvents.listenerCount(event),
    invokePopup: (url) => popupHandler({ url }),
    close,
  };
}

interface HarnessOptions extends CtoxDevAuth.CtoxDevAuthOptions {
  readonly device?: CtoxControlDevice["Service"];
  readonly fetchImpl?: ReturnType<typeof vi.fn>;
  readonly cookies?: readonly Cookie[];
  readonly loadURL?: () => Promise<void>;
  readonly parent?: BrowserWindow;
}

function makeHarness(options: HarnessOptions = {}) {
  const fetchImpl =
    options.fetchImpl ?? vi.fn(async () => response(401, { secret: "body-must-not-be-read" }));
  const removeCookie = vi.fn((_url: string, _name: string) => Promise.resolve());
  const clearStorageData = vi.fn(() => Promise.resolve());
  const cookiesGet = vi.fn(async () => options.cookies ?? []);
  const accountSession = {
    fetch: fetchImpl,
    clearStorageData,
    cookies: { get: cookiesGet, remove: removeCookie },
  } as unknown as Session;
  const instance = vi.fn();
  const clearInstance = vi.fn();
  const sessionsService = CtoxElectronSessions.CtoxElectronSessions.of({
    account: Effect.succeed(accountSession),
    instance,
    clearInstance,
  });

  const created: FakeLoginWindow[] = [];
  const createOptions: BrowserWindowConstructorOptions[] = [];
  const create = vi.fn((windowOptions: BrowserWindowConstructorOptions) => {
    createOptions.push(windowOptions);
    const fakeWindow = makeLoginWindow();
    if (options.loadURL !== undefined) fakeWindow.loadURL.mockImplementation(options.loadURL);
    created.push(fakeWindow);
    return Effect.succeed(fakeWindow.window);
  });
  const parent = options.parent;
  const windowService = ElectronWindow.ElectronWindow.of({
    create,
    main: Effect.succeed(Option.none()),
    currentMainOrFirst: Effect.succeed(parent === undefined ? Option.none() : Option.some(parent)),
    focusedMainOrFirst: Effect.succeed(Option.none()),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  });
  const openExternal = vi.fn(() => Effect.succeed(true));
  const shellService = ElectronShell.ElectronShell.of({
    openExternal,
    copyText: () => Effect.void,
  });

  const dependencies = Layer.mergeAll(
    Layer.succeed(CtoxElectronSessions.CtoxElectronSessions, sessionsService),
    Layer.succeed(ElectronWindow.ElectronWindow, windowService),
    Layer.succeed(ElectronShell.ElectronShell, shellService),
  );
  const layer = CtoxDevAuth.layer({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    loginPollIntervalMs: options.loginPollIntervalMs ?? 50,
    loginTimeoutMs: options.loginTimeoutMs ?? 5_000,
  }).pipe(
    Layer.provide(
      Layer.merge(
        dependencies,
        options.device === undefined
          ? Layer.empty
          : Layer.succeed(CtoxControlDevice, options.device),
      ),
    ),
  );

  return {
    accountSession,
    clearStorageData,
    cookiesGet,
    create,
    created,
    createOptions,
    fetchImpl,
    instance,
    clearInstance,
    layer,
    openExternal,
    removeCookie,
  };
}

function waitForWindow(harness: ReturnType<typeof makeHarness>) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 20 && harness.created.length === 0; attempt += 1) {
      yield* Effect.yieldNow;
    }
    const window = harness.created[0];
    assert.isDefined(window);
    return window;
  });
}

function waitForLoginLoad(window: FakeLoginWindow) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 20 && window.loadURL.mock.calls.length === 0; attempt += 1) {
      yield* Effect.yieldNow;
    }
    assert.strictEqual(window.loadURL.mock.calls.length, 1);
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CtoxDevAuth", () => {
  it.effect("authenticated refresh retries device enrollment without opening login", () => {
    const engine = makeControlDeviceClient({
      baseUrl: "https://ctox.dev",
      read: async () => undefined,
      write: async () => undefined,
      fetch: async () => new Response(),
    });
    const retryEnrollment = vi.fn(async () => {});
    const h = makeHarness({
      device: { ...engine, retryEnrollment },
      fetchImpl: vi.fn(async () =>
        response(200, {
          account: { tenants: [{ id: "fixture", businessName: "Fixture", status: "active" }] },
        }),
      ),
    });
    return Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      assert.equal((yield* auth.refresh)._tag, "ready");
      assert.equal(retryEnrollment.mock.calls.length, 1);
      assert.equal(h.created.length, 0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("enrolls only after an ordinary login completes using the account session", () => {
    const engine = makeControlDeviceClient({
      baseUrl: "https://ctox.dev",
      read: async () => undefined,
      write: async () => undefined,
      fetch: async () => new Response(),
    });
    const enroll = vi.fn(async (cookieFetch: Parameters<typeof engine.enroll>[0]) => {
      await cookieFetch("https://ctox.dev/api/desktop/device-keys", { method: "POST" });
    });
    const h = makeHarness({ device: { ...engine, enroll } });
    return Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const login = yield* Effect.forkChild(auth.login);
      const window = yield* waitForWindow(h);
      yield* waitForLoginLoad(window);
      assert.equal(enroll.mock.calls.length, 0);
      window.emitWebContents("did-navigate", {}, "https://ctox.dev/desktop/auth/complete");
      const completed = yield* Fiber.join(login);
      assert.equal(completed._tag, "completed");
      assert.equal(enroll.mock.calls.length, 1);
      assert.isTrue(
        h.fetchImpl.mock.calls.some(([url]) => url === "https://ctox.dev/api/desktop/device-keys"),
      );
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  });

  it.effect("recovers signed-out managed discovery without opening a login window", () => {
    const device = makeControlDeviceClient({
      baseUrl: "https://ctox.dev",
      read: async () => undefined,
      write: async () => undefined,
      fetch: async () => new Response(),
    });
    const recover = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            account: {
              tenants: [
                {
                  id: "11111111-1111-4111-8111-111111111111",
                  businessName: "Recovered",
                  status: "active",
                },
              ],
            },
          }),
        ),
    );
    let claims = 0;
    const recovery = DesktopKeyRecovery.of({
      inspect: Effect.succeed({
        version: 1,
        generation: "1-11111111-1111-4111-8111-111111111111",
        pendingLogin: false,
        unreadableStores: ["ctox"],
      }),
      completeLogin: Effect.void,
      claimDeviceRecovery: Effect.sync(() => ++claims === 1),
    });
    const h = makeHarness({
      device: {
        ...device,
        recoverOnce: recover,
        status: async () => ({
          state: "active",
          createdAt: "2026-10-11T17:00:00Z",
          lastUsedAt: null,
          expiresAt: "2026-11-10T17:00:00Z",
        }),
      },
    });
    return Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const result = yield* auth.refresh;
      assert.equal(result._tag, "ready");
      assert.equal((yield* auth.refresh)._tag, "ready");
      assert.equal(h.created.length, 0);
      assert.equal(recover.mock.calls.length, 1);
    }).pipe(
      Effect.provide(h.layer.pipe(Layer.provide(Layer.succeed(DesktopKeyRecovery, recovery)))),
    );
  });
  it.effect(
    "refreshes through the account session fetch and preserves redacted discovery states",
    () => {
      const secret = "refresh-secret";
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(response(401, { token: secret }))
        .mockRejectedValueOnce(new Error(secret));
      const harness = makeHarness({ baseUrl: "https://accounts.ctox.dev/", fetchImpl });

      return Effect.gen(function* () {
        const auth = yield* CtoxDevAuth.CtoxDevAuth;
        const signedOut = yield* auth.refresh;
        const failed = yield* auth.refresh;

        assert.deepEqual(signedOut, { _tag: "signed_out" });
        assert.deepEqual(failed, { _tag: "failed", code: "network_error" });
        assert.deepEqual(fetchImpl.mock.calls[0], [
          "https://accounts.ctox.dev/api/desktop/session-package",
          {
            cache: "no-store",
            credentials: "include",
            headers: { "x-ctox-desktop-client": "ctox-business-os-desktop" },
          },
        ]);
        assert.notProperty(signedOut, "message");
        assert.notProperty(failed, "message");
        assert.notInclude(fetchImpl.mock.calls[0]?.[0] as string, secret);
        expect(harness.instance).not.toHaveBeenCalled();
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("logs out only matching account cookie domains and origin storage", () => {
    const cookies = [
      cookie({ domain: ".accounts.ctox.dev", name: "exact", path: "/", secure: true }),
      cookie({ domain: ".ctox.dev", name: "parent", path: "/auth", secure: true }),
      cookie({
        domain: "child.accounts.ctox.dev",
        name: "child",
        path: "/",
        secure: false,
      }),
      cookie({ domain: "other.ctox.dev", name: "sibling", path: "/", secure: true }),
      cookie({ domain: "ctox.dev.evil.example", name: "evil", path: "/", secure: true }),
      cookie({ domain: "dev", name: "public-suffix-like", path: "/", secure: true }),
    ];
    const harness = makeHarness({ baseUrl: "https://accounts.ctox.dev", cookies });

    return Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      yield* auth.logout;

      assert.deepEqual(
        harness.removeCookie.mock.calls.map(([, name]) => name),
        ["exact", "parent", "child"],
      );
      assert.deepEqual(harness.removeCookie.mock.calls, [
        ["https://accounts.ctox.dev/", "exact"],
        ["https://ctox.dev/auth", "parent"],
        ["http://child.accounts.ctox.dev/", "child"],
      ]);
      assert.deepEqual(harness.clearStorageData.mock.calls, [
        [
          {
            origin: "https://accounts.ctox.dev",
            storages: ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"],
          },
        ],
      ]);
      expect(harness.instance).not.toHaveBeenCalled();
      expect(harness.clearInstance).not.toHaveBeenCalled();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("removes only exact-host cookies for loopback development accounts", () => {
    const cookies = [
      cookie({ domain: "localhost", name: "exact", path: "/", secure: false }),
      cookie({ domain: "dev.localhost", name: "subdomain", path: "/", secure: false }),
    ];
    const harness = makeHarness({ baseUrl: "http://localhost:8765", cookies });

    return Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      yield* auth.logout;
      assert.deepEqual(harness.removeCookie.mock.calls, [["http://localhost:8765/", "exact"]]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "creates one secure non-modal account window, enforces navigation policy, and completes only on exact URLs",
    () => {
      const parent = { id: 17 } as BrowserWindow;
      const harness = makeHarness({
        baseUrl: "https://accounts.ctox.dev",
        parent,
        loginPollIntervalMs: 10,
        loginTimeoutMs: 2_000,
      });

      return Effect.gen(function* () {
        const auth = yield* CtoxDevAuth.CtoxDevAuth;
        const loginFiber = yield* Effect.forkChild(auth.login);
        const loginWindow = yield* waitForWindow(harness);
        yield* Effect.promise(flushPromises);

        assert.deepEqual(harness.createOptions, [
          {
            title: "Sign in to CTOX",
            width: 1_080,
            height: 780,
            show: true,
            modal: false,
            parent,
            webPreferences: {
              partition: CtoxElectronSessions.CTOX_CONTROL_PLANE_PARTITION,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          },
        ]);
        assert.deepEqual(loginWindow.loadURL.mock.calls, [
          ["https://accounts.ctox.dev/dashboard?desktop=1&client=ctox-business-os-desktop"],
        ]);

        assert.deepEqual(loginWindow.invokePopup("javascript:alert(1)"), { action: "deny" });
        assert.deepEqual(loginWindow.invokePopup("https://help.ctox.dev/docs?topic=login"), {
          action: "deny",
        });
        yield* Effect.promise(flushPromises);
        assert.deepEqual(harness.openExternal.mock.calls, [
          ["https://help.ctox.dev/docs?topic=login"],
        ]);

        const blocked = { preventDefault: vi.fn() };
        loginWindow.emitWebContents("will-navigate", blocked, "file:///tmp/secret");
        assert.strictEqual(blocked.preventDefault.mock.calls.length, 1);
        const allowed = { preventDefault: vi.fn() };
        loginWindow.emitWebContents("will-navigate", allowed, "https://idp.example/oauth?state=ok");
        assert.strictEqual(allowed.preventDefault.mock.calls.length, 0);

        for (const url of [
          "https://evil.example/desktop/auth/complete",
          "https://accounts.ctox.dev/desktop/auth/complete#fragment",
          "https://accounts.ctox.dev/dashboard?desktop=1&client=ctox-business-os-desktop&auth_completed=1&extra=1",
          "https://accounts.ctox.dev/dashboard?desktop=1&client=wrong&auth_completed=1",
        ]) {
          loginWindow.emitWebContents("did-navigate", {}, url);
          yield* Effect.promise(flushPromises);
          assert.isUndefined(loginFiber.pollUnsafe(), url);
        }

        loginWindow.emitWebContents(
          "did-navigate-in-page",
          {},
          "https://accounts.ctox.dev/dashboard?desktop=1&client=ctox-business-os-desktop&auth_completed=1",
        );
        const completed = yield* Fiber.join(loginFiber);
        assert.equal(completed._tag, "completed");
        if (completed._tag !== "completed") return;
        assert.isString(completed.loginId);
        assert.deepEqual(
          { ...completed, loginId: undefined },
          {
            _tag: "completed",
            via: "url",
            discovery: { _tag: "signed_out" },
            loginId: undefined,
          },
        );
        assert.strictEqual(loginWindow.close.mock.calls.length, 1);
        assert.strictEqual(loginWindow.listenerCount("closed"), 0);
        for (const event of [
          "will-navigate",
          "did-navigate",
          "did-navigate-in-page",
          "did-fail-load",
        ]) {
          assert.strictEqual(loginWindow.webContentsListenerCount(event), 0);
        }
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    },
  );

  it.effect("completes on the exact same-origin desktop auth callback", () => {
    const harness = makeHarness({ baseUrl: "https://accounts.ctox.dev" });
    return Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const loginFiber = yield* Effect.forkChild(auth.login);
      const loginWindow = yield* waitForWindow(harness);
      yield* waitForLoginLoad(loginWindow);
      loginWindow.emitWebContents(
        "did-navigate",
        {},
        "https://accounts.ctox.dev/desktop/auth/complete",
      );

      const result = yield* Fiber.join(loginFiber);
      assert.equal(result._tag, "completed");
      if (result._tag === "completed") assert.equal(result.via, "url");
      assert.strictEqual(loginWindow.listenerCount("closed"), 0);
      assert.strictEqual(loginWindow.webContentsListenerCount("did-navigate"), 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect(
    "uses a single login flight and completes both callers after authenticated refresh",
    () => {
      const ready: CtoxManagedDiscoveryResult = {
        _tag: "ready",
        instances: [],
        sessionVerified: true,
      };
      const fetchImpl = vi.fn(async () => response(200, { account: { tenants: [] } }));
      const harness = makeHarness({ fetchImpl });

      return Effect.gen(function* () {
        const auth = yield* CtoxDevAuth.CtoxDevAuth;
        const first = yield* Effect.forkChild(auth.login);
        const second = yield* Effect.forkChild(auth.login);
        const loginWindow = yield* waitForWindow(harness);

        const firstResult = yield* Fiber.join(first);
        const secondResult = yield* Fiber.join(second);
        assert.equal(firstResult._tag, "completed");
        if (firstResult._tag !== "completed") return;
        assert.isString(firstResult.loginId);
        assert.deepEqual(firstResult, {
          _tag: "completed",
          via: "refresh",
          discovery: ready,
          loginId: firstResult.loginId!,
        });
        assert.deepEqual(secondResult, firstResult);
        assert.strictEqual(harness.create.mock.calls.length, 1);
        assert.strictEqual(loginWindow.listenerCount("closed"), 0);
        assert.strictEqual(loginWindow.webContentsListenerCount("did-fail-load"), 0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    },
  );

  it.effect("returns a typed non-completed result when the user closes the window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const loginFiber = yield* Effect.forkChild(auth.login);
      const loginWindow = yield* waitForWindow(harness);
      loginWindow.emitWindow("closed");

      assert.deepEqual(yield* Fiber.join(loginFiber), {
        _tag: "not_completed",
        reason: "closed",
      });
      assert.strictEqual(loginWindow.listenerCount("closed"), 0);
      assert.strictEqual(loginWindow.webContentsListenerCount("will-navigate"), 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("times out with a non-completed result and clears every timer and listener", () => {
    const harness = makeHarness({ loginPollIntervalMs: 5, loginTimeoutMs: 20 });
    return Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const loginFiber = yield* Effect.forkChild(auth.login);
      const loginWindow = yield* waitForWindow(harness);
      yield* waitForLoginLoad(loginWindow);
      yield* TestClock.adjust(Duration.millis(20));

      assert.deepEqual(yield* Fiber.join(loginFiber), {
        _tag: "not_completed",
        reason: "timeout",
      });
      const fetchCountAfterTimeout = harness.fetchImpl.mock.calls.length;
      yield* TestClock.adjust(Duration.millis(100));
      assert.strictEqual(harness.fetchImpl.mock.calls.length, fetchCountAfterTimeout);
      assert.strictEqual(loginWindow.close.mock.calls.length, 1);
      assert.strictEqual(loginWindow.listenerCount("closed"), 0);
      assert.strictEqual(loginWindow.webContentsListenerCount("did-navigate"), 0);
    }).pipe(
      Effect.provide(harness.layer.pipe(Layer.provideMerge(TestClock.layer()))),
      Effect.scoped,
    );
  });

  it.effect("returns a fixed redacted typed failure for main-frame load errors", () => {
    const secret = "load-failure-secret?token=do-not-leak";
    const harness = makeHarness({
      loadURL: () => new Promise<void>(() => undefined),
    });
    return Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const loginFiber = yield* Effect.forkChild(auth.login);
      const loginWindow = yield* waitForWindow(harness);
      loginWindow.emitWebContents(
        "did-fail-load",
        {},
        -105,
        secret,
        `https://ctox.dev/?${secret}`,
        true,
      );

      const error = yield* Fiber.join(loginFiber).pipe(Effect.flip);
      assert.instanceOf(error, CtoxDevAuth.CtoxDevAuthOperationError);
      assert.equal(error.operation, "load-login-window");
      assert.equal(error.message, "The CTOX account authentication operation failed.");
      assert.deepEqual(
        { _tag: error._tag, operation: error.operation },
        {
          _tag: "CtoxDevAuthOperationError",
          operation: "load-login-window",
        },
      );
      assert.notInclude(error.message, secret);
      assert.strictEqual(loginWindow.listenerCount("closed"), 0);
      assert.strictEqual(loginWindow.webContentsListenerCount("did-fail-load"), 0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("rejects credential-bearing base URLs before acquiring an account session", () => {
    const secret = "base-url-secret";
    const harness = makeHarness({ baseUrl: `https://user:${secret}@ctox.dev` });
    return Effect.scoped(Layer.build(harness.layer)).pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.instanceOf(error, CtoxDevAuth.CtoxDevAuthConfigurationError);
        assert.equal(error.message, "The CTOX account authentication configuration is invalid.");
        assert.notInclude(error.message, secret);
      }),
    );
  });
});
