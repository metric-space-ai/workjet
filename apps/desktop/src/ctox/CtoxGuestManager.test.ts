// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxManagedDiscoveryResult, CtoxManagedInstance } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BrowserWindow, Session, WebContentsView } from "electron";
import { expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({ WebContentsView: class {} }));

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as CtoxBusinessOsShell from "./CtoxBusinessOsShell.ts";
import * as CtoxDevAuth from "./CtoxDevAuth.ts";
import * as CtoxElectronSessions from "./CtoxElectronSessions.ts";
import * as CtoxGuestManager from "./CtoxGuestManager.ts";
import * as CtoxInstanceRegistry from "./CtoxInstanceRegistry.ts";
import * as CtoxManagedLaunch from "./CtoxManagedLaunch.ts";

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

const pairedConfig: CtoxBusinessOsShell.CtoxBusinessOsLaunchConfig = {
  transport: "webrtc",
  sync_room: "ctox-business-os:office",
  signaling_urls: ["wss://signal.example.com/room"],
  signaling_room_password: "paired-room-secret",
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
  const views: Array<{
    readonly view: WebContentsView;
    readonly close: ReturnType<typeof vi.fn>;
    readonly loadURL: ReturnType<typeof vi.fn>;
    readonly setBounds: ReturnType<typeof vi.fn>;
    readonly executeJavaScript: ReturnType<typeof vi.fn>;
    readonly finishLoad: () => void;
    readonly refresh: (...args: Array<unknown>) => void;
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
    const close = vi.fn();
    const loadURL = vi.fn(async (_url: string) => undefined);
    const setBounds = vi.fn();
    let refreshHandler: ((event: unknown, ...args: Array<unknown>) => void) | undefined;
    let finishLoadHandler: (() => void) | undefined;
    const executeJavaScript = vi.fn(async () => undefined);
    const webContents = {
      session: browserSession,
      isDestroyed: vi.fn(() => false),
      close,
      loadURL,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "did-finish-load") finishLoadHandler = handler;
      }),
      ipc: {
        on: vi.fn((channel: string, handler: typeof refreshHandler) => {
          assert.equal(channel, CtoxGuestManager.REFRESH_MANAGED_LAUNCH_CHANNEL);
          refreshHandler = handler;
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
      finishLoad: () => finishLoadHandler?.(),
      refresh: (...args) => refreshHandler?.({}, ...args),
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
      Effect.succeed(CtoxInstanceRegistry.mergeCtoxInstanceSources(managed, pairedInstances)),
    importInvite: () => Effect.die("unused"),
    importManualPairing: () => Effect.die("unused"),
    removePairedInstance: () => Effect.die("unused"),
    resolvePairedLaunch,
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
  const launches = CtoxManagedLaunch.CtoxManagedLaunch.of({ launch });
  const shellLaunch = vi.fn(() =>
    Effect.succeed({
      launchUrl: "http://127.0.0.1:41700/?ctox_config=paired-packed-secret",
      launchOrigin: "http://127.0.0.1:41700",
    }),
  );
  const businessOsShell = CtoxBusinessOsShell.CtoxBusinessOsShell.of({ launch: shellLaunch });
  const electronWindow = ElectronWindow.ElectronWindow.of({
    create: () => Effect.die("unused"),
    main: Effect.succeed(Option.some(mainWindow)),
    currentMainOrFirst: Effect.succeed(Option.some(mainWindow)),
    focusedMainOrFirst: Effect.succeed(Option.some(mainWindow)),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  });
  const electronShell = ElectronShell.ElectronShell.of({
    openExternal: () => Effect.succeed(true),
    copyText: () => Effect.void,
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(CtoxBusinessOsShell.CtoxBusinessOsShell, businessOsShell),
    Layer.succeed(CtoxDevAuth.CtoxDevAuth, auth),
    Layer.succeed(CtoxElectronSessions.CtoxElectronSessions, sessions),
    Layer.succeed(CtoxInstanceRegistry.CtoxInstanceRegistry, registry),
    Layer.succeed(CtoxManagedLaunch.CtoxManagedLaunch, launches),
    Layer.succeed(ElectronWindow.ElectronWindow, electronWindow),
    Layer.succeed(ElectronShell.ElectronShell, electronShell),
  );
  const layer = CtoxGuestManager.layer({ createView }).pipe(Layer.provide(dependencies));
  return {
    addChildView,
    beforeRequest,
    browserSession,
    createView,
    instance,
    launch,
    layer,
    removeChildView,
    resolvePairedLaunch,
    shellLaunch,
    setDiscovery: (value: CtoxManagedDiscoveryResult) => {
      discovery = value;
    },
    setPairedInstances: (value: readonly CtoxManagedInstance[]) => {
      pairedInstances = value;
    },
    views,
  };
}

describe("CtoxGuestManager", () => {
  it.effect("authoritatively selects managed instances and owns guest replacement cleanup", () => {
    const harness = makeGuestHarness();
    const firstBounds = { x: 280, y: 44, width: 1_000, height: 700 };
    const secondBounds = { x: 300, y: 44, width: 980, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
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

      const second = yield* manager.activate(descriptor.id, secondBounds);
      assert.deepEqual(second, { _tag: "ready", instanceId: descriptor.id });
      expect(harness.views[0]?.close).toHaveBeenCalledOnce();
      expect(harness.removeChildView).toHaveBeenCalledWith(harness.views[0]?.view);
      assert.deepEqual(harness.views[1]?.setBounds.mock.calls[0]?.[0], secondBounds);

      yield* manager.deactivate;
      expect(harness.views[1]?.close).toHaveBeenCalledOnce();
      expect(harness.removeChildView).toHaveBeenCalledWith(harness.views[1]?.view);
      expect(harness.launch).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("deactivates only an exactly matching active instance", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
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

  it.effect("launches paired guests while ctox.dev is signed out or failed", () => {
    const harness = makeGuestHarness();
    const bounds = { x: 280, y: 44, width: 1_000, height: 700 };
    harness.setPairedInstances([pairedDescriptor]);
    harness.setDiscovery({ _tag: "signed_out" });

    return Effect.gen(function* () {
      const manager = yield* CtoxGuestManager.CtoxGuestManager;
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
