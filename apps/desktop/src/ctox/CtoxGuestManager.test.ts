// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxManagedDiscoveryResult, CtoxManagedInstance } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BrowserWindow, Session, WebContentsView } from "electron";
import { expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({ WebContentsView: class {} }));

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { CTOX_GUEST_STATE_CHANNEL, CTOX_SESSION_TRANSFER_EVENT_CHANNEL } from "../ipc/channels.ts";
import * as CtoxBusinessOsShell from "./CtoxBusinessOsShell.ts";
import * as CtoxDevAuth from "./CtoxDevAuth.ts";
import * as CtoxElectronSessions from "./CtoxElectronSessions.ts";
import * as CtoxGuestManager from "./CtoxGuestManager.ts";
import * as CtoxInstanceRegistry from "./CtoxInstanceRegistry.ts";
import * as CtoxLocalDaemonLaunch from "./CtoxLocalDaemonLaunch.ts";
import * as CtoxManagedLaunch from "./CtoxManagedLaunch.ts";
import * as CtoxSshManagedLaunch from "./CtoxSshManagedLaunch.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const descriptor: CtoxManagedInstance = {
  id: "managed:tenant_skf",
  source: "ctox_dev",
  displayName: "SKF",
  status: "available",
  domain: "skf.ctox.dev",
  role: "owner",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: true,
    httpDataProxy: false,
    nativePeerObserved: true,
  },
};

const pairedDescriptor: CtoxManagedInstance = {
  id: "paired:manual_pairing:abcdefghijklmnopqrstuv",
  source: "manual_pairing",
  displayName: "Paired Office",
  status: "paired",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: false,
    httpDataProxy: false,
    nativePeerObserved: false,
  },
};

const localDescriptor: CtoxManagedInstance = {
  id: "local:AAAAAAAAAAAAAAAAAAAAAA",
  source: "local_daemon",
  displayName: "workstation (local)",
  status: "available",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: false,
    httpDataProxy: false,
    nativePeerObserved: false,
  },
};

const sshDescriptor: CtoxManagedInstance = {
  id: "ssh:AAAAAAAAAAAAAAAAAAAAAA",
  source: "ssh_managed",
  displayName: "Build Box",
  status: "available",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: false,
    httpDataProxy: false,
    nativePeerObserved: false,
  },
};

/** Already rewritten onto the forwarded local port by the launch service. */
const sshConfig: CtoxBusinessOsShell.CtoxBusinessOsLaunchConfig = {
  transport: "webrtc",
  sync_room: "ctox-business-os:buildbox",
  signaling_urls: ["ws://127.0.0.1:52001/signal"],
  signaling_auth_version: "ctox-role-bound-v1",
  signaling_browser_token: "ssh-browser-token",
  signaling_browser_token_hash: "496d86c57e7e4197a59b97b197dda465eeac31f69a2d5d84d944a42ddd919787",
  signaling_native_token_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  http_bridge_available: false,
  desktop_instance: {
    id: sshDescriptor.id,
    source: "ssh_managed",
    display_name: sshDescriptor.displayName,
    domain: "",
  },
};

const localConfig: CtoxBusinessOsShell.CtoxBusinessOsLaunchConfig = {
  transport: "webrtc",
  sync_room: "ctox-business-os:workstation",
  signaling_urls: ["ws://127.0.0.1:4444/signal"],
  signaling_auth_version: "ctox-role-bound-v1",
  signaling_browser_token: "local-browser-token",
  signaling_browser_token_hash: "a649e15b61ba3bc2a444f0286a393cb570d0171e174c83c963d8d729c341884f",
  signaling_native_token_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  http_bridge_available: false,
  desktop_instance: {
    id: localDescriptor.id,
    source: "local_daemon",
    display_name: localDescriptor.displayName,
    domain: "",
  },
};

const pairedConfig: CtoxBusinessOsShell.CtoxBusinessOsLaunchConfig = {
  transport: "webrtc",
  sync_room: "ctox-business-os:office",
  signaling_urls: ["wss://signal.example.com/room"],
  signaling_auth_version: "ctox-role-bound-v1",
  signaling_browser_token: "paired-browser-token",
  signaling_browser_token_hash: "6cf182be93b7728813112387c9e40f13bee8e057fded03f47eedc2de1d562d5d",
  signaling_native_token_hash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  http_bridge_available: false,
  desktop_instance: {
    id: pairedDescriptor.id,
    source: "manual_pairing",
    display_name: pairedDescriptor.displayName,
    domain: "",
  },
};

function makeGuestHarness() {
  const beforeRequest = vi.fn();
  const browserSession = {
    webRequest: { onBeforeRequest: beforeRequest },
  } as unknown as Session;
  const addChildView = vi.fn();
  const removeChildView = vi.fn();
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    contentView: { addChildView, removeChildView },
  } as unknown as BrowserWindow;
  type EventHandler = (...args: Array<unknown>) => void;
  let loadURLImplementation: (
    url: string,
    emit: (event: string, ...args: Array<unknown>) => void,
  ) => Promise<void> = async (url, emit) => {
    queueMicrotask(() => emit("did-frame-navigate", {}, url, 200, "OK", true, 1, 1));
  };
  const views: Array<{
    readonly view: WebContentsView;
    readonly close: ReturnType<typeof vi.fn>;
    readonly loadURL: ReturnType<typeof vi.fn>;
    readonly setBounds: ReturnType<typeof vi.fn>;
    readonly executeJavaScript: ReturnType<typeof vi.fn>;
    readonly destroy: () => void;
    readonly emit: (event: string, ...args: Array<unknown>) => void;
    readonly finishLoad: () => void;
    readonly listenerCount: (event: string) => number;
    readonly refresh: (...args: Array<unknown>) => void;
    readonly postSessionTransferEvent: (...args: Array<unknown>) => void;
    readonly openWindow: (url: string) => { readonly action: string };
    readonly willNavigate: (url: string) => boolean;
  }> = [];
  const createView = vi.fn((webPreferences: CtoxGuestManager.CtoxGuestWebPreferences) => {
    assert.deepEqual(webPreferences, {
      session: browserSession,
      preload: webPreferences.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    assert.match(webPreferences.preload, /ctox-guest-preload\.cjs$/);
    const listeners = new Map<string, Set<EventHandler>>();
    const emit = (event: string, ...args: Array<unknown>): void => {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
    };
    let destroyed = false;
    const close = vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      emit("destroyed");
      listeners.clear();
    });
    const loadURL = vi.fn((url: string) => loadURLImplementation(url, emit));
    const setBounds = vi.fn();
    const ipcHandlers = new Map<string, (event: unknown, ...args: Array<unknown>) => void>();
    const executeJavaScript = vi.fn(async () => undefined);
    const webContents = {
      session: browserSession,
      isDestroyed: vi.fn(() => destroyed),
      close,
      loadURL,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: EventHandler) => {
        const handlers = listeners.get(event) ?? new Set<EventHandler>();
        handlers.add(handler);
        listeners.set(event, handlers);
      }),
      off: vi.fn((event: string, handler: EventHandler) => {
        listeners.get(event)?.delete(handler);
      }),
      ipc: {
        on: vi.fn((channel: string, handler: (event: unknown, ...args: Array<unknown>) => void) => {
          ipcHandlers.set(channel, handler);
        }),
      },
      getURL: vi.fn(() => loadURL.mock.calls.at(-1)?.[0] ?? "about:blank"),
      executeJavaScript,
    };
    const view = { webContents, setBounds } as unknown as WebContentsView;
    views.push({
      view,
      close,
      loadURL,
      setBounds,
      executeJavaScript,
      destroy: () => {
        destroyed = true;
        emit("destroyed");
        listeners.clear();
      },
      emit,
      finishLoad: () => emit("did-finish-load"),
      listenerCount: (event) => listeners.get(event)?.size ?? 0,
      refresh: (...args) =>
        ipcHandlers.get(CtoxGuestManager.REFRESH_MANAGED_LAUNCH_CHANNEL)?.({}, ...args),
      postSessionTransferEvent: (...args) =>
        ipcHandlers.get("ctox-guest:session-transfer-event")?.({}, ...args),
      /** The handler the guest installed, so a test can ask it for a verdict. */
      openWindow: (url: string) => {
        const handler = webContents.setWindowOpenHandler.mock.calls[0]?.[0];
        assert.isFunction(handler);
        return handler({ url }) as { readonly action: string };
      },
      /** Drives `will-navigate` and reports whether the guest blocked it. */
      willNavigate: (url: string) => {
        const preventDefault = vi.fn();
        emit("will-navigate", { preventDefault }, url);
        return preventDefault.mock.calls.length > 0;
      },
    });
    return view;
  });
  let discovery: CtoxManagedDiscoveryResult = {
    _tag: "ready",
    instances: [descriptor],
  };
  const auth = CtoxDevAuth.CtoxDevAuth.of({
    refresh: Effect.suspend(() => Effect.succeed(discovery)),
    login: Effect.die("unused"),
    logout: Effect.void,
  });
  let pairedInstances: readonly CtoxManagedInstance[] = [];
  const resolvePairedLaunch = vi.fn((instanceId: string) => {
    const paired = pairedInstances.find(
      (candidate) =>
        candidate.id === instanceId &&
        candidate.id === pairedDescriptor.id &&
        candidate.source === pairedDescriptor.source &&
        candidate.status === "paired",
    );
    return paired === undefined
      ? Effect.fail(new CtoxInstanceRegistry.CtoxInstanceRegistryError({ code: "not_found" }))
      : Effect.succeed({ descriptor: paired, config: pairedConfig });
  });
  const registry = CtoxInstanceRegistry.CtoxInstanceRegistry.of({
    merge: (managed) =>
      Effect.succeed(
        CtoxInstanceRegistry.mergeCtoxInstanceSources(managed, pairedInstances, [
          ...localInstances,
          ...sshInstances,
        ]),
      ),
    importInvite: () => Effect.die("unused"),
    importManualPairing: () => Effect.die("unused"),
    removePairedInstance: () => Effect.die("unused"),
    addSshManagedInstance: () => Effect.die("unused"),
    removeSshManagedInstance: () => Effect.die("unused"),
    resolvePairedLaunch,
    resolveLocalDaemonTarget: () => Effect.die("unused"),
    resolveSshManagedTarget: () => Effect.die("unused"),
    stableIdentityKey: () => Effect.die("unused"),
    resolveBusinessOsInstanceId: () => Effect.die("unused"),
  });
  let localInstances: readonly CtoxManagedInstance[] = [];
  const resolveLocalLaunch = vi.fn((instanceId: string) => {
    const local = localInstances.find(
      (candidate) => candidate.id === instanceId && candidate.id === localDescriptor.id,
    );
    return local === undefined
      ? Effect.fail(new CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunchError({ reason: "cli_failed" }))
      : Effect.succeed({ descriptor: local, config: localConfig });
  });
  const localDaemonLaunch = CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch.of({
    resolveLaunch: resolveLocalLaunch,
  });
  let sshInstances: readonly CtoxManagedInstance[] = [];
  // Counts the forward teardowns the guest lifecycle triggers.
  const closeForwards = vi.fn(() => Effect.void);
  const resolveSshLaunch = vi.fn((instanceId: string) => {
    const found = sshInstances.find(
      (candidate) => candidate.id === instanceId && candidate.id === sshDescriptor.id,
    );
    return found === undefined
      ? Effect.fail(
          new CtoxSshManagedLaunch.CtoxSshManagedLaunchError({ reason: "invite_unreachable" }),
        )
      : Effect.succeed({
          descriptor: found,
          config: sshConfig,
          closeForwards: Effect.suspend(closeForwards),
        });
  });
  const sshManagedLaunch = CtoxSshManagedLaunch.CtoxSshManagedLaunch.of({
    resolveLaunch: resolveSshLaunch,
  });
  const instance = vi.fn(() => Effect.succeed(browserSession));
  const sessions = CtoxElectronSessions.CtoxElectronSessions.of({
    account: Effect.succeed(browserSession),
    instance,
    clearInstance: () => Effect.void,
  });
  const launch = vi.fn(() =>
    Effect.succeed({
      launchUrl: "https://ctox.dev/business-os/?ctox_config=transient-secret",
      launchOrigin: "https://ctox.dev",
    }),
  );
  const launches = CtoxManagedLaunch.CtoxManagedLaunch.of({
    launch,
    resolveBusinessOsInstanceId: () => Effect.die("unused"),
  });
  const shellLaunch = vi.fn(
    (): Effect.Effect<
      CtoxBusinessOsShell.CtoxBusinessOsLaunch,
      CtoxBusinessOsShell.CtoxBusinessOsShellError
    > =>
      Effect.succeed({
        launchUrl: "http://127.0.0.1:41700/?ctox_config=paired-packed-secret",
        launchOrigin: "http://127.0.0.1:41700",
      }),
  );
  const businessOsShell = CtoxBusinessOsShell.CtoxBusinessOsShell.of({ launch: shellLaunch });
  const sendAll = vi.fn((_channel: string, ..._args: readonly unknown[]) => Effect.void);
  const electronWindow = ElectronWindow.ElectronWindow.of({
    create: () => Effect.die("unused"),
    main: Effect.succeed(Option.some(mainWindow)),
    currentMainOrFirst: Effect.succeed(Option.some(mainWindow)),
    focusedMainOrFirst: Effect.succeed(Option.some(mainWindow)),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll,
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  });
  const openExternal = vi.fn((_rawUrl: unknown) => Effect.succeed(true));
  const electronShell = ElectronShell.ElectronShell.of({
    openExternal,
    copyText: () => Effect.void,
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(CtoxBusinessOsShell.CtoxBusinessOsShell, businessOsShell),
    Layer.succeed(CtoxDevAuth.CtoxDevAuth, auth),
    Layer.succeed(CtoxElectronSessions.CtoxElectronSessions, sessions),
    Layer.succeed(CtoxInstanceRegistry.CtoxInstanceRegistry, registry),
    Layer.succeed(CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch, localDaemonLaunch),
    Layer.succeed(CtoxSshManagedLaunch.CtoxSshManagedLaunch, sshManagedLaunch),
    Layer.succeed(CtoxManagedLaunch.CtoxManagedLaunch, launches),
    Layer.succeed(ElectronWindow.ElectronWindow, electronWindow),
    Layer.succeed(ElectronShell.ElectronShell, electronShell),
  );
  const layer = CtoxGuestManager.layer({ createView }).pipe(Layer.provide(dependencies));
  /** [instanceId, state] pairs of every guest-state event, in emission order. */
  const guestStateEvents = () =>
    sendAll.mock.calls
      .filter(([channel]) => channel === CTOX_GUEST_STATE_CHANNEL)
      .map(([, payload]) => {
        const event = payload as { readonly instanceId: string; readonly state: string };
        return [event.instanceId, event.state] as const;
      });
  return {
    addChildView,
    beforeRequest,
    browserSession,
    createView,
    guestStateEvents,
    instance,
    launch,
    layer,
    openExternal,
    removeChildView,
    sendAll,
    closeForwards,
    resolveLocalLaunch,
    resolvePairedLaunch,
    resolveSshLaunch,
    shellLaunch,
    setDiscovery: (value: CtoxManagedDiscoveryResult) => {
      discovery = value;
    },
    setLoadURLImplementation: (
      implementation: (
        url: string,
        emit: (event: string, ...args: Array<unknown>) => void,
      ) => Promise<void>,
    ) => {
      loadURLImplementation = implementation;
    },
    setLocalInstances: (value: readonly CtoxManagedInstance[]) => {
      localInstances = value;
    },
    setSshInstances: (value: readonly CtoxManagedInstance[]) => {
      sshInstances = value;
    },
    setPairedInstances: (value: readonly CtoxManagedInstance[]) => {
      pairedInstances = value;
    },
    views,
  };
}

describe("child views on a host window", () => {
  it.effect("this file is the only place in the app that adds one", () =>
    Effect.gen(function* () {
      // DesktopWindow.zoomMain detects a mounted CTOX guest by looking for a
      // child view on the window rather than depending on this whole service
      // graph. That shortcut is only sound while this file is the sole caller
      // of addChildView, so pin it: a second caller must either be excluded
      // there, or make zoom targeting explicit instead of inferred.
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.resolve(import.meta.dirname, "..");

      const callers: string[] = [];
      const walk = (directory: string): Effect.Effect<void, never, never> =>
        Effect.gen(function* () {
          const entries = yield* fileSystem
            .readDirectory(directory)
            .pipe(Effect.orElseSucceed((): readonly string[] => []));
          for (const entry of entries) {
            const full = path.join(directory, entry);
            const info = yield* fileSystem.stat(full).pipe(
              Effect.map(Option.some),
              Effect.orElseSucceed(() => Option.none()),
            );
            if (Option.isNone(info)) continue;
            if (info.value.type === "Directory") {
              yield* walk(full);
              continue;
            }
            if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
            const contents = yield* fileSystem
              .readFileString(full)
              .pipe(Effect.orElseSucceed(() => ""));
            if (contents.includes("addChildView(")) callers.push(path.relative(root, full));
          }
        });

      yield* walk(root);
      assert.deepEqual(callers, ["ctox/CtoxGuestManager.ts"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("CtoxGuestManager", () => {
  it.effect(
    "rejects activation outside Business OS mode and keeps the selected guest warm on mode exit",
    () => {
      const harness = makeGuestHarness();
      const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

      return Effect.gen(function* () {
        const manager = yield* CtoxGuestManager.CtoxGuestManager;
        assert.deepEqual(yield* manager.activate(descriptor.id, bounds), {
          _tag: "failed",
          code: "not_active",
        });
        expect(harness.createView).not.toHaveBeenCalled();

        yield* manager.enterBusinessOsMode;
        assert.deepEqual(yield* manager.activate(descriptor.id, bounds), {
          _tag: "ready",
          instanceId: descriptor.id,
        });
        yield* manager.exitBusinessOsMode;
        expect(harness.views[0]?.close).not.toHaveBeenCalled();
        expect(harness.removeChildView).toHaveBeenCalledExactlyOnceWith(harness.views[0]?.view);

        assert.deepEqual(yield* manager.activate(descriptor.id, bounds), {
          _tag: "failed",
          code: "not_active",
        });
        expect(harness.createView).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("pools idempotently without attaching and activation adopts the pooled guest", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      assert.deepEqual(yield* manager.ensurePooled(descriptor.id), {
        _tag: "ready",
        instanceId: descriptor.id,
      });
      assert.deepEqual(yield* manager.ensurePooled(descriptor.id), {
        _tag: "ready",
        instanceId: descriptor.id,
      });
      expect(harness.createView).toHaveBeenCalledOnce();
      expect(harness.launch).toHaveBeenCalledOnce();
      expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce();
      expect(harness.views[0]?.setBounds).not.toHaveBeenCalled();
      expect(harness.addChildView).not.toHaveBeenCalled();
      harness.views[0]?.executeJavaScript.mockResolvedValueOnce({
        status: "completed",
        result: { action: "project.list", projects: [] },
      });
      assert.deepEqual(
        yield* manager.requestProjectControl(descriptor.id, { action: "project.list" }),
        {
          _tag: "completed",
          response: { action: "project.list", projects: [] },
        },
      );

      yield* manager.enterBusinessOsMode;
      assert.deepEqual(yield* manager.activate(descriptor.id, bounds), {
        _tag: "ready",
        instanceId: descriptor.id,
      });
      expect(harness.createView).toHaveBeenCalledOnce();
      expect(harness.launch).toHaveBeenCalledOnce();
      expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce();
      expect(harness.views[0]?.setBounds).toHaveBeenCalledExactlyOnceWith(bounds);
      expect(harness.addChildView).toHaveBeenCalledExactlyOnceWith(harness.views[0]?.view);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("resolves on a valid main-frame commit while loadURL remains pending", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setLoadURLImplementation(() => new Promise(() => undefined));

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      const activation = yield* Effect.forkChild(manager.activate(descriptor.id, bounds));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce()),
      );

      harness.views[0]?.emit(
        "did-frame-navigate",
        {},
        "https://ctox.dev/business-os/",
        200,
        "OK",
        true,
        1,
        1,
      );
      assert.deepEqual(yield* Fiber.join(activation), {
        _tag: "ready",
        instanceId: descriptor.id,
      });
      expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce();
      expect(harness.views[0]?.listenerCount("did-frame-navigate")).toBe(0);
      expect(harness.views[0]?.listenerCount("did-fail-load")).toBe(0);
      expect(harness.views[0]?.listenerCount("destroyed")).toBe(0);
      expect(harness.views[0]?.listenerCount("will-navigate")).toBe(1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not resolve activation from a subframe navigation", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setLoadURLImplementation(() => new Promise(() => undefined));

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      const activation = yield* Effect.forkChild(manager.activate(descriptor.id, bounds));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce()),
      );

      harness.views[0]?.emit(
        "did-frame-navigate",
        {},
        "https://ctox.dev/business-os/embedded",
        200,
        "OK",
        false,
        2,
        2,
      );
      expect(harness.views[0]?.listenerCount("did-frame-navigate")).toBe(1);
      expect(harness.views[0]?.listenerCount("did-fail-load")).toBe(1);

      harness.views[0]?.emit(
        "did-frame-navigate",
        {},
        "https://ctox.dev/business-os/",
        200,
        "OK",
        true,
        1,
        1,
      );
      assert.deepEqual(yield* Fiber.join(activation), {
        _tag: "ready",
        instanceId: descriptor.id,
      });
      expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails and destroys the guest on a main-frame load failure before commit", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setLoadURLImplementation(() => new Promise(() => undefined));

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      const activation = yield* Effect.forkChild(manager.activate(descriptor.id, bounds));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce()),
      );

      harness.views[0]?.emit(
        "did-fail-load",
        {},
        -102,
        "ERR_CONNECTION_REFUSED",
        "https://ctox.dev/business-os/",
        true,
        1,
        1,
      );
      assert.deepEqual(yield* Fiber.join(activation), {
        _tag: "failed",
        code: "guest_failed",
      });
      expect(harness.views[0]?.close).toHaveBeenCalledOnce();
      expect(harness.removeChildView).toHaveBeenCalledExactlyOnceWith(harness.views[0]?.view);
      expect(harness.views[0]?.listenerCount("did-frame-navigate")).toBe(0);
      expect(harness.views[0]?.listenerCount("did-fail-load")).toBe(0);
      expect(harness.views[0]?.listenerCount("destroyed")).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("handles a rejected loadURL before commit without an unhandled rejection", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    const unhandled: Array<unknown> = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    harness.setLoadURLImplementation(() => Promise.reject(new Error("load failed")));

    return Effect.gen(function* () {
      process.on("unhandledRejection", onUnhandled);
      try {
        const manager = yield* CtoxGuestManager.CtoxGuestManager;
        yield* manager.enterBusinessOsMode;
        assert.deepEqual(yield* manager.activate(descriptor.id, bounds), {
          _tag: "failed",
          code: "guest_failed",
        });
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        expect(unhandled).toEqual([]);
        expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce();
        expect(harness.views[0]?.close).toHaveBeenCalledOnce();
        expect(harness.removeChildView).toHaveBeenCalledExactlyOnceWith(harness.views[0]?.view);
        expect(harness.views[0]?.listenerCount("did-frame-navigate")).toBe(0);
        expect(harness.views[0]?.listenerCount("did-fail-load")).toBe(0);
        expect(harness.views[0]?.listenerCount("destroyed")).toBe(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails and cleans up when loadURL throws synchronously", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setLoadURLImplementation(() => {
      throw new Error("load failed");
    });

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      assert.deepEqual(yield* manager.activate(descriptor.id, bounds), {
        _tag: "failed",
        code: "guest_failed",
      });
      expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce();
      expect(harness.views[0]?.close).toHaveBeenCalledOnce();
      expect(harness.removeChildView).toHaveBeenCalledExactlyOnceWith(harness.views[0]?.view);
      expect(harness.views[0]?.listenerCount("did-frame-navigate")).toBe(0);
      expect(harness.views[0]?.listenerCount("did-fail-load")).toBe(0);
      expect(harness.views[0]?.listenerCount("destroyed")).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails activation when the view is destroyed before commit", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setLoadURLImplementation(() => new Promise(() => undefined));

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      const activation = yield* Effect.forkChild(manager.activate(descriptor.id, bounds));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce()),
      );

      harness.views[0]?.destroy();
      assert.deepEqual(yield* Fiber.join(activation), {
        _tag: "failed",
        code: "guest_failed",
      });
      expect(harness.views[0]?.close).not.toHaveBeenCalled();
      expect(harness.removeChildView).toHaveBeenCalledExactlyOnceWith(harness.views[0]?.view);
      expect(harness.views[0]?.listenerCount("did-frame-navigate")).toBe(0);
      expect(harness.views[0]?.listenerCount("did-fail-load")).toBe(0);
      expect(harness.views[0]?.listenerCount("destroyed")).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("interrupts pending activation with deterministic guest and listener cleanup", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setLoadURLImplementation(() => new Promise(() => undefined));

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      const activation = yield* Effect.forkChild(manager.activate(descriptor.id, bounds));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce()),
      );

      yield* Fiber.interrupt(activation);
      expect(harness.views[0]?.close).toHaveBeenCalledOnce();
      expect(harness.removeChildView).toHaveBeenCalledExactlyOnceWith(harness.views[0]?.view);
      expect(harness.views[0]?.listenerCount("did-frame-navigate")).toBe(0);
      expect(harness.views[0]?.listenerCount("did-fail-load")).toBe(0);
      expect(harness.views[0]?.listenerCount("destroyed")).toBe(0);
      expect(harness.views[0]?.listenerCount("will-navigate")).toBe(0);
      assert.deepEqual(yield* manager.setBounds(bounds), {
        _tag: "failed",
        code: "not_active",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("authoritatively selects managed instances and owns guest replacement cleanup", () => {
    const harness = makeGuestHarness();
    const firstBounds = { x: 280, y: 44, width: 1_000, height: 700 };
    const secondBounds = { x: 300, y: 44, width: 980, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      const forged = yield* manager.activate("managed:forged", firstBounds);
      assert.deepEqual(forged, { _tag: "revoked" });
      expect(harness.launch).not.toHaveBeenCalled();

      const first = yield* manager.activate(descriptor.id, firstBounds);
      assert.deepEqual(first, { _tag: "ready", instanceId: descriptor.id });
      assert.strictEqual(harness.createView.mock.calls[0]?.[0].session, harness.browserSession);
      assert.deepEqual(harness.views[0]?.setBounds.mock.calls[0]?.[0], firstBounds);
      expect(harness.addChildView).toHaveBeenCalledWith(harness.views[0]?.view);
      expect(harness.beforeRequest).toHaveBeenCalledOnce();
      expect(harness.views[0]?.loadURL).toHaveBeenCalledWith(
        "https://ctox.dev/business-os/?ctox_config=transient-secret",
      );
      harness.views[0]?.finishLoad();
      expect(harness.views[0]?.executeJavaScript).toHaveBeenCalledOnce();
      assert.notInclude(
        String(harness.views[0]?.executeJavaScript.mock.calls[0]?.[0]),
        "transient-secret",
      );
      assert.notInclude(encodeUnknownJson(first), "transient-secret");

      // Re-activating the already-loaded instance reattaches the warm guest:
      // no teardown, no fresh launch, no second view — only new bounds.
      const second = yield* manager.activate(descriptor.id, secondBounds);
      assert.deepEqual(second, { _tag: "ready", instanceId: descriptor.id });
      expect(harness.views[0]?.close).not.toHaveBeenCalled();
      expect(harness.createView).toHaveBeenCalledOnce();
      expect(harness.launch).toHaveBeenCalledOnce();
      expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce();
      expect(harness.views[0]?.setBounds).toHaveBeenLastCalledWith(secondBounds);

      yield* manager.deactivate;
      expect(harness.views[0]?.close).toHaveBeenCalledOnce();
      expect(harness.removeChildView).toHaveBeenCalledWith(harness.views[0]?.view);
      expect(harness.launch).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("deactivates only an exactly matching active instance", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      yield* manager.activate(descriptor.id, bounds);

      assert.deepEqual(yield* manager.deactivateInstance(pairedDescriptor.id), {
        _tag: "completed",
      });
      expect(harness.views[0]?.close).not.toHaveBeenCalled();
      assert.deepEqual(yield* manager.setBounds({ ...bounds, width: 900 }), {
        _tag: "completed",
      });

      assert.deepEqual(yield* manager.deactivateInstance(descriptor.id), {
        _tag: "completed",
      });
      expect(harness.views[0]?.close).toHaveBeenCalledOnce();
      expect(harness.removeChildView).toHaveBeenCalledExactlyOnceWith(harness.views[0]?.view);
      assert.deepEqual(yield* manager.deactivateInstance(descriptor.id), {
        _tag: "completed",
      });
      expect(harness.views[0]?.close).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a detached guest warm and reattaches it without a reload", () => {
    const harness = makeGuestHarness();
    const second = { ...descriptor, id: "managed:tenant_two", displayName: "Two" };
    harness.setDiscovery({ _tag: "ready", instances: [descriptor, second] });
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    const returnBounds = { ...bounds, width: 908 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      assert.deepEqual(yield* manager.activate(descriptor.id, bounds), {
        _tag: "ready",
        instanceId: descriptor.id,
      });
      assert.deepEqual(yield* manager.activate(second.id, bounds), {
        _tag: "ready",
        instanceId: second.id,
      });
      // The switch detached the first guest without destroying it.
      expect(harness.removeChildView).toHaveBeenCalledExactlyOnceWith(harness.views[0]?.view);
      expect(harness.views[0]?.close).not.toHaveBeenCalled();
      expect(harness.createView).toHaveBeenCalledTimes(2);

      // Switching back is a pure reattach: no view, no launch, no navigation.
      assert.deepEqual(yield* manager.activate(descriptor.id, returnBounds), {
        _tag: "ready",
        instanceId: descriptor.id,
      });
      expect(harness.createView).toHaveBeenCalledTimes(2);
      expect(harness.launch).toHaveBeenCalledTimes(2);
      expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce();
      expect(harness.views[0]?.setBounds).toHaveBeenLastCalledWith(returnBounds);
      expect(harness.addChildView).toHaveBeenLastCalledWith(harness.views[0]?.view);
      expect(harness.views[1]?.close).not.toHaveBeenCalled();

      // Bounds updates land on the re-attached guest again.
      assert.deepEqual(yield* manager.setBounds(bounds), { _tag: "completed" });
      expect(harness.views[0]?.setBounds).toHaveBeenLastCalledWith(bounds);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("suspends the native guest for host overlays and reattaches it warm", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    const returnBounds = { ...bounds, width: 920 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      assert.deepEqual(yield* manager.activate(descriptor.id, bounds), {
        _tag: "ready",
        instanceId: descriptor.id,
      });

      assert.deepEqual(yield* manager.suspend, { _tag: "completed" });
      expect(harness.removeChildView).toHaveBeenCalledExactlyOnceWith(harness.views[0]?.view);
      expect(harness.views[0]?.close).not.toHaveBeenCalled();
      assert.deepEqual(yield* manager.setBounds(returnBounds), {
        _tag: "failed",
        code: "not_active",
      });

      assert.deepEqual(yield* manager.activate(descriptor.id, returnBounds), {
        _tag: "ready",
        instanceId: descriptor.id,
      });
      expect(harness.createView).toHaveBeenCalledOnce();
      expect(harness.launch).toHaveBeenCalledOnce();
      expect(harness.views[0]?.loadURL).toHaveBeenCalledOnce();
      expect(harness.views[0]?.setBounds).toHaveBeenLastCalledWith(returnBounds);
      expect(harness.addChildView).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("evicts the least recently used warm guest through the shared teardown", () => {
    const harness = makeGuestHarness();
    const tenants = ["one", "two", "three", "four", "five"].map((name) => ({
      ...descriptor,
      id: `managed:tenant_${name}`,
      displayName: name,
    }));
    harness.setDiscovery({ _tag: "ready", instances: tenants });
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      assert.equal(CtoxGuestManager.CTOX_GUEST_POOL_LIMIT, 4);
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      for (const tenant of tenants.slice(0, 4)) {
        assert.deepEqual(yield* manager.activate(tenant.id, bounds), {
          _tag: "ready",
          instanceId: tenant.id,
        });
      }
      for (const view of harness.views) expect(view.close).not.toHaveBeenCalled();

      // The fifth cold load evicts exactly the least recently used guest.
      assert.deepEqual(yield* manager.activate(tenants[4]!.id, bounds), {
        _tag: "ready",
        instanceId: tenants[4]!.id,
      });
      expect(harness.views[0]?.close).toHaveBeenCalledOnce();
      for (const view of harness.views.slice(1)) expect(view.close).not.toHaveBeenCalled();

      // The evicted instance is cold again: re-activating creates a new view.
      assert.deepEqual(yield* manager.activate(tenants[0]!.id, bounds), {
        _tag: "ready",
        instanceId: tenants[0]!.id,
      });
      expect(harness.createView).toHaveBeenCalledTimes(6);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("destroys the warm guest of a deactivated instance even while detached", () => {
    const harness = makeGuestHarness();
    const second = { ...descriptor, id: "managed:tenant_two", displayName: "Two" };
    harness.setDiscovery({ _tag: "ready", instances: [descriptor, second] });
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      yield* manager.activate(descriptor.id, bounds);
      yield* manager.activate(second.id, bounds);
      expect(harness.views[0]?.close).not.toHaveBeenCalled();

      // Removal of the detached instance must not leave its guest warm.
      assert.deepEqual(yield* manager.deactivateInstance(descriptor.id), {
        _tag: "completed",
      });
      expect(harness.views[0]?.close).toHaveBeenCalledOnce();
      // The attached instance is untouched and still accepts bounds.
      expect(harness.views[1]?.close).not.toHaveBeenCalled();
      assert.deepEqual(yield* manager.setBounds(bounds), { _tag: "completed" });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("emits identity-only guest state events on every lifecycle transition", () => {
    const harness = makeGuestHarness();
    const second = { ...descriptor, id: "managed:tenant_two", displayName: "Two" };
    harness.setDiscovery({ _tag: "ready", instances: [descriptor, second] });
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      yield* manager.activate(descriptor.id, bounds);
      yield* manager.activate(second.id, bounds);
      // A warm reattach is not a transition and must stay silent.
      yield* manager.activate(descriptor.id, bounds);
      yield* manager.deactivateInstance(second.id);
      yield* manager.deactivate;

      yield* Effect.promise(() =>
        vi.waitFor(() =>
          assert.deepEqual(harness.guestStateEvents(), [
            [descriptor.id, "loading"],
            [descriptor.id, "warm"],
            [second.id, "loading"],
            [second.id, "warm"],
            [second.id, "none"],
            [descriptor.id, "none"],
          ]),
        ),
      );
      // The payload carries identity and state only — never launch material.
      for (const [, payload] of harness.sendAll.mock.calls.filter(
        ([channel]) => channel === CTOX_GUEST_STATE_CHANNEL,
      )) {
        assert.deepEqual(Object.keys(payload as object).toSorted(), ["instanceId", "state"]);
      }
      assert.notInclude(encodeUnknownJson(harness.sendAll.mock.calls), "transient-secret");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails an activation cleanly and reports the guest state as none", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setLoadURLImplementation(() => Promise.reject(new Error("load failed")));

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      assert.deepEqual(yield* manager.activate(descriptor.id, bounds), {
        _tag: "failed",
        code: "guest_failed",
      });
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          assert.deepEqual(harness.guestStateEvents(), [
            [descriptor.id, "loading"],
            [descriptor.id, "none"],
          ]),
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("launches paired guests while ctox.dev is signed out or failed", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setPairedInstances([pairedDescriptor]);
    harness.setDiscovery({ _tag: "signed_out" });

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      const signedOut = yield* manager.activate(pairedDescriptor.id, bounds);
      assert.deepEqual(signedOut, { _tag: "ready", instanceId: pairedDescriptor.id });
      expect(harness.resolvePairedLaunch).toHaveBeenCalledExactlyOnceWith(pairedDescriptor.id);
      expect(harness.shellLaunch).toHaveBeenCalledExactlyOnceWith(pairedConfig);
      expect(harness.launch).not.toHaveBeenCalled();
      expect(harness.instance).toHaveBeenCalledWith(pairedDescriptor);
      expect(harness.views[0]?.loadURL).toHaveBeenCalledExactlyOnceWith(
        "http://127.0.0.1:41700/?ctox_config=paired-packed-secret",
      );
      assert.notInclude(encodeUnknownJson(signedOut), "paired-room-secret");
      assert.notInclude(encodeUnknownJson(signedOut), "paired-packed-secret");
      harness.views[0]?.finishLoad();
      assert.notInclude(
        String(harness.views[0]?.executeJavaScript.mock.calls[0]?.[0]),
        "paired-packed-secret",
      );

      // Release the warm guest so the next activation is a genuine cold
      // launch under the failed managed discovery.
      yield* manager.deactivate;
      harness.setDiscovery({ _tag: "failed", code: "network_error" });
      const failedManagedDiscovery = yield* manager.activate(pairedDescriptor.id, bounds);
      assert.deepEqual(failedManagedDiscovery, {
        _tag: "ready",
        instanceId: pairedDescriptor.id,
      });
      expect(harness.shellLaunch).toHaveBeenCalledTimes(2);
      expect(harness.beforeRequest).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("launches a running local daemon through freshly minted material", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setLocalInstances([localDescriptor]);
    harness.setDiscovery({ _tag: "signed_out" });

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      const activation = yield* manager.activate(localDescriptor.id, bounds);
      assert.deepEqual(activation, { _tag: "ready", instanceId: localDescriptor.id });
      expect(harness.resolveLocalLaunch).toHaveBeenCalledExactlyOnceWith(localDescriptor.id);
      expect(harness.shellLaunch).toHaveBeenCalledExactlyOnceWith(localConfig);
      expect(harness.resolvePairedLaunch).not.toHaveBeenCalled();
      expect(harness.launch).not.toHaveBeenCalled();
      // The isolated partition is derived from the local descriptor itself.
      expect(harness.instance).toHaveBeenCalledWith(localDescriptor);
      assert.notInclude(encodeUnknownJson(activation), "local-room-secret");

      // A cold activation after teardown re-derives the material instead of
      // reusing it; a warm reattach in between never re-mints anything.
      yield* manager.activate(localDescriptor.id, bounds);
      expect(harness.resolveLocalLaunch).toHaveBeenCalledOnce();
      yield* manager.deactivate;
      yield* manager.activate(localDescriptor.id, bounds);
      expect(harness.resolveLocalLaunch).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("forwards sanitized release and lifecycle details to the shell status panel", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    const shellUpdate = {
      activeVersion: "1.2.3",
      desiredVersion: "1.2.4",
      latestCompatibleVersion: "1.2.4",
      channel: "stable" as const,
      phase: "available" as const,
      health: "healthy" as const,
      administrable: true,
      recoveryShell: false,
      lastCheckedAt: "2026-08-26T05:30:00+02:00",
      lastActivatedAt: "2026-08-26T05:00:00+02:00",
      errorCode: null,
      pause: null,
    };
    const instance = { ...localDescriptor, shellUpdate };
    harness.setLocalInstances([instance]);
    harness.setDiscovery({ _tag: "signed_out" });
    harness.shellLaunch.mockImplementation(() =>
      Effect.succeed({
        launchUrl: "http://127.0.0.1:41700/?ctox_config=paired-packed-secret",
        launchOrigin: "http://127.0.0.1:41700",
        shellVersion: "1.2.3",
        recoveryShell: false,
        shellRelease: {
          publishedAt: "2026-08-26T05:29:12+02:00",
          compatibility: {
            workjetMinVersion: "0.0.33",
            workjetMaxVersion: null,
            ctoxMinVersion: "0.3.22",
            ctoxMaxVersion: null,
            shellProtocol: "workjet.business-os-shell.v1",
          },
        },
      }),
    );

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      assert.deepEqual(yield* manager.activate(instance.id, bounds), {
        _tag: "ready",
        instanceId: instance.id,
      });
      expect(harness.shellLaunch).toHaveBeenCalledExactlyOnceWith(localConfig, shellUpdate);

      harness.views[0]?.finishLoad();
      const expression = String(
        harness.views[0]?.executeJavaScript.mock.calls.find(([candidate]) =>
          String(candidate).includes("workjet:shell-update-status"),
        )?.[0],
      );
      assert.include(expression, '"offeredVersion":"1.2.4"');
      assert.include(expression, '"publishedAt":"2026-08-26T05:29:12+02:00"');
      assert.include(expression, '"workjetMinVersion":"0.0.33"');
      assert.include(expression, '"ctoxMinVersion":"0.3.22"');
      assert.include(expression, '"health":"healthy"');
      assert.include(expression, '"administrable":true');
      assert.notInclude(expression, "paired-packed-secret");
      assert.notInclude(expression, "local-room-secret");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("launches a running SSH-managed daemon through forwarded signaling", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setSshInstances([sshDescriptor]);
    harness.setDiscovery({ _tag: "signed_out" });

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      const activation = yield* manager.activate(sshDescriptor.id, bounds);
      assert.deepEqual(activation, { _tag: "ready", instanceId: sshDescriptor.id });
      expect(harness.resolveSshLaunch).toHaveBeenCalledExactlyOnceWith(sshDescriptor.id);
      // The guest receives the rewritten, locally forwarded signaling URLs.
      expect(harness.shellLaunch).toHaveBeenCalledExactlyOnceWith(sshConfig);
      expect(harness.resolveLocalLaunch).not.toHaveBeenCalled();
      expect(harness.resolvePairedLaunch).not.toHaveBeenCalled();
      // The isolated partition is derived from the SSH descriptor itself.
      expect(harness.instance).toHaveBeenCalledWith(sshDescriptor);
      assert.notInclude(encodeUnknownJson(activation), "ssh-room-secret");
      // A live guest keeps its forwards.
      expect(harness.closeForwards).not.toHaveBeenCalled();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("closes the SSH forwards when the guest is torn down", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setSshInstances([sshDescriptor]);
    harness.setDiscovery({ _tag: "signed_out" });

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      yield* manager.activate(sshDescriptor.id, bounds);
      expect(harness.closeForwards).not.toHaveBeenCalled();

      yield* manager.deactivate;
      expect(harness.closeForwards).toHaveBeenCalledTimes(1);

      // Re-activating opens fresh forwards. A mode switch keeps the guest and
      // its peer warm so Code can use the same CTOX instance.
      yield* manager.activate(sshDescriptor.id, bounds);
      expect(harness.closeForwards).toHaveBeenCalledTimes(1);
      yield* manager.exitBusinessOsMode;
      expect(harness.closeForwards).toHaveBeenCalledTimes(1);
      yield* manager.deactivate;
      expect(harness.closeForwards).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails the activation and closes forwards when the SSH launch cannot resolve", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setSshInstances([sshDescriptor]);
    harness.resolveSshLaunch.mockImplementation(() =>
      Effect.fail(new CtoxSshManagedLaunch.CtoxSshManagedLaunchError({ reason: "forward_failed" })),
    );

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      assert.deepEqual(yield* manager.activate(sshDescriptor.id, bounds), {
        _tag: "failed",
        code: "launch_failed",
      });
      expect(harness.shellLaunch).not.toHaveBeenCalled();
      expect(harness.createView).not.toHaveBeenCalled();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("closes the forwards when the guest shell refuses the SSH launch config", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setSshInstances([sshDescriptor]);
    harness.shellLaunch.mockImplementation(() =>
      Effect.fail(new CtoxBusinessOsShell.CtoxBusinessOsShellError()),
    );

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      assert.deepEqual(yield* manager.activate(sshDescriptor.id, bounds), {
        _tag: "failed",
        code: "launch_failed",
      });
      // No half-open state: the tunnels opened for this attempt are gone.
      expect(harness.closeForwards).toHaveBeenCalledTimes(1);
      expect(harness.createView).not.toHaveBeenCalled();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects offline and forged SSH descriptors before any SSH call", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    const offline = { ...sshDescriptor, status: "offline" as const };
    const forged = { ...sshDescriptor, id: "ssh:forged" };
    const proxied: CtoxManagedInstance = {
      ...sshDescriptor,
      id: "ssh:BBBBBBBBBBBBBBBBBBBBBB",
      healthSummary: { ...sshDescriptor.healthSummary, dataPlaneReady: true },
    };
    harness.setSshInstances([offline, forged, proxied]);

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      for (const instanceId of [offline.id, forged.id, proxied.id]) {
        assert.deepEqual(yield* manager.activate(instanceId, bounds), { _tag: "revoked" });
      }
      expect(harness.resolveSshLaunch).not.toHaveBeenCalled();
      expect(harness.createView).not.toHaveBeenCalled();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails the activation when the local daemon cannot mint an invite", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setLocalInstances([localDescriptor]);
    harness.resolveLocalLaunch.mockImplementation(() =>
      Effect.fail(
        new CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunchError({ reason: "cli_unavailable" }),
      ),
    );

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      assert.deepEqual(yield* manager.activate(localDescriptor.id, bounds), {
        _tag: "failed",
        code: "launch_failed",
      });
      expect(harness.shellLaunch).not.toHaveBeenCalled();
      expect(harness.createView).not.toHaveBeenCalled();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects offline and forged local descriptors before any CLI call", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    const offline = { ...localDescriptor, status: "offline" as const };
    const forged = { ...localDescriptor, id: "local:forged" };
    const proxied = {
      ...localDescriptor,
      id: "local:BBBBBBBBBBBBBBBBBBBBBB",
      healthSummary: { ...localDescriptor.healthSummary, dataPlaneReady: true },
    };
    harness.setLocalInstances([offline, forged, proxied]);

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      for (const instanceId of [offline.id, forged.id, proxied.id]) {
        assert.deepEqual(yield* manager.activate(instanceId, bounds), { _tag: "revoked" });
      }
      expect(harness.resolveLocalLaunch).not.toHaveBeenCalled();
      expect(harness.createView).not.toHaveBeenCalled();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects local, SSH, expired, and forged paired descriptors", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    const expired = { ...pairedDescriptor, status: "pairing_expired" as const };
    const forged = {
      ...pairedDescriptor,
      id: "paired:manual_pairing:forged",
    };
    harness.setPairedInstances([expired, forged]);
    harness.setDiscovery({
      _tag: "ready",
      instances: [
        {
          ...descriptor,
          id: "local:office",
          source: "local_daemon",
        },
        {
          ...descriptor,
          id: "ssh:office",
          source: "ssh_managed",
        },
      ],
    });

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      for (const instanceId of ["local:office", "ssh:office", expired.id, forged.id]) {
        assert.deepEqual(yield* manager.activate(instanceId, bounds), { _tag: "revoked" });
      }
      expect(harness.shellLaunch).not.toHaveBeenCalled();
      expect(harness.launch).not.toHaveBeenCalled();
      expect(harness.createView).not.toHaveBeenCalled();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "refreshes only the active guest with one fresh launch in the same session and bounds",
    () => {
      const harness = makeGuestHarness();
      const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

      return Effect.gen(function* () {
        const manager = yield* CtoxGuestManager.CtoxGuestManager;
        yield* manager.enterBusinessOsMode;
        yield* manager.activate(descriptor.id, bounds);

        let resolveLaunch!: (value: { launchUrl: string; launchOrigin: string }) => void;
        const pendingLaunch = new Promise<{ launchUrl: string; launchOrigin: string }>(
          (resolve) => {
            resolveLaunch = resolve;
          },
        );
        harness.launch.mockImplementation(() => Effect.promise(() => pendingLaunch));

        harness.views[0]?.refresh();
        harness.views[0]?.refresh();
        harness.views[0]?.refresh("forged-argument");
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(harness.launch).toHaveBeenCalledTimes(2)),
        );
        expect(harness.createView).toHaveBeenCalledTimes(1);

        resolveLaunch({
          launchUrl: "https://ctox.dev/business-os/?ctox_config=fresh-secret",
          launchOrigin: "https://ctox.dev",
        });
        yield* Effect.promise(() => vi.waitFor(() => expect(harness.views).toHaveLength(2)));

        expect(harness.createView.mock.calls[1]?.[0].session).toBe(harness.browserSession);
        expect(harness.views[0]?.close).toHaveBeenCalledOnce();
        expect(harness.views[1]?.setBounds).toHaveBeenCalledWith(bounds);
        expect(harness.views[1]?.loadURL).toHaveBeenCalledWith(
          "https://ctox.dev/business-os/?ctox_config=fresh-secret",
        );
        expect(harness.launch).toHaveBeenCalledTimes(2);

        harness.views[0]?.refresh();
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        expect(harness.launch).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("fails closed when refreshed entitlement is revoked", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      yield* manager.activate(descriptor.id, bounds);
      harness.setDiscovery({ _tag: "signed_out" });

      harness.views[0]?.refresh();
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(harness.views[0]?.close).toHaveBeenCalledOnce()),
      );

      expect(harness.launch).toHaveBeenCalledOnce();
      expect(harness.createView).toHaveBeenCalledOnce();
      assert.deepEqual(yield* manager.setBounds(bounds), { _tag: "failed", code: "not_active" });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lifts the module category out of the guest and keeps it bounded", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    const control = String.fromCharCode(0);

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      yield* manager.activate(descriptor.id, bounds);
      harness.views[0]?.finishLoad();
      // Evaluate the manager's real list expression against a stub guest app so
      // the category extraction itself is covered, not just its decoding.
      harness.views[0]?.executeJavaScript.mockImplementation(async (expression: unknown) => {
        const source = String(expression);
        if (!source.includes("openModules")) return undefined;
        const holder = globalThis as unknown as { CTOX_BUSINESS_OS_APP?: unknown };
        holder.CTOX_BUSINESS_OS_APP = {
          modules: [
            { id: "tickets", title: "Tickets", category: "  Operations  " },
            { id: "notes", title: "Notes", group: "Knowledge" },
            { id: "plain", title: "Plain" },
            { id: "loud", title: "Loud", category: `Ops${control}Center` },
            { id: "long", title: "Long", category: "c".repeat(200) },
          ],
          activeModule: { id: "tickets" },
        };
        try {
          return new Function(`return ${source}`)() as unknown;
        } finally {
          delete holder.CTOX_BUSINESS_OS_APP;
        }
      });

      const observation = yield* manager.readGuestApps(descriptor.id);
      assert.equal(observation._tag, "completed");
      if (observation._tag !== "completed") return;
      assert.deepEqual(observation.apps, [
        { id: "tickets", title: "Tickets", category: "Operations" },
        { id: "notes", title: "Notes", category: "Knowledge" },
        { id: "plain", title: "Plain" },
        { id: "loud", title: "Loud", category: "OpsCenter" },
        { id: "long", title: "Long", category: "c".repeat(64) },
      ]);
      assert.equal(observation.activeModuleId, "tickets");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("opens the real settings action only in the active Business OS guest", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      assert.deepEqual(yield* manager.openGuestSettings(descriptor.id), {
        _tag: "failed",
        code: "not_active",
      });

      yield* manager.activate(descriptor.id, bounds);
      harness.views[0]?.executeJavaScript.mockImplementation(async (expression: unknown) =>
        String(expression).includes("data-open-settings") ? { ok: true } : undefined,
      );

      assert.deepEqual(yield* manager.openGuestSettings(descriptor.id), { _tag: "completed" });
      const settingsExpression = String(harness.views[0]?.executeJavaScript.mock.calls.at(-1)?.[0]);
      assert.include(settingsExpression, "CTOX_BUSINESS_OS_APP");
      assert.include(settingsExpression, "data-open-settings");
      assert.notInclude(settingsExpression, descriptor.id);

      const callCount = harness.views[0]?.executeJavaScript.mock.calls.length;
      assert.deepEqual(yield* manager.openGuestSettings("managed:other"), {
        _tag: "failed",
        code: "not_active",
      });
      expect(harness.views[0]?.executeJavaScript).toHaveBeenCalledTimes(callCount ?? 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("uses the selected warm guest for device control without a network fallback", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      assert.deepEqual(
        yield* manager.requestDeviceControl(descriptor.id, { action: "binding.list" }),
        { _tag: "failed", code: "not_active" },
      );

      yield* manager.enterBusinessOsMode;
      yield* manager.activate(descriptor.id, bounds);
      yield* manager.exitBusinessOsMode;
      harness.views[0]?.executeJavaScript.mockImplementation(async (expression: unknown) => {
        const source = String(expression);
        if (!source.includes("workjetBusinessOsDeviceControl")) return undefined;
        expect(source).toContain('"action":"binding.list"');
        expect(source).not.toContain("fetch(");
        return {
          status: "completed",
          result: { schema: "ctox.workjet-device-bindings.v1", bindings: [] },
        };
      });

      assert.deepEqual(
        yield* manager.requestDeviceControl(descriptor.id, { action: "binding.list" }),
        {
          _tag: "completed",
          response: { schema: "ctox.workjet-device-bindings.v1", bindings: [] },
        },
      );
      assert.deepEqual(
        yield* manager.requestDeviceControl("managed:other", { action: "binding.list" }),
        { _tag: "failed", code: "not_active" },
      );

      harness.views[0]?.executeJavaScript.mockResolvedValueOnce({ status: "unsupported" });
      assert.deepEqual(
        yield* manager.requestDeviceControl(descriptor.id, { action: "binding.list" }),
        { _tag: "failed", code: "unsupported" },
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("uses only an existing warm guest for project control", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      assert.deepEqual(
        yield* manager.requestProjectControl(descriptor.id, { action: "project.list" }),
        {
          _tag: "failed",
          code: "not_active",
        },
      );
      expect(harness.views).toHaveLength(0);

      yield* manager.enterBusinessOsMode;
      yield* manager.activate(descriptor.id, bounds);
      yield* manager.exitBusinessOsMode;
      harness.views[0]?.executeJavaScript.mockImplementation(async (expression: unknown) => {
        const source = String(expression);
        if (!source.includes("workjetProjectControl")) return undefined;
        expect(source).toContain('"action":"project.list"');
        expect(source).not.toContain("fetch(");
        return { status: "completed", result: { action: "project.list", projects: [] } };
      });

      assert.deepEqual(
        yield* manager.requestProjectControl(descriptor.id, { action: "project.list" }),
        {
          _tag: "completed",
          response: { action: "project.list", projects: [] },
        },
      );
      assert.deepEqual(
        yield* manager.requestProjectControl("managed:other", { action: "project.list" }),
        { _tag: "failed", code: "not_active" },
      );
      expect(harness.views).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("registers transfer sources, forwards valid events, and drops invalid payloads", () => {
    const harness = makeGuestHarness();
    const event = {
      type: "workjet.session.transfer",
      transferId: "transfer-1",
      sessionId: "session-1",
      state: "pause_requested",
      fenceEpoch: 4,
      sourceComputerId: "computer-1",
      targetComputerId: "computer-2",
      deadlineAtMs: 1_788_000_040_000,
      updatedAtMs: 1_788_000_000_000,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.ensurePooled(descriptor.id);
      harness.views[0]?.executeJavaScript.mockImplementationOnce(async (expression: unknown) => {
        const source = String(expression);
        expect(source).toContain("globalThis.workjetSessionEvents");
        expect(source).toContain('"computer-1"');
        return { registered: 1, events: [event] };
      });

      assert.deepEqual(yield* manager.registerSessionTransferEvents(["computer-1"]), {
        _tag: "completed",
      });
      harness.views[0]?.postSessionTransferEvent(event);
      harness.views[0]?.postSessionTransferEvent({ ...event, extra: true });

      const notifications = harness.sendAll.mock.calls
        .filter(([channel]) => channel === CTOX_SESSION_TRANSFER_EVENT_CHANNEL)
        .map(([, payload]) => payload);
      expect(notifications).toEqual([
        { instanceId: descriptor.id, event },
        { instanceId: descriptor.id, event },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("bounds and decodes session control on the selected warm renderer", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      assert.deepEqual(
        yield* manager.requestSessionControl(descriptor.id, { action: "session.list" }),
        { _tag: "failed", code: "not_active" },
      );
      expect(harness.views).toHaveLength(0);

      yield* manager.enterBusinessOsMode;
      yield* manager.activate(descriptor.id, bounds);
      yield* manager.exitBusinessOsMode;
      harness.views[0]?.executeJavaScript.mockImplementationOnce(async (expression: unknown) => {
        const source = String(expression);
        expect(source).toContain("globalThis.workjetSessionControl");
        expect(source).toContain('{"action":"session.list"}');
        expect(source).not.toContain("fetch(");
        return { status: "completed", result: { action: "session.list", sessions: [] } };
      });

      assert.deepEqual(
        yield* manager.requestSessionControl(descriptor.id, { action: "session.list" }),
        {
          _tag: "completed",
          response: { action: "session.list", sessions: [] },
        },
      );

      harness.views[0]?.executeJavaScript.mockResolvedValueOnce({
        status: "completed",
        result: { action: "session.list", sessions: "invalid" },
      });
      assert.deepEqual(
        yield* manager.requestSessionControl(descriptor.id, { action: "session.list" }),
        { _tag: "failed", code: "guest_failed" },
      );

      harness.views[0]?.executeJavaScript.mockResolvedValueOnce({
        status: "completed",
        result: { action: "session.list", sessions: [], padding: "x".repeat(256 * 1_024) },
      });
      assert.deepEqual(
        yield* manager.requestSessionControl(descriptor.id, { action: "session.list" }),
        { _tag: "failed", code: "response_too_large" },
      );
    }).pipe(Effect.provide(harness.layer));
  });

  /**
   * THE NAVIGATION POLICY IS WIRED, NOT MERELY WRITTEN
   * (docs/workjet-plan.md → "Security invariants": "Deny untrusted guest
   * navigation and window creation; open validated external URLs through the
   * OS").
   *
   * The predicate test at the bottom of this file proves
   * `isAllowedCtoxTopFrameNavigation` and `isSafeCtoxExternalUrl` answer
   * correctly. It proves nothing about whether the guest ASKS them: deleting
   * the `setWindowOpenHandler` call or the `will-navigate` listener leaves
   * every predicate assertion green while a guest gains the ability to open
   * popups and navigate itself anywhere. This drives the handlers the guest
   * actually installed.
   */
  it.effect("denies every guest-opened window and routes only safe URLs to the OS", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
      yield* manager.enterBusinessOsMode;
      yield* manager.activate(descriptor.id, bounds);
      const guest = harness.views[0];
      assert.isDefined(guest);

      // 1. WINDOW CREATION IS ALWAYS DENIED — including for the guest's OWN
      //    origin. A popup is never rendered in-app, whatever it points at.
      for (const url of [
        "https://ctox.dev/business-os/popup",
        "https://docs.ctox.dev/help",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "not a url",
      ]) {
        assert.deepEqual(
          guest.openWindow(url),
          { action: "deny" },
          `the guest was allowed to open a window for ${url}`,
        );
      }

      // 2. ONLY THE SAFE ONES REACHED THE OS. `file:` and `javascript:` must
      //    not be handed to the shell — that is the whole point of validating
      //    before delegating.
      assert.deepEqual(
        harness.openExternal.mock.calls.map(([url]) => url),
        ["https://ctox.dev/business-os/popup", "https://docs.ctox.dev/help"],
      );
      harness.openExternal.mockClear();

      // 3. SAME-ORIGIN TOP-FRAME NAVIGATION PROCEEDS, untouched.
      assert.isFalse(
        guest.willNavigate("https://ctox.dev/business-os/deals"),
        "the guest was blocked from navigating inside its own launch origin",
      );
      expect(harness.openExternal).not.toHaveBeenCalled();

      // 4. FOREIGN NAVIGATION IS PREVENTED, and a safe one leaves through the
      //    OS instead of loading in the guest.
      assert.isTrue(
        guest.willNavigate("https://evil.example/steal"),
        "the guest navigated to a foreign origin",
      );
      assert.deepEqual(
        harness.openExternal.mock.calls.map(([url]) => url),
        ["https://evil.example/steal"],
      );
      harness.openExternal.mockClear();

      // 5. A DANGEROUS SCHEME IS PREVENTED AND NOT DELEGATED EITHER.
      for (const url of ["file:///etc/passwd", "javascript:alert(1)"]) {
        assert.isTrue(guest.willNavigate(url), `the guest navigated to ${url}`);
      }
      expect(harness.openExternal).not.toHaveBeenCalled();
    }).pipe(Effect.provide(harness.layer));
  });

  it("allows shell/control resources but blocks Business OS HTTP data routes", () => {
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/business-os/system-apps.json",
        "fetch",
        "https://ctox.dev",
      ),
    ).toBe(false);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/business-os/ctox-shell-manifest.json",
        "fetch",
        "https://ctox.dev",
      ),
    ).toBe(false);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/api/business-os/launch-context",
        "fetch",
        "https://ctox.dev",
      ),
    ).toBe(false);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/api/business-os/status",
        "xhr",
        "https://ctox.dev",
      ),
    ).toBe(false);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/api/business-os/records",
        "xhr",
        "https://ctox.dev",
      ),
    ).toBe(true);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/business-os/rxdb/dist/ctox-rxdb-js.mjs?v=release",
        "script",
        "https://ctox.dev",
      ),
    ).toBe(false);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/business-os/rxdb/src/v1_5_status.mjs",
        "script",
        "https://ctox.dev",
      ),
    ).toBe(false);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/business-os/rxdb/src/protocol-contract.generated.mjs",
        "script",
        "https://ctox.dev",
      ),
    ).toBe(false);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/business-os/rxdb/src/v1_5_status.mjs",
        "xhr",
        "https://ctox.dev",
        "POST",
      ),
    ).toBe(true);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/business-os/rxdb/private",
        "fetch",
        "https://ctox.dev",
      ),
    ).toBe(true);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/business-os/rxdb/src/private.mjs",
        "script",
        "https://ctox.dev",
      ),
    ).toBe(true);
    expect(
      CtoxGuestManager.isForbiddenCtoxDataRequest(
        "https://ctox.dev/files",
        "fetch",
        "https://ctox.dev",
      ),
    ).toBe(true);
    expect(
      CtoxGuestManager.isAllowedCtoxTopFrameNavigation(
        "https://ctox.dev/business-os/",
        "https://ctox.dev",
      ),
    ).toBe(true);
    expect(
      CtoxGuestManager.isAllowedCtoxTopFrameNavigation("https://evil.example/", "https://ctox.dev"),
    ).toBe(false);
    expect(CtoxGuestManager.isSafeCtoxExternalUrl("file:///etc/passwd")).toBe(false);
    expect(CtoxGuestManager.isSafeCtoxExternalUrl("https://docs.ctox.dev/")).toBe(true);
  });
});
