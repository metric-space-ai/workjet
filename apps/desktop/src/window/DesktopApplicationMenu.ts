import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSupportBundle from "../support/DesktopSupportBundle.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedErrorClass<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@workjet/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopSupportBundle.DesktopSupportBundle
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronShell.ElectronShell;

const { logInfo: logUpdaterInfo } = makeComponentLogger("desktop-updater");

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action);
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

/**
 * Menüaktionen, die der Renderer als einzeiligen Toast meldet. Native
 * Dialoge gibt es hier nicht mehr (Owner-Regel: nichts außerhalb der App).
 */
export const DESKTOP_MENU_FEEDBACK = {
  updateUpToDate: "update-up-to-date",
  updateCheckFailed: "update-check-failed",
  updatesUnavailable: "updates-unavailable",
  supportBundleCreated: "support-bundle-created",
  supportBundleFailed: "support-bundle-failed",
} as const;

/** Deutsche Beschriftungen der Menüleiste; Rollen erhalten explizite Labels. */
export const DESKTOP_MENU_LABELS = {
  about: (appName: string) => `Über ${appName}`,
  checkForUpdates: "Nach Updates suchen …",
  settings: "Einstellungen …",
  services: "Dienste",
  hide: (appName: string) => `${appName} ausblenden`,
  hideOthers: "Andere ausblenden",
  unhide: "Alle einblenden",
  quit: (appName: string) => `${appName} beenden`,
  fileDarwin: "Ablage",
  file: "Datei",
  closeWindow: "Fenster schließen",
  edit: "Bearbeiten",
  undo: "Widerrufen",
  redo: "Wiederholen",
  cut: "Ausschneiden",
  copy: "Kopieren",
  paste: "Einsetzen",
  pasteAndMatchStyle: "Einsetzen und Stil anpassen",
  delete: "Löschen",
  selectAll: "Alles auswählen",
  view: "Darstellung",
  reload: "Neu laden",
  forceReload: "Neu laden ohne Cache",
  toggleDevTools: "Entwicklerwerkzeuge",
  actualSize: "Originalgröße",
  zoomIn: "Vergrößern",
  zoomOut: "Verkleinern",
  fullscreen: "Vollbild",
  window: "Fenster",
  minimize: "Im Dock ablegen",
  minimizeOther: "Minimieren",
  zoom: "Zoomen",
  front: "Alle nach vorne bringen",
  help: "Hilfe",
  supportBundle: "Support-Paket erstellen …",
} as const;

const checkForUpdatesFromMenu = Effect.fn("desktop.menu.checkForUpdates")(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* dispatchMenuAction(DESKTOP_MENU_FEEDBACK.updateUpToDate);
  } else if (updateState.status === "error") {
    yield* dispatchMenuAction(DESKTOP_MENU_FEEDBACK.updateCheckFailed);
  }
});

const handleCheckForUpdatesMenuClick = Effect.fn("desktop.menu.handleCheckForUpdatesClick")(
  function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    const disabledReason = yield* updates.disabledReason;
    if (Option.isSome(disabledReason)) {
      yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
        disabledReason: disabledReason.value,
      });
      yield* dispatchMenuAction(DESKTOP_MENU_FEEDBACK.updatesUnavailable);
      return;
    }

    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.ensureMain;
    yield* checkForUpdatesFromMenu();
  },
);

/**
 * Erstellt das Support-Paket aus dem Hilfe-Menü. Der Pfad landet in der
 * Zwischenablage (niemand tippt einen Application-Support-Pfad ab), die App
 * meldet das als einzeiligen Toast. Es wird nichts hochgeladen.
 */
const createSupportBundleFromMenu = Effect.fn("desktop.menu.createSupportBundle")(function* () {
  const supportBundle = yield* DesktopSupportBundle.DesktopSupportBundle;
  const electronShell = yield* ElectronShell.ElectronShell;

  const result = yield* supportBundle.create.pipe(Effect.option);
  if (Option.isNone(result)) {
    yield* dispatchMenuAction(DESKTOP_MENU_FEEDBACK.supportBundleFailed);
    return;
  }

  yield* electronShell.copyText(result.value.filePath);
  yield* dispatchMenuAction(DESKTOP_MENU_FEEDBACK.supportBundleCreated);
});

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    // Read the name here, not at layer construction: DesktopAppIdentity
    // configures the CTOX app name and About panel after this service is
    // acquired, so an early read would label the menu with Electron's default.
    const appName = yield* electronApp.name;
    const isDarwin = environment.platform === "darwin";
    const L = DESKTOP_MENU_LABELS;
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick());
    };
    // macOS gets the About entry from the { role: "about" } app-menu item.
    // Windows and Linux have no app menu, so the Help menu carries it and
    // opens the same native panel, which DesktopAppIdentity.configure has
    // already filled with this build's name, version, and commit hash.
    const showAboutPanelClick = () => {
      runMenuEffect("show-about-panel", electronApp.showAboutPanel);
    };
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    const createSupportBundleClick = () => {
      runMenuEffect("create-support-bundle", createSupportBundleFromMenu());
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) => () => {
      runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
    };
    const settingsItem: Electron.MenuItemConstructorOptions = {
      label: L.settings,
      accelerator: "CmdOrCtrl+,",
      click: settingsClick,
    };
    // Genau ein „Nach Updates suchen“: auf macOS im App-Menü, sonst unter Hilfe.
    const checkForUpdatesItem: Electron.MenuItemConstructorOptions = {
      label: L.checkForUpdates,
      click: checkForUpdatesClick,
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (isDarwin) {
      template.push({
        label: appName,
        submenu: [
          { role: "about", label: L.about(appName) },
          checkForUpdatesItem,
          { type: "separator" },
          settingsItem,
          { type: "separator" },
          { role: "services", label: L.services },
          { type: "separator" },
          { role: "hide", label: L.hide(appName) },
          { role: "hideOthers", label: L.hideOthers },
          { role: "unhide", label: L.unhide },
          { type: "separator" },
          { role: "quit", label: L.quit(appName) },
        ],
      });
    }

    // Neu laden und Entwicklerwerkzeuge nur im Entwicklermodus.
    const developerItems: Electron.MenuItemConstructorOptions[] = environment.isDevelopment
      ? [
          { role: "reload", label: L.reload },
          { role: "forceReload", label: L.forceReload },
          { role: "toggleDevTools", label: L.toggleDevTools },
          { type: "separator" },
        ]
      : [];

    template.push(
      {
        label: isDarwin ? L.fileDarwin : L.file,
        submenu: [
          ...(isDarwin ? [] : [settingsItem, { type: "separator" as const }]),
          isDarwin
            ? { role: "close" as const, label: L.closeWindow }
            : { role: "quit" as const, label: L.quit(appName) },
        ],
      },
      {
        label: L.edit,
        submenu: [
          { role: "undo", label: L.undo },
          { role: "redo", label: L.redo },
          { type: "separator" },
          { role: "cut", label: L.cut },
          { role: "copy", label: L.copy },
          { role: "paste", label: L.paste },
          ...(isDarwin
            ? [{ role: "pasteAndMatchStyle" as const, label: L.pasteAndMatchStyle }]
            : []),
          { role: "delete", label: L.delete },
          { type: "separator" },
          { role: "selectAll", label: L.selectAll },
        ],
      },
      {
        label: L.view,
        submenu: [
          ...developerItems,
          /*
            Not the zoom roles: those act on the focused webContents, so with
            an embedded preview WebContentsView focused they zoom the guest
            page and the app UI appears stuck. These always zoom the main
            window (see DesktopWindow.zoomMain).
          */
          { label: L.actualSize, accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
          { label: L.zoomIn, accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
          {
            label: L.zoomIn,
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
            click: zoomClick("in"),
          },
          { label: L.zoomOut, accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
          { type: "separator" },
          { role: "togglefullscreen", label: L.fullscreen },
        ],
      },
      {
        label: L.window,
        role: "window",
        submenu: [
          { role: "minimize", label: isDarwin ? L.minimize : L.minimizeOther },
          ...(isDarwin
            ? [
                { role: "zoom" as const, label: L.zoom },
                { type: "separator" as const },
                { role: "front" as const, label: L.front },
              ]
            : [{ role: "close" as const, label: L.closeWindow }]),
        ],
      },
      {
        role: "help",
        label: L.help,
        submenu: [
          ...(isDarwin ? [] : [checkForUpdatesItem, { type: "separator" as const }]),
          {
            label: L.supportBundle,
            click: createSupportBundleClick,
          },
          ...(isDarwin
            ? []
            : [
                { type: "separator" as const },
                {
                  label: L.about(appName),
                  click: showAboutPanelClick,
                },
              ]),
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
