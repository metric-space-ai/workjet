import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSupportBundle from "../support/DesktopSupportBundle.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const APP_NAME = "Workjet";

const makeElectronAppLayer = (aboutPanelShown: Deferred.Deferred<true>) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed(APP_NAME),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    showAboutPanel: Deferred.succeed(aboutPanelShown, true as const).pipe(Effect.asVoid),
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

/**
 * Records what the Help > Create Support Bundle... item actually did: which
 * dialog the user saw, and what landed on the clipboard.
 */
interface SupportProbe {
  readonly bundlePath: string;
  readonly dialogShown: Deferred.Deferred<Electron.MessageBoxOptions>;
  readonly pathCopied: Deferred.Deferred<string>;
  /** 0 selects "Copy Path". */
  readonly messageBoxResponse: number;
}

const makeElectronDialogLayer = (probe?: SupportProbe) =>
  Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () => Effect.succeed(Option.none()),
    pickFiles: () => Effect.succeed([]),
    showMessageBox: (options) =>
      (probe === undefined
        ? Effect.void
        : Deferred.succeed(probe.dialogShown, options).pipe(Effect.asVoid)
      ).pipe(
        Effect.as({
          response: probe?.messageBoxResponse ?? 0,
          checkboxChecked: false,
        }),
      ),
    showErrorBox: () => Effect.void,
  } satisfies ElectronDialog.ElectronDialog["Service"]);

const makeElectronShellLayer = (probe?: SupportProbe) =>
  Layer.succeed(ElectronShell.ElectronShell, {
    openExternal: () => Effect.succeed(false),
    copyText: (text) =>
      probe === undefined
        ? Effect.void
        : Deferred.succeed(probe.pathCopied, text).pipe(Effect.asVoid),
  } satisfies ElectronShell.ElectronShell["Service"]);

const makeSupportBundleLayer = (probe?: SupportProbe) =>
  Layer.succeed(DesktopSupportBundle.DesktopSupportBundle, {
    build: Effect.die("unexpected build"),
    create: Effect.succeed({
      filePath: probe?.bundlePath ?? "/state/support-bundles/bundle.json",
      byteLength: 4096,
      fieldCount: 60,
      redactedFieldCount: 3,
      omittedFieldCount: 2,
      generatedAtIso: "2026-08-20T10:00:00.000Z",
    }),
  } satisfies DesktopSupportBundle.DesktopSupportBundle["Service"]);

const desktopUpdatesLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
  getState: Effect.die("unexpected getState"),
  emitState: Effect.void,
  disabledReason: Effect.succeed(Option.none()),
  configure: Effect.void,
  setChannel: () => Effect.die("unexpected setChannel"),
  check: () => Effect.die("unexpected check"),
  download: Effect.die("unexpected download"),
  install: Effect.die("unexpected install"),
} satisfies DesktopUpdates.DesktopUpdates["Service"]);

const makeDesktopWindowLayer = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    zoomMain: (direction) =>
      Deferred.succeed(selectedAction, `zoom-${direction}`).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

const makeElectronMenuLayer = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeed(Option.none()),
  } satisfies ElectronMenu.ElectronMenu["Service"]);

const configureMenu = (
  selectedAction: Deferred.Deferred<string>,
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
  aboutPanelShown: Deferred.Deferred<true>,
  probe?: SupportProbe,
) =>
  Effect.gen(function* () {
    const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    yield* menu.configure;
  }).pipe(
    Effect.provide(
      DesktopApplicationMenu.layer.pipe(
        Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
        Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
        Layer.provideMerge(desktopUpdatesLayer),
        Layer.provideMerge(makeElectronDialogLayer(probe)),
        Layer.provideMerge(makeElectronShellLayer(probe)),
        Layer.provideMerge(makeSupportBundleLayer(probe)),
        Layer.provideMerge(makeElectronAppLayer(aboutPanelShown)),
        Layer.provideMerge(
          DesktopEnvironment.layer(environmentInput).pipe(
            Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
          ),
        ),
      ),
    ),
  );

describe("DesktopApplicationMenu", () => {
  it.effect("installs the native menu and routes Settings through DesktopWindow", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const aboutPanelShown = yield* Deferred.make<true>();

      yield* configureMenu(selectedAction, applicationMenuTemplate, aboutPanelShown);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      const settingsItem = fileMenu.submenu.find((item) => item.label === "Settings...");
      assert.isDefined(settingsItem);
      const settingsClick = settingsItem.click;
      if (typeof settingsClick !== "function") {
        throw new Error("Expected Settings menu item to have a click handler.");
      }

      settingsClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "open-settings");
    }),
  );

  // Zoom must route through DesktopWindow.zoomMain instead of the Electron
  // zoom roles: the roles zoom whichever webContents has focus, which breaks
  // app zoom while an embedded preview WebContentsView holds focus.
  it.effect("routes View menu zoom to the main window instead of zoom roles", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const aboutPanelShown = yield* Deferred.make<true>();

      yield* configureMenu(selectedAction, applicationMenuTemplate, aboutPanelShown);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }

      assert.isUndefined(
        viewMenu.submenu.find((item) => item.role?.toLowerCase().includes("zoom")),
      );

      const zoomIn = viewMenu.submenu.find((item) => item.label === "Zoom In");
      assert.isDefined(zoomIn);
      assert.equal(zoomIn.accelerator, "CmdOrCtrl+=");
      if (typeof zoomIn.click !== "function") {
        throw new Error("Expected Zoom In menu item to have a click handler.");
      }

      zoomIn.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "zoom-in");
    }),
  );

  // macOS shows About through the { role: "about" } app-menu item, which only
  // exists in the darwin branch. Windows and Linux have no app menu, so
  // without this Help entry the packaged build has no way to reach the native
  // About panel that carries the CTOX name, version, and commit hash.
  it.effect("offers About in the Help menu on non-darwin platforms", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const aboutPanelShown = yield* Deferred.make<true>();

      yield* configureMenu(selectedAction, applicationMenuTemplate, aboutPanelShown);

      const template = yield* Deferred.await(applicationMenuTemplate);
      assert.isUndefined(template.find((item) => item.label === APP_NAME));

      const helpMenu = template.find((item) => item.role === "help");
      assert.isDefined(helpMenu);
      if (!Array.isArray(helpMenu.submenu)) {
        throw new Error("Expected Help menu submenu to be an array.");
      }

      const aboutItem = helpMenu.submenu.find((item) => item.label === `About ${APP_NAME}`);
      assert.isDefined(aboutItem);
      if (typeof aboutItem.click !== "function") {
        throw new Error("Expected About menu item to have a click handler.");
      }

      aboutItem.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.isTrue(yield* Deferred.await(aboutPanelShown));
    }),
  );

  // Reachability. A support bundle nobody can produce is not a feature, and a
  // bundle whose path is not shown cannot be inspected before it is shared.
  it.effect("creates a support bundle from Help and reports its exact path", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const aboutPanelShown = yield* Deferred.make<true>();
      const probe: SupportProbe = {
        bundlePath: "/state/support-bundles/ctox-support-bundle-20260820T100000000Z.json",
        dialogShown: yield* Deferred.make<Electron.MessageBoxOptions>(),
        pathCopied: yield* Deferred.make<string>(),
        messageBoxResponse: 0,
      };

      yield* configureMenu(selectedAction, applicationMenuTemplate, aboutPanelShown, probe);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const helpMenu = template.find((item) => item.role === "help");
      assert.isDefined(helpMenu);
      if (!Array.isArray(helpMenu.submenu)) {
        throw new Error("Expected Help menu submenu to be an array.");
      }

      const bundleItem = helpMenu.submenu.find((item) => item.label === "Create Support Bundle...");
      assert.isDefined(bundleItem);
      if (typeof bundleItem.click !== "function") {
        throw new Error("Expected the support bundle menu item to have a click handler.");
      }

      bundleItem.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);

      const dialog = yield* Deferred.await(probe.dialogShown);
      assert.include(dialog.detail ?? "", probe.bundlePath);
      assert.include(dialog.message ?? "", "Nothing was uploaded");
      assert.strictEqual(yield* Deferred.await(probe.pathCopied), probe.bundlePath);
    }),
  );
});
